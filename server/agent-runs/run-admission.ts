// Admission and ownership handshake for browser-started API/Codex runs.
import { executeRun, type ServerRunInput } from './executor';
import { canonicalServerRunToolCatalog } from './tool-policy';
import { cancelRun, isRunTerminal } from './store';
import type { ServerRun } from './store-types';
import { runRecoveryStore, supportsDurableRunRecovery, type RunAdmissionOutcome } from './run-recovery-store';
import { beginRunRecoveryRuntime, finalizeRunRecovery, hasLiveRunRecoveryRuntime, runRecoveryKeyOf } from './run-recovery-runtime';
const SERVER_RUN_ADMISSION_TIMEOUT_MS = 60_000;
interface DeferredRun {
  readonly input: ServerRunInput;
  /** Absolute deadline persisted with the admission; a retry never extends it. */
  readonly admissionExpiresAt: number;
  readonly timeout: NodeJS.Timeout;
}
const deferredRuns = new Map<string, DeferredRun>();
const startedRuns = new Set<string>();

/**
 * Creates the shared per-run recovery admission for API and Codex. Runs before the create
 * response, after the sidecar identity write, so a crash between the two can be
 * repaired by the identical create retry instead of starting a second executor.
 */
function prepareRecoveryAdmission(
  run: ServerRun,
  admissionExpiresAt: number,
  input: ServerRunInput,
): RunAdmissionOutcome {
  const { origin: _origin, tools, ...executionInput } = input;
  return runRecoveryStore().prepareAdmission({
    projectId: run.projectId,
    sessionGeneration: run.sessionGeneration,
    runId: run.id,
    backend: run.backend,
    model: run.model,
    askOnly: run.askOnly,
    admissionExpiresAt,
    executionInput: { ...executionInput, toolNames: tools.map((tool) => tool.name), references: run.references },
  });
}

export function deferRunExecution(run: ServerRun, input: ServerRunInput): void {
  const admissionExpiresAt = (supportsDurableRunRecovery(run.backend) ? run.createdAt : Date.now()) + SERVER_RUN_ADMISSION_TIMEOUT_MS;
  if (admissionExpiresAt <= Date.now()) throw new Error('agent run admission expired');
  const timeout = setTimeout(() => {
    if (!deferredRuns.delete(run.id)) return;
    void cancelRun(run).then(() => { if (supportsDurableRunRecovery(run.backend)) finalizeRunRecovery(run); }).catch(() => undefined);
  }, admissionExpiresAt - Date.now());
  deferredRuns.set(run.id, { input, admissionExpiresAt, timeout });
  // Every other backend keeps its own execution and recovery rules: API and Codex
  // runs get admission rows, and only an admitted row lets its turn write
  // recovery progress later.
  if (!supportsDurableRunRecovery(run.backend)) return;
  try {
    const outcome = prepareRecoveryAdmission(run, admissionExpiresAt, input);
    if (!isRecoveryAdmitted(outcome)) throw new Error(`Run recovery admission failed: ${outcome}.`);
  } catch (error) {
    deferredRuns.delete(run.id);
    clearTimeout(timeout);
    throw error;
  }
}

function isRecoveryAdmitted(outcome: RunAdmissionOutcome): boolean {
  return outcome === 'admitted' || outcome === 'duplicate';
}

function ensureRecoveryAdmission(run: ServerRun, deferred: DeferredRun): void {
  if (!supportsDurableRunRecovery(run.backend)) return;
  const outcome = prepareRecoveryAdmission(run, deferred.admissionExpiresAt, deferred.input);
  if (!isRecoveryAdmitted(outcome)) {
    // The identical create retry is the repair path for a missing admission; a
    // conflicting identity has already been rejected before this point.
    throw new Error(`Run recovery admission failed: ${outcome}.`);
  }
}

/** Fields a recovery start request may carry; unknown values are ignored. */
interface ResumeStartRequest {
  readonly mode?: 'resume';
  readonly expectedRevision?: number;
  readonly recorderId?: string;
}

export function resumeStartRequest(body: Record<string, unknown>): ResumeStartRequest {
  return {
    ...(body.mode === 'resume' ? { mode: 'resume' as const } : {}),
    ...(Number.isSafeInteger(body.expectedRevision)
      ? { expectedRevision: body.expectedRevision as number }
      : {}),
    ...(typeof body.recorderId === 'string' && body.recorderId.trim()
      ? { recorderId: body.recorderId.trim().slice(0, 128) }
      : {}),
  };
}

type ResumeOutcome =
  | { readonly ok: true; readonly outcome: 'started' | 'already_started' | 'unavailable' }
  | { readonly ok: false; readonly status: 409; readonly reason: string }
  | { readonly ok: false; readonly status: 404; readonly reason: string };

/**
 * Grants execution authority for a recovered subprocess run.
 *
 * Everything this decides is read from the durable record inside one store
 * transaction: a stale `expectedRevision`, a run owned by another live executor,
 * an incomplete reconciliation, or a finalized run each get their own reason
 * instead of a silent restart. The response only claims success after the
 * ownership transaction committed.
 */
export function startResumedRun(run: ServerRun, request: ResumeStartRequest, origin: string, execute = executeRun): ResumeOutcome {
  const key = runRecoveryKeyOf(run);
  const record = runRecoveryStore().load(key);
  if (!record) return { ok: true, outcome: startDeferredRun(run, execute) };
  if (record.phase === 'paused' || record.attempts.at(-1)?.status === 'paused') {
    return { ok: false, status: 409, reason: 'send a new message to continue this paused task' };
  }
  if (record.phase === 'finalized' || isRunTerminal(run)) {
    return { ok: false, status: 409, reason: 'run is already finalized' };
  }
  if (request.expectedRevision !== undefined && request.expectedRevision !== record.revision) {
    return { ok: false, status: 409, reason: 'recovery revision is stale' };
  }
  if (record.ownerInstance && (record.ownerExpiresAt ?? 0) > Date.now()) {
    return hasLiveRunRecoveryRuntime(run)
      ? { ok: true, outcome: 'already_started' }
      : { ok: false, status: 409, reason: 'another executor holds the recovery lease; retry after it expires' };
  }
  if (record.tools.some((tool) => tool.state === 'claimed')) {
    return { ok: false, status: 409, reason: 'run is waiting for tool reconciliation' };
  }
  if (record.phase === 'needs_reconcile' && record.reconcileReason !== 'recovery-write-failed'
    && record.reconcileReason !== 'claimed-outcome-unknown') {
    return { ok: false, status: 409, reason: 'run requires an explicit decision after ambiguous tool evidence' };
  }
  const saved = record.executionInput;
  if (!saved) return { ok: false, status: 409, reason: 'persisted execution input is unavailable; end this task and start a new one' };
  const catalog = canonicalServerRunToolCatalog(run.askOnly);
  const tools = record.completion ? [] : saved.toolNames.map((name) => catalog.find((tool) => tool.name === name));
  if (tools.some((tool) => !tool)) return { ok: false, status: 409, reason: 'persisted tool catalog is unavailable' };
  if (record.phase === 'admitted' && record.admissionExpiresAt <= Date.now()) {
    return { ok: false, status: 409, reason: 'agent run admission expired' };
  }
  const runtime = beginRunRecoveryRuntime(run, {
    instanceId: `resume:${process.pid}:${crypto.randomUUID()}`,
    expectedRevision: record.revision,
  });
  if (!runtime) return { ok: false, status: 409, reason: 'execution authority changed; refresh recovery metadata' };
  discardDeferredRun(run.id);
  const { toolNames: _toolNames, references: _references, ...input } = saved;
  startedRuns.add(run.id);
  void execute(run, { ...input, origin, tools: tools as ServerRunInput['tools'] }, { resume: record })
    .finally(() => startedRuns.delete(run.id));
  return { ok: true, outcome: 'started' };
}

export function startDeferredRun(run: ServerRun, execute = executeRun): 'started' | 'already_started' | 'unavailable' {
  const deferred = deferredRuns.get(run.id);
  if (!deferred) {
    return startedRuns.has(run.id) || run.status !== 'queued'
      ? 'already_started'
      : 'unavailable';
  }
  if (supportsDurableRunRecovery(run.backend) && !beginRunRecoveryRuntime(run)) return 'unavailable';
  deferredRuns.delete(run.id);
  clearTimeout(deferred.timeout);
  startedRuns.add(run.id);
  void execute(run, deferred.input).finally(() => startedRuns.delete(run.id));
  return 'started';
}

export function discardDeferredRun(runId: string): void {
  const deferred = deferredRuns.get(runId);
  if (deferred) clearTimeout(deferred.timeout);
  deferredRuns.delete(runId);
}


export function ensureDeferredRunExecution(run: ServerRun, input: ServerRunInput): void {
  const existing = deferredRuns.get(run.id);
  if (!existing) {
    if (run.status !== 'queued' || startedRuns.has(run.id)) return;
    deferRunExecution(run, input);
    return;
  }
  // A create retry that arrives after a crash between the sidecar write and
  // the admission write completes the missing admission with the original
  // deadline instead of creating a second executor.
  ensureRecoveryAdmission(run, existing);
}


export function hasDeferredRun(runId: string): boolean { return deferredRuns.has(runId); }
