import type { ServerRun } from './store-types';
import { digestToolArgs } from './store-values';
import {
  RUN_RECOVERY_DB_ENV,
  runRecoveryStore,
  supportsDurableRunRecovery,
  type RunRecoveryKey,
  type RunRecoveryStore,
} from './run-recovery-store';
import { RunRecoveryFault } from './run-recovery-fault';
import type { ServerRunTurnRecoverySink } from './run-recovery-contract';

/**
 * Process-wide cache of recovery sinks, one per live run.
 *
 * The sink carries the run's epoch: every write is fenced on it, so a process
 * that lost ownership cannot advance a run even if it still holds the object.
 * Ownership itself is acquired on `/start` (the only place that grants
 * execution authority) and released when the executor finishes.
 */
interface LiveRecovery {
  readonly key: RunRecoveryKey;
  readonly instanceId: string;
  readonly epoch: number;
  readonly sink: ServerRunTurnRecoverySink;
  readonly ttlMs: number;
  timer: NodeJS.Timeout | null;
}

export interface RunRecoveryRuntime {
  readonly key: RunRecoveryKey;
  readonly epoch: number;
  readonly sink: ServerRunTurnRecoverySink;
}

export const RUN_RECOVERY_OWNER_TTL_MS = 30_000;
export const RUN_RECOVERY_RENEW_MS = 10_000;

const live = new Map<string, LiveRecovery>();

export function runRecoveryKeyOf(run: ServerRun): RunRecoveryKey {
  return {
    projectId: run.projectId,
    sessionGeneration: run.sessionGeneration,
    runId: run.id,
  };
}

function store(): RunRecoveryStore {
  return runRecoveryStore();
}

/**
 * Looks up what the same effective invocation already did, regardless of the
 * model's call id.
 *
 * A resumed model has no memory of the call id it used before the restart, so
 * identifying an operation by call id alone would let an identical write in
 * again. Matching on tool name plus canonical arguments is the server-side
 * identity the design note requires; ambiguous cases still have to stop at the
 * claim/outcome evidence.
 */
export function findPriorRunOperation(
  run: ServerRun,
  input: { readonly name: string; readonly argsDigest: string },
): { readonly opSeq: number; readonly state: 'intent' | 'claimed' | 'outcome'; readonly toolCallId: string } | null {
  const record = live.get(run.id);
  if (!record) return null;
  const checkpoint = store().load(record.key);
  if (!checkpoint) return null;
  const found = store().findOperation(record.key, { ...input, requestIndex: checkpoint.requestIndex });
  if (!found) return null;
  return {
    opSeq: found.opSeq,
    state: found.state,
    toolCallId: found.toolCallId,
  };
}

/**
 * Acquires (or renews) execution authority for an agent run and returns the sink
 * its turn must write through. Returns null when this process may not run the
 * turn: another instance holds a live lease, or the run is already finalized.
 */
export function beginRunRecoveryRuntime(
  run: ServerRun,
  options: {
    readonly instanceId: string;
    readonly ttlMs?: number;
    /** Test seam: pretend the caller's clock has advanced past a dead lease. */
    readonly now?: number;
    readonly expectedRevision?: number;
  } = { instanceId: defaultInstanceId() },
): RunRecoveryRuntime | null {
  const key = runRecoveryKeyOf(run);
  const existing = live.get(run.id);
  if (existing) {
    try { store().assertOwnership(key, existing.epoch); }
    catch { stopRunRecoveryRuntime(run, { release: false }); return null; }
    return { key, epoch: existing.epoch, sink: existing.sink };
  }
  const acquired = store().acquireOwnership(key, {
    instanceId: options.instanceId,
    ttlMs: options.ttlMs ?? RUN_RECOVERY_OWNER_TTL_MS,
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.expectedRevision === undefined ? {} : { expectedRevision: options.expectedRevision }),
  });
  if (acquired.outcome === 'held-elsewhere'
    || acquired.outcome === 'run-finalized'
    || acquired.outcome === 'unknown-run'
    || acquired.outcome === 'revision-stale'
    || acquired.epoch === undefined) {
    return null;
  }
  const epoch = acquired.epoch;
  const record: LiveRecovery = {
    key,
    instanceId: options.instanceId,
    epoch,
    ttlMs: options.ttlMs ?? RUN_RECOVERY_OWNER_TTL_MS,
    timer: null,
    sink: {
      lookupTool: async (input) => store().findOperation(key, {
        ...input, requestIndex: input.requestIndex ?? store().load(key)?.requestIndex,
      }),
      beginRequest: async (input) => {
        try {
          store().beginRequest(key, { epoch, ...input });
        } catch (error) {
          throw new RunRecoveryFault('recovery-write-failed', `Agent request input was not persisted: ${messageOf(error)}`);
        }
      },
      beginTool: async (intent) => {
        // The browser-visible request carries the same args digest the intent
        // recorded, so a claim can be matched to this exact dispatch.
        const argsDigest = intent.argsDigest || digestToolArgs({});
        try {
          const reserved = store().beginTool(key, {
            epoch,
            intent: { ...intent, argsDigest },
          });
          if (reserved.state === 'duplicate') {
            // A resumed turn may re-request an operation intent recorded before
            // the crash. It keeps its original sequence; whether it may run is
            // decided by the claim record, not by this dispatch.
            return { opSeq: reserved.opSeq, duplicate: true };
          }
          return { opSeq: reserved.opSeq };
        } catch (error) {
          throw new RunRecoveryFault('recovery-write-failed', `Agent tool intent was not persisted: ${messageOf(error)}`);
        }
      },
      finishTool: async (outcome) => {
        let written;
        try { written = store().finishTool(key, { epoch, outcome }); }
        catch (error) { throw new RunRecoveryFault('recovery-write-failed', `Tool outcome was not persisted: ${messageOf(error)}`); }
        if (written === 'recorded' || written === 'duplicate') return;
        throw new RunRecoveryFault(
          written === 'epoch-stale' ? 'ownership-lost' : 'outcome-unknown',
          `Agent tool outcome was not recorded (${written}).`,
        );
      },
    },
  };
  live.set(run.id, record);
  record.timer = setInterval(() => {
    try {
      const renewed = store().acquireOwnership(key, {
        instanceId: options.instanceId,
        ttlMs: record.ttlMs,
      });
      if (renewed.outcome === 'renewed' && renewed.epoch === epoch) return;
      throw new RunRecoveryFault('ownership-lost', 'Agent run recovery ownership was taken over.');
    } catch (error) {
      stopRunRecoveryRuntime(run, { release: false });
      const fault = error instanceof RunRecoveryFault ? error
        : new RunRecoveryFault('recovery-write-failed', `Agent ownership renewal failed: ${messageOf(error)}`);
      run.abort?.abort(fault);
    }
  }, RUN_RECOVERY_RENEW_MS);
  record.timer.unref?.();
  return { key, epoch, sink: record.sink };
}

export function stopRunRecoveryRuntime(
  run: ServerRun,
  options: { readonly release?: boolean } = {},
): void {
  const record = live.get(run.id);
  if (!record) return;
  live.delete(run.id);
  if (record.timer) clearInterval(record.timer);
  if (options.release === false) return;
  try {
    store().releaseOwnership(record.key, { instanceId: record.instanceId, epoch: record.epoch });
  } catch { /* The lease expires even when the database cannot record its release. */ }
}

/**
 * Binds a browser claim to the durable intent before the route answers
 * `claimed`. This is the evidence "execution authority was granted": the route
 * must not answer first and record later.
 */
export function claimRunRecoveryTool(
  run: ServerRun,
  input: { readonly toolCallId: string; readonly argsDigest: string; readonly claimId: string },
): ReturnType<RunRecoveryStore['claimTool']> | null {
  const record = live.get(run.id);
  if (!record) return supportsDurableRunRecovery(run.backend) && store().load(runRecoveryKeyOf(run)) ? 'epoch-stale' : null;
  return store().claimTool(record.key, { epoch: record.epoch, ...input });
}

/**
 * Freezes a run whose writes can no longer be proven. The record keeps the
 * phase `needs_reconcile`; nothing is finalized, so the browser can still
 * reconcile or the user can end the task explicitly.
 */
export function markRunRecoveryNeedsReconcile(run: ServerRun, fault?: Error): void {
  const record = live.get(run.id);
  if (!record) return;
  try {
    const claimed = store().load(record.key)?.tools.some((tool) => tool.state === 'claimed');
    const code = fault && 'code' in fault ? String(fault.code) : 'outcome-unknown';
    const reason = code === 'outcome-unknown' && claimed ? 'claimed-outcome-unknown' : code;
    store().pauseAttempt(record.key, fault ?? new Error(reason), record.epoch);
    store().setPhase(record.key, { epoch: record.epoch, phase: 'needs_reconcile', reason });
  } catch {
    // The row is already unreadable; freezing the executor is what matters.
  }
}

/** Pauses one attempt while retaining its checkpoint and logical run identity. */
export function pauseRunRecovery(run: ServerRun, error: unknown): void {
  const record = live.get(run.id);
  // Keep authority until the executor has persisted paused status and its event.
  // Its finally block releases the lease after those writes have finished.
  if (!record) throw new RunRecoveryFault('ownership-lost', 'Agent execution authority is no longer held.');
  store().pauseAttempt(record.key, error, record.epoch);
}

/**
 * Marks the run terminal in the recovery store and drops its replay body.
 *
 * Called only after the transport terminal write completed, so a crash between
 * the two leaves a resumable row rather than a finalized one: the run is then
 * repaired from its sidecar events instead of losing the draft it still needs.
 */
export function finalizeRunRecovery(run: ServerRun): void {
  const record = live.get(run.id);
  try {
    store().finalize(runRecoveryKeyOf(run), Date.now(), record?.epoch);
  } catch {
    // Terminal sidecar evidence repairs cleanup on the next load. A failed
    // cleanup must retain replay data and must not rewrite the business result.
  } finally {
    stopRunRecoveryRuntime(run);
  }
}

export function cancelRunRecovery(run: ServerRun): void {
  stopRunRecoveryRuntime(run);
  store().finalize(runRecoveryKeyOf(run), Date.now(), undefined, true);
}

export function hasLiveRunRecoveryRuntime(run: ServerRun): boolean { return live.has(run.id); }

export function assertRunRecoveryAuthority(run: ServerRun): void {
  const record = live.get(run.id);
  if (!record) throw new RunRecoveryFault('ownership-lost', 'Agent execution authority is no longer held.');
  try { store().assertOwnership(record.key, record.epoch); }
  catch (error) { throw new RunRecoveryFault('ownership-lost', messageOf(error)); }
}

export function recordRunBrowserOutcome(run: ServerRun, input: {
  toolCallId: string; argsDigest: string; claimId: string; result?: unknown; error?: string;
}): ReturnType<RunRecoveryStore['recordBrowserOutcome']> | null {
  const key = runRecoveryKeyOf(run);
  if (!supportsDurableRunRecovery(run.backend) || !store().load(key)) return null;
  return store().recordBrowserOutcome(key, input);
}

/**
 * Retention sweep: finalized rows older than the cutoff are dropped, live runs
 * are never touched, and runs that still await reconciliation are kept until an
 * explicit user decision. A long-idle run is not a failed write.
 */
export function sweepRunRecovery(retentionMs = 7 * 24 * 60 * 60_000, now = Date.now()): number {
  try {
    store().expireAdmissions(now);
    return store().purgeFinalizedBefore(now - retentionMs);
  } catch {
    return 0;
  }
}

export function resetRunRecoveryRuntimeForTest(): void {
  for (const record of live.values()) {
    if (record.timer) clearInterval(record.timer);
  }
  live.clear();
}

/** Rotation and project deletion must not leave resumable rows behind. */
export function purgeRunRecoveryForProject(projectId: string, currentGeneration?: string): number {
  return currentGeneration === undefined
    ? store().purgeProject(projectId)
    : store().purgeOtherGenerations(projectId, currentGeneration);
}

/** Drops every recovery row of a project whose session generation moved on. */
export function purgeRunRecoveryOtherGenerations(projectId: string, generation: string): number {
  try {
    return store().purgeOtherGenerations(projectId, generation);
  } catch {
    return 0;
  }
}

export function runRecoveryEnabled(): boolean {
  // The database is optional infrastructure: a broken or unsupported file must
  // degrade to today's non-resumable behaviour instead of refusing to run the agent.
  try {
    store();
    return true;
  } catch {
    return false;
  }
}

/**
 * Read-only recovery projection for `GET /:runId`.
 *
 * It deliberately does not acquire authority, start a turn or cancel a pending
 * approval: a page load or an SSE reconnect must never change a run's execution
 * state. It only reports what a restarting browser needs to decide its next step.
 */
export interface RunRecoveryProjection {
  readonly state: 'admitted' | 'active' | 'waiting_reconcile' | 'paused' | 'ready' | 'finalized';
  readonly attemptNumber: number;
  readonly lastError: string | null;
  readonly lastContinuationId: string | null;
  readonly revision: number;
  readonly requestIndex: number;
  readonly lastEventId: number;
  readonly tools: readonly {
    readonly toolCallId: string;
    readonly name: string;
    readonly argsDigest: string;
    readonly opSeq: number;
    readonly state: 'intent' | 'claimed' | 'outcome';
    readonly result?: unknown;
    readonly error?: string;
  }[];
}

export function readRunRecoveryProjection(
  key: RunRecoveryKey,
  lastEventId: number,
): RunRecoveryProjection | null {
  let run;
  try {
    run = store().load(key);
  } catch {
    return null;
  }
  if (!run) return null;
  const unresolved = run.tools.some((tool) => tool.state === 'claimed');
  const active = live.has(key.runId) && run.ownerInstance !== null && (run.ownerExpiresAt ?? 0) > Date.now();
  const paused = run.phase === 'paused' || run.attempts.some((attempt) => attempt.attemptNumber === run.attemptNumber && attempt.status === 'paused');
  const state = run.phase === 'finalized' ? 'finalized'
    : run.phase === 'admitted' ? 'admitted'
    : paused ? (unresolved ? 'waiting_reconcile' : 'paused')
    : active && run.phase === 'executing' ? 'active'
    : unresolved || !run.executionInput ? 'waiting_reconcile'
    : run.phase === 'needs_reconcile' && run.reconcileReason !== 'recovery-write-failed'
      && run.reconcileReason !== 'claimed-outcome-unknown' ? 'waiting_reconcile'
    : 'ready';
  return {
    state,
    attemptNumber: run.attemptNumber,
    lastError: run.lastError,
    lastContinuationId: run.lastContinuationId,
    revision: run.revision,
    requestIndex: run.requestIndex,
    lastEventId,
    tools: run.tools.map((tool) => ({
      toolCallId: tool.toolCallId,
      name: tool.name,
      argsDigest: tool.argsDigest,
      opSeq: tool.opSeq,
      state: tool.state,
      ...(tool.state === 'outcome' && tool.result !== undefined ? { result: tool.result } : {}),
      ...(tool.error === undefined ? {} : { error: tool.error }),
    })),
  };
}

export function runRecoveryStorePathForDiagnostics(): string | null {
  return process.env[RUN_RECOVERY_DB_ENV]?.trim() || null;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function defaultInstanceId(): string {
  // One executor per process; the pid plus boot time distinguishes two
  // processes started from the same checkout.
  return `${process.pid}:${Math.round(process.uptime() * 1_000)}`;
}
