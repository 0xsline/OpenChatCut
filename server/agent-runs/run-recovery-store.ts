import type { ModelMessage } from 'ai';
import { encodeApiRecoveryMessages } from './api-recovery-messages';
import { RunRecoveryAttempts } from './run-recovery-store-attempts';
import {
  supportsDurableRunRecovery, MAX_RUN_RECOVERY_REQUEST_BYTES, MAX_RUN_RECOVERY_RUNS,
  DEFAULT_RUN_OWNER_TTL_MS, RunRecoveryLimitError, toRun,
} from './run-recovery-store-records';
import type {
  RunRecoveryKey, RunRecoveryRun, RunAdmissionInput, RunAdmissionOutcome,
  RunRecoveryPhase, RecoveryRequestOptions, RecoveryCompletion, RunOwnershipOutcome,
  RunToolRecoveryRow, ToolRow,
} from './run-recovery-store-records';

export {
  supportsDurableRunRecovery, RUN_RECOVERY_DB_FILENAME, RUN_RECOVERY_DB_ENV,
  RUN_RECOVERY_SCHEMA_VERSION, MAX_RUN_RECOVERY_RUNS, MAX_RUN_RECOVERY_TOOLS_PER_RUN,
  MAX_RUN_RECOVERY_REQUEST_BYTES, DEFAULT_RUN_OWNER_TTL_MS, RunRecoverySchemaError,
  RunRecoveryLimitError, defaultRunRecoveryStorePath,
} from './run-recovery-store-records';
export type {
  RunRecoveryPhase, RunToolState, RunRecoveryKey, RunToolRecoveryRow, RunRecoveryExecutionInput,
  RecoveryRequestOptions, RecoveryCompletion, RunRecoveryRun, RunAdmissionOutcome,
  RunClaimRecoveryOutcome, RunOutcomeWrite, RunOwnershipOutcome, RunAdmissionInput, RunRecoveryAttempt, RunContinuationOutcome,
} from './run-recovery-store-records';

/**
 * Profile-level recovery database shared by API and Codex runs.
 *
 * Why a separate SQLite file instead of the sidecar: a restart needs to advance
 * one run's tool state, execution cursor and executor generation inside a single
 * transaction, and it must keep completed tool rows without rewriting a whole
 * artifact per step. The sidecar keeps run identity, approvals, events and
 * proposals; this database holds the input and tool evidence needed for replay.
 *
 * Guarantees the callers rely on:
 *  - short `BEGIN IMMEDIATE` transactions, never spanning a model call;
 *  - identity is `(projectId, sessionGeneration, runId)`; a stale generation
 *    can never resume a run;
 *  - every mutating call carries the caller's `epoch` and refuses when another
 *    instance took ownership;
 *  - a repeated identical write returns a duplicate outcome instead of a second
 *    effect, and a differing write is reported as a conflict, never merged.
 */

export class RunRecoveryStore extends RunRecoveryAttempts {
  /**
   * Records one run's admission. Called after the sidecar identity write and
   * before the create response, so an identical create retry can complete a
   * missing admission instead of starting a second executor.
   */
  prepareAdmission(input: RunAdmissionInput): RunAdmissionOutcome {
    if (!supportsDurableRunRecovery(input.backend)) return 'unsupported-backend';
    const now = input.now ?? Date.now();
    const executionInput = input.executionInput ? JSON.stringify({ ...input.executionInput, messages: encodeApiRecoveryMessages(input.executionInput.messages) }) : null;
    if (executionInput && Buffer.byteLength(executionInput, 'utf8') > MAX_RUN_RECOVERY_REQUEST_BYTES) {
      throw new RunRecoveryLimitError('Agent recovery execution input exceeds the size limit.');
    }
    return this.transaction(() => {
      const existing = this.run(input);
      if (existing) {
        const sameIdentity = existing.backend === input.backend
          && existing.model === input.model
          && existing.ask_only === (input.askOnly ? 1 : 0);
        if (!sameIdentity) return 'identity-conflict';
        // The original deadline stands: retries never extend an admission.
        return 'duplicate';
      }
      const count = this.db.prepare(
        'SELECT COUNT(*) AS n FROM run_recovery_runs WHERE finalized_at IS NULL',
      ).get() as { n: number };
      if (count.n >= MAX_RUN_RECOVERY_RUNS) return 'over-capacity';
      this.db.prepare(`
        INSERT INTO run_recovery_runs (
          project_id, session_generation, run_id, backend, model, ask_only,
          phase, revision, admitted_at, admission_expires_at, execution_input
        ) VALUES (?, ?, ?, ?, ?, ?, 'admitted', 0, ?, ?, ?)
      `).run(
        input.projectId,
        input.sessionGeneration,
        input.runId,
        input.backend,
        input.model,
        input.askOnly ? 1 : 0,
        now,
        input.admissionExpiresAt,
        executionInput,
      );
      this.db.prepare(`INSERT INTO run_recovery_attempts
        (project_id, session_generation, run_id, attempt_number, status, started_at)
        VALUES (?, ?, ?, 1, 'executing', ?)`)
        .run(input.projectId, input.sessionGeneration, input.runId, now);
      return 'admitted';
    });
  }

  load(key: RunRecoveryKey): RunRecoveryRun | null {
    const row = this.run(key);
    return row ? toRun(row, this.tools(key), this.attempts(key)) : null;
  }

  /** Projection used by `GET /:runId`; never acquires authority. */
  recoveryState(key: RunRecoveryKey): RunRecoveryPhase | 'unknown' {
    return this.run(key)?.phase as RunRecoveryPhase ?? 'unknown';
  }

  /**
   * Saves the exact model input of one subprocess request. This is the only place the
   * interrupted prompt survives; Codex uses temporary threads.
   */
  beginRequest(
    key: RunRecoveryKey,
    input: {
      readonly epoch: number;
      readonly requestIndex: number;
      readonly prompt: string;
      readonly messages: readonly ModelMessage[];
      readonly toolNames: readonly string[];
      readonly instructions?: string;
      readonly requestOptions?: RecoveryRequestOptions;
    },
  ): void {
    const promptBytes = Buffer.byteLength(input.prompt, 'utf8');
    const messagesText = encodeApiRecoveryMessages(input.messages);
    const totalBytes = promptBytes + Buffer.byteLength(messagesText, 'utf8') + Buffer.byteLength(input.instructions ?? '', 'utf8');
    if (totalBytes > MAX_RUN_RECOVERY_REQUEST_BYTES) {
      throw new RunRecoveryLimitError(
        `Agent recovery request exceeds ${MAX_RUN_RECOVERY_REQUEST_BYTES} bytes.`,
      );
    }
    this.transaction(() => {
      const row = this.run(key);
      if (!row) throw new Error('Agent recovery run is unknown.');
      this.assertOwner(row, input.epoch);
      this.db.prepare(`
        UPDATE run_recovery_runs
        SET request_index = ?, prompt = ?, messages = ?, tool_names = ?,
            body_bytes = ?, instructions = ?, request_options = ?,
            request_op_boundary = CASE WHEN request_state = 'inflight' AND request_index = ? THEN request_op_boundary ELSE next_op_seq - 1 END,
            request_state = 'inflight', completion = NULL, phase = 'executing', revision = revision + 1
        WHERE project_id = ? AND session_generation = ? AND run_id = ?
      `).run(
        input.requestIndex,
        input.prompt,
        messagesText,
        JSON.stringify(input.toolNames),
        totalBytes,
        input.instructions ?? row.instructions,
        JSON.stringify(input.requestOptions ?? null),
        input.requestIndex,
        key.projectId,
        key.sessionGeneration,
        key.runId,
      );
    });
  }

  /** Commits a complete API round and the next execution state in one transaction. */
  completeRequest(key: RunRecoveryKey, input: {
    readonly epoch: number;
    readonly nextRequestIndex: number;
    readonly messages: readonly ModelMessage[];
    readonly executionState: NonNullable<RunRecoveryRun['executionState']>;
    readonly instructions?: string;
    readonly completion?: RecoveryCompletion;
  }): void {
    const messages = encodeApiRecoveryMessages(input.messages);
    const state = JSON.stringify(input.executionState);
    const completion = input.completion ? JSON.stringify(input.completion) : null;
    const bytes = Buffer.byteLength(messages + state + (completion ?? '') + (input.instructions ?? ''), 'utf8');
    if (bytes > MAX_RUN_RECOVERY_REQUEST_BYTES) throw new RunRecoveryLimitError('Agent recovery round checkpoint exceeds the size limit.');
    this.transaction(() => {
      const row = this.run(key);
      if (!row) throw new Error('Agent recovery run is unknown.');
      this.assertOwner(row, input.epoch);
      if (this.tools(key).some((tool) => tool.state === 'claimed')) throw new Error('An unresolved tool claim prevents completing this request.');
      if (row.request_state === 'pending' && row.request_index === input.nextRequestIndex
        && row.messages === messages && row.execution_state === state && row.completion === completion) return;
      if (!Number.isSafeInteger(input.nextRequestIndex) || input.nextRequestIndex !== row.request_index + 1) {
        throw new Error('The completed request index is stale.');
      }
      this.db.prepare(`UPDATE run_recovery_runs SET request_index = ?, messages = ?, execution_state = ?, instructions = COALESCE(?, instructions),
        prompt = NULL, request_options = NULL, request_state = 'pending', request_op_boundary = next_op_seq - 1,
        tool_names = ?, completion = ?, phase = ?, reconcile_reason = NULL, body_bytes = ?, revision = revision + 1
        WHERE project_id = ? AND session_generation = ? AND run_id = ?`)
        .run(input.nextRequestIndex, messages, state, input.instructions ?? null, JSON.stringify(input.executionState.activeToolNames),
          completion, completion ? 'finalizing' : 'executing', bytes, key.projectId, key.sessionGeneration, key.runId);
    });
  }

  saveExecutionState(key: RunRecoveryKey, epoch: number, state: NonNullable<RunRecoveryRun['executionState']>): void {
    this.transaction(() => {
      const row = this.run(key);
      if (!row) throw new Error('Unknown Agent recovery run.');
      this.assertOwner(row, epoch);
      this.db.prepare(`UPDATE run_recovery_runs SET execution_state = ?, revision = revision + 1 WHERE project_id = ? AND session_generation = ? AND run_id = ?`)
        .run(JSON.stringify(state), key.projectId, key.sessionGeneration, key.runId);
    });
  }

  assertOwnership(key: RunRecoveryKey, epoch: number): void {
    const row = this.run(key);
    if (!row) throw new Error('Unknown Agent recovery run.');
    this.assertOwner(row, epoch);
  }

  /**
   * Claims or renews executor authority. TTL only says a takeover may be
   * attempted; it never proves the previous owner's tool did not run.
   */
  acquireOwnership(
    key: RunRecoveryKey,
    input: {
      readonly instanceId: string;
      readonly ttlMs?: number;
      readonly now?: number;
      readonly expectedRevision?: number;
    },
  ): { readonly outcome: RunOwnershipOutcome; readonly epoch?: number; readonly revision?: number } {
    const now = input.now ?? Date.now();
    const ttl = input.ttlMs ?? DEFAULT_RUN_OWNER_TTL_MS;
    return this.transaction(() => {
      const row = this.run(key);
      if (!row) return { outcome: 'unknown-run' as const };
      if (row.finalized_at !== null) return { outcome: 'run-finalized' as const };
      if (input.expectedRevision !== undefined && input.expectedRevision !== row.revision) return { outcome: 'revision-stale' as const };
      const liveElsewhere = row.owner_instance !== null
        && row.owner_instance !== input.instanceId
        && (row.owner_expires_at ?? 0) > now;
      if (liveElsewhere) return { outcome: 'held-elsewhere' as const };
      const sameOwner = row.owner_instance === input.instanceId && (row.owner_expires_at ?? 0) > now;
      const epoch = sameOwner ? row.owner_epoch : row.owner_epoch + 1;
      // The lease is measured from the caller's clock, not from wall time, so a
      // takeover after expiry is testable without waiting 30 seconds.
      this.db.prepare(`
        UPDATE run_recovery_runs
        SET owner_instance = ?, owner_epoch = ?, owner_expires_at = ?
        WHERE project_id = ? AND session_generation = ? AND run_id = ?
      `).run(input.instanceId, epoch, now + ttl,
        key.projectId, key.sessionGeneration, key.runId);
      return {
        outcome: sameOwner ? 'renewed' as const : 'acquired' as const,
        epoch,
        revision: row.revision,
      };
    });
  }

  /** Releases authority without touching the durable progress. */
  releaseOwnership(key: RunRecoveryKey, input: { readonly instanceId: string; readonly epoch: number }): void {
    this.transaction(() => {
      const row = this.run(key);
      if (!row || row.owner_instance !== input.instanceId || row.owner_epoch !== input.epoch) return;
      this.db.prepare(`
        UPDATE run_recovery_runs SET owner_instance = NULL, owner_expires_at = ?
        WHERE project_id = ? AND session_generation = ? AND run_id = ?
      `).run(Date.now(), key.projectId, key.sessionGeneration, key.runId);
    });
  }

  setPhase(
    key: RunRecoveryKey,
    input: { readonly epoch: number; readonly phase: RunRecoveryPhase; readonly reason?: string },
  ): void {
    this.transaction(() => {
      const row = this.run(key);
      if (!row) throw new Error('Agent recovery run is unknown.');
      this.assertOwner(row, input.epoch);
      this.db.prepare(`
        UPDATE run_recovery_runs SET phase = ?, reconcile_reason = ?, revision = revision + 1
        WHERE project_id = ? AND session_generation = ? AND run_id = ?
      `).run(input.phase, input.reason ?? null, key.projectId, key.sessionGeneration, key.runId);
    });
  }

  /**
   * Terminal bookkeeping: the run reached a business outcome, so the replay
   * body is dropped while the row keeps its identity for diagnostics.
   */
  finalize(key: RunRecoveryKey, now = Date.now(), epoch?: number, cancelled = false): boolean {
    return this.transaction(() => {
      const row = this.run(key);
      if (!row) return false;
      if (row.finalized_at !== null) return false;
      if (cancelled) { /* An explicit user cancellation revokes every executor. */ }
      else if (epoch !== undefined) this.assertOwner(row, epoch);
      else if (row.owner_instance !== null && (row.owner_expires_at ?? 0) > now) return false;
      this.db.prepare(`
        UPDATE run_recovery_runs
        SET phase = 'finalized', finalized_at = ?, prompt = NULL, messages = NULL, execution_input = NULL, execution_state = NULL, completion = NULL, request_options = NULL,
            owner_instance = NULL, owner_expires_at = NULL, owner_epoch = owner_epoch + 1, revision = revision + 1
        WHERE project_id = ? AND session_generation = ? AND run_id = ?
      `).run(now, key.projectId, key.sessionGeneration, key.runId);
      this.db.prepare(`UPDATE run_recovery_attempts SET message = NULL,
        status = CASE WHEN status = 'executing' THEN ? ELSE status END,
        ended_at = COALESCE(ended_at, ?) WHERE project_id = ? AND session_generation = ? AND run_id = ?`)
        .run(cancelled ? 'cancelled' : 'completed', now, key.projectId, key.sessionGeneration, key.runId);
      return true;
    });
  }

  purgeRun(key: RunRecoveryKey): number {
    return this.transaction(() => {
      this.db.prepare(`
        DELETE FROM run_recovery_tools WHERE project_id = ? AND session_generation = ? AND run_id = ?
      `).run(key.projectId, key.sessionGeneration, key.runId);
      const result = this.db.prepare(`
        DELETE FROM run_recovery_runs WHERE project_id = ? AND session_generation = ? AND run_id = ?
      `).run(key.projectId, key.sessionGeneration, key.runId);
      return Number(result.changes ?? 0);
    });
  }

  /** Drops every run of a project, used when the project itself is deleted. */
  purgeProject(projectId: string): number {
    return this.transaction(() => {
      this.db.prepare('DELETE FROM run_recovery_tools WHERE project_id = ?').run(projectId);
      const result = this.db.prepare('DELETE FROM run_recovery_runs WHERE project_id = ?').run(projectId);
      return Number(result.changes ?? 0);
    });
  }

  /** Drops runs whose session generation is no longer current. */
  purgeOtherGenerations(projectId: string, currentGeneration: string): number {
    return this.transaction(() => {
      const stale = this.db.prepare(`
        SELECT session_generation, run_id FROM run_recovery_runs
        WHERE project_id = ? AND session_generation <> ?
      `).all(projectId, currentGeneration) as unknown as Array<{
        session_generation: string; run_id: string;
      }>;
      for (const row of stale) {
        this.db.prepare(`
          DELETE FROM run_recovery_tools WHERE project_id = ? AND session_generation = ? AND run_id = ?
        `).run(projectId, row.session_generation, row.run_id);
        this.db.prepare(`
          DELETE FROM run_recovery_runs WHERE project_id = ? AND session_generation = ? AND run_id = ?
        `).run(projectId, row.session_generation, row.run_id);
      }
      return stale.length;
    });
  }

  /** An admission whose process died before /start has no tool authority to reconcile. */
  expireAdmissions(now = Date.now()): number {
    return this.transaction(() => {
      const result = this.db.prepare(`UPDATE run_recovery_runs SET phase = 'finalized', finalized_at = ?,
        execution_input = NULL, revision = revision + 1
        WHERE phase = 'admitted' AND finalized_at IS NULL AND admission_expires_at <= ?
          AND (owner_instance IS NULL OR owner_expires_at <= ?)
          AND NOT EXISTS (SELECT 1 FROM run_recovery_tools WHERE project_id = run_recovery_runs.project_id
            AND session_generation = run_recovery_runs.session_generation AND run_id = run_recovery_runs.run_id)`)
        .run(now, now, now);
      return Number(result.changes ?? 0);
    });
  }

  /** Finalized rows older than the retention window; live runs are never touched. */
  purgeFinalizedBefore(cutoff: number): number {
    return this.transaction(() => {
      const expired = this.db.prepare(`
        SELECT project_id, session_generation, run_id FROM run_recovery_runs
        WHERE finalized_at IS NOT NULL AND finalized_at < ?
      `).all(cutoff) as unknown as Array<{
        project_id: string; session_generation: string; run_id: string;
      }>;
      for (const row of expired) {
        this.db.prepare(`
          DELETE FROM run_recovery_tools WHERE project_id = ? AND session_generation = ? AND run_id = ?
        `).run(row.project_id, row.session_generation, row.run_id);
        this.db.prepare(`
          DELETE FROM run_recovery_runs WHERE project_id = ? AND session_generation = ? AND run_id = ?
        `).run(row.project_id, row.session_generation, row.run_id);
      }
      return expired.length;
    });
  }

  /**
   * The recorded operation for the same effective invocation, regardless of the
   * model's call id. A resumed model asking again with a new id must be matched
   * against what already happened, not treated as fresh work.
   */
  findOperation(
    key: RunRecoveryKey,
    input: { readonly name: string; readonly argsDigest: string; readonly requestIndex?: number; readonly throughOpSeq?: number },
  ): (RunToolRecoveryRow & { readonly ambiguous?: boolean }) | null {
    const rows = this.db.prepare(`
      SELECT op_seq, request_index, args, tool_call_id, name, args_digest, state, claim_id, success, result, model_result, error
      FROM run_recovery_tools
      WHERE project_id = ? AND session_generation = ? AND run_id = ?
        AND name = ? AND args_digest = ?
        AND (? IS NULL OR request_index = ?) AND (? IS NULL OR op_seq <= ?)
      ORDER BY (state = 'intent') ASC, op_seq ASC LIMIT 2
    `).all(key.projectId, key.sessionGeneration, key.runId, input.name, input.argsDigest,
      input.requestIndex ?? null, input.requestIndex ?? null, input.throughOpSeq ?? null, input.throughOpSeq ?? null) as unknown as ToolRow[];
    if (!rows.length) return null;
    return { ...toRun(this.run(key)!, [rows[0]]).tools[0], ...(rows.filter((row) => row.state !== 'intent').length > 1 ? { ambiguous: true } : {}) };
  }

  /** Deterministic ordering for the recovery prompt: dispatch order, never completion order. */
  completedTools(key: RunRecoveryKey) {
    return this.load(key)?.tools.filter((tool) => tool.state === 'outcome') ?? [];
  }
}

let activeStore: RunRecoveryStore | null = null;

export function runRecoveryStore(): RunRecoveryStore {
  activeStore ??= new RunRecoveryStore();
  return activeStore;
}

export function resetRunRecoveryStoreForTest(store: RunRecoveryStore | null = null): void {
  if (activeStore && activeStore !== store) activeStore.close();
  activeStore = store;
}
