import { createHash } from 'node:crypto';
import { encodeApiRecoveryMessages } from './api-recovery-messages';
import { buildRunContinuationMessages } from './run-continuation-messages';
import { RunRecoveryToolLedger } from './run-recovery-store-tools';
import { MAX_RUN_RECOVERY_REQUEST_BYTES, RunRecoveryLimitError, toRun } from './run-recovery-store-records';
import type { RunRecoveryKey, RunContinuationOutcome } from './run-recovery-store-records';

/** Attempts keep one logical run's interruption and continuation evidence across restarts. */
export class RunRecoveryAttempts extends RunRecoveryToolLedger {
  pauseAttempt(key: RunRecoveryKey, error: unknown, epoch?: number): void {
    this.transaction(() => {
      const row = this.run(key);
      if (!row || row.finalized_at !== null) return;
      if (epoch !== undefined) this.assertOwner(row, epoch);
      const reason = error instanceof Error ? error.message : String(error);
      const claimed = this.tools(key).some((tool) => tool.state === 'claimed');
      const now = Date.now();
      this.db.prepare(`UPDATE run_recovery_runs SET phase = ?, last_error = ?, reconcile_reason = ?,
        completion = NULL, revision = revision + 1 WHERE project_id = ? AND session_generation = ? AND run_id = ?`)
        .run(claimed ? 'needs_reconcile' : 'paused', reason, claimed ? 'claimed-outcome-unknown' : null,
          key.projectId, key.sessionGeneration, key.runId);
      this.db.prepare(`UPDATE run_recovery_attempts SET status = 'paused', ended_at = ?, error = ?
        WHERE project_id = ? AND session_generation = ? AND run_id = ? AND attempt_number = ?`)
        .run(now, reason, key.projectId, key.sessionGeneration, key.runId, row.attempt_number);
    });
  }

  continueAttempt(key: RunRecoveryKey, input: {
    readonly epoch: number;
    readonly continuationId: string;
    readonly message: string;
    readonly expectedRevision?: number;
  }): RunContinuationOutcome {
    if (typeof input.continuationId !== 'string' || !input.continuationId.trim()
      || input.continuationId.length > 256 || typeof input.message !== 'string' || !input.message.trim()) {
      return 'invalid-continuation';
    }
    const digest = createHash('sha256').update(input.message).digest('hex');
    return this.transaction(() => {
      const row = this.run(key);
      if (!row) return 'unknown-run';
      const attempts = this.attempts(key);
      const prior = attempts.find((attempt) => attempt.continuationId === input.continuationId);
      if (prior) return prior.messageDigest === digest ? 'duplicate' : 'conflict';
      if (row.finalized_at !== null || row.completion !== null) return 'run-finalized';
      if (row.owner_instance === null || row.owner_epoch !== input.epoch) return 'epoch-stale';
      if (input.expectedRevision !== undefined && input.expectedRevision !== row.revision) return 'revision-stale';
      const tools = this.tools(key);
      if (tools.some((tool) => tool.state === 'claimed')) return 'unresolved-claims';
      const current = attempts.find((attempt) => attempt.attemptNumber === row.attempt_number);
      if (row.phase !== 'paused' && row.phase !== 'needs_reconcile' && current?.status !== 'paused') return 'not-paused';
      const run = toRun(row, tools, attempts);
      if (run.messages === null && !run.executionInput) return 'missing-checkpoint';
      const messages = encodeApiRecoveryMessages(buildRunContinuationMessages(run, input.message));
      const bytes = Buffer.byteLength(messages + (row.execution_state ?? '') + (row.instructions ?? ''), 'utf8');
      if (bytes > MAX_RUN_RECOVERY_REQUEST_BYTES) throw new RunRecoveryLimitError('Agent continuation exceeds the checkpoint size limit.');
      const number = row.attempt_number + 1;
      const now = Date.now();
      this.db.prepare(`UPDATE run_recovery_attempts SET status = 'paused', ended_at = COALESCE(ended_at, ?)
        WHERE project_id = ? AND session_generation = ? AND run_id = ? AND attempt_number = ?`)
        .run(now, key.projectId, key.sessionGeneration, key.runId, row.attempt_number);
      this.db.prepare(`INSERT INTO run_recovery_attempts (project_id, session_generation, run_id,
        attempt_number, continuation_id, message, message_digest, status, started_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'executing', ?)`)
        .run(key.projectId, key.sessionGeneration, key.runId, number, input.continuationId, input.message, digest, now);
      this.db.prepare(`UPDATE run_recovery_runs SET attempt_number = ?, last_continuation_id = ?, last_error = NULL,
        messages = ?, request_index = request_index + 1, request_state = 'pending', prompt = NULL,
        request_options = NULL, request_op_boundary = next_op_seq - 1, completion = NULL,
        phase = 'executing', reconcile_reason = NULL, body_bytes = ?, revision = revision + 1
        WHERE project_id = ? AND session_generation = ? AND run_id = ?`)
        .run(number, input.continuationId, messages, bytes, key.projectId, key.sessionGeneration, key.runId);
      return 'accepted';
    });
  }
}
