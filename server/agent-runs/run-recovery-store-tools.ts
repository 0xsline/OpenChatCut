import { RunRecoveryDatabase } from './run-recovery-store-database';
import { MAX_RUN_RECOVERY_TOOLS_PER_RUN, MAX_RUN_RECOVERY_REQUEST_BYTES, RunRecoveryLimitError } from './run-recovery-store-records';
import type { RunRecoveryKey, RunToolState, RunClaimRecoveryOutcome, RunOutcomeWrite } from './run-recovery-store-records';
import type { ServerRunToolIntent, ServerRunToolOutcome } from './run-recovery-contract.ts';

/** Durable tool intent, browser authority and outcome ledger. */
export class RunRecoveryToolLedger extends RunRecoveryDatabase {
  /**
   * Reserves the next dispatch sequence for a tool call and stores its intent.
   * Must complete before the tool request becomes visible to the browser:
   * without a durable intent the server cannot later prove whether execution
   * authority was ever granted.
   */
  beginTool(
    key: RunRecoveryKey,
    input: { readonly epoch: number; readonly intent: Omit<ServerRunToolIntent, 'opSeq'> },
  ): { readonly opSeq: number; readonly state: RunToolState | 'duplicate' } {
    return this.transaction(() => {
      const row = this.run(key);
      if (!row) throw new Error('Agent recovery run is unknown.');
      this.assertOwner(row, input.epoch);
      const existing = this.db.prepare(`
        SELECT op_seq, state, args_digest, name FROM run_recovery_tools
        WHERE project_id = ? AND session_generation = ? AND run_id = ? AND tool_call_id = ?
      `).get(key.projectId, key.sessionGeneration, key.runId, input.intent.toolCallId) as
        { op_seq: number; state: string; args_digest: string; name: string } | undefined;
      if (existing) {
        if (existing.args_digest !== input.intent.argsDigest || existing.name !== input.intent.name) {
          throw new Error(`Agent tool ${input.intent.toolCallId} was already dispatched with different arguments.`);
        }
        return { opSeq: existing.op_seq, state: 'duplicate' as const };
      }
      const toolCount = this.db.prepare(`
        SELECT COUNT(*) AS n FROM run_recovery_tools
        WHERE project_id = ? AND session_generation = ? AND run_id = ?
      `).get(key.projectId, key.sessionGeneration, key.runId) as { n: number };
      if (toolCount.n >= MAX_RUN_RECOVERY_TOOLS_PER_RUN) {
        throw new RunRecoveryLimitError(
          `Agent recovery tool limit reached (${MAX_RUN_RECOVERY_TOOLS_PER_RUN}).`,
        );
      }
      const opSeq = row.next_op_seq;
      const now = Date.now();
      this.db.prepare(`
        INSERT INTO run_recovery_tools (
          project_id, session_generation, run_id, op_seq, tool_call_id, name,
          args_digest, state, created_at, updated_at, request_index, args
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'intent', ?, ?, ?, ?)
      `).run(
        key.projectId,
        key.sessionGeneration,
        key.runId,
        opSeq,
        input.intent.toolCallId,
        input.intent.name,
        input.intent.argsDigest,
        now,
        now,
        row.request_index,
        JSON.stringify(input.intent.args ?? null),
      );
      this.db.prepare(`
        UPDATE run_recovery_runs SET next_op_seq = next_op_seq + 1, revision = revision + 1
        WHERE project_id = ? AND session_generation = ? AND run_id = ?
      `).run(key.projectId, key.sessionGeneration, key.runId);
      return { opSeq, state: 'intent' as const };
    });
  }

  /**
   * Persists execution authority before the browser is told it may run.
   * The route handler must not answer `claimed` until this commits: "no claim
   * record" is the evidence that execution authority was never granted.
   */
  claimTool(
    key: RunRecoveryKey,
    input: {
      readonly epoch: number;
      readonly toolCallId: string;
      readonly argsDigest: string;
      readonly claimId: string;
    },
  ): RunClaimRecoveryOutcome {
    return this.transaction(() => {
      const row = this.run(key);
      if (!row) return 'unknown-tool';
      if (row.finalized_at !== null) return 'run-finalized';
      if (row.owner_epoch !== input.epoch || row.owner_instance === null) return 'epoch-stale';
      const tool = this.db.prepare(`
        SELECT op_seq, state, args_digest, claim_id FROM run_recovery_tools
        WHERE project_id = ? AND session_generation = ? AND run_id = ? AND tool_call_id = ?
      `).get(key.projectId, key.sessionGeneration, key.runId, input.toolCallId) as
        { op_seq: number; state: string; args_digest: string; claim_id: string | null } | undefined;
      if (!tool) return 'unknown-tool';
      if (tool.args_digest !== input.argsDigest) return 'mismatch';
      if (tool.state === 'outcome') return 'run-finalized';
      if (tool.state === 'claimed') {
        return tool.claim_id === input.claimId ? 'duplicate' : 'already-claimed';
      }
      this.db.prepare(`
        UPDATE run_recovery_tools SET state = 'claimed', claim_id = ?, updated_at = ?
        WHERE project_id = ? AND session_generation = ? AND run_id = ? AND op_seq = ?
      `).run(
        input.claimId,
        Date.now(),
        key.projectId,
        key.sessionGeneration,
        key.runId,
        tool.op_seq,
      );
      this.db.prepare(`UPDATE run_recovery_runs SET revision = revision + 1
        WHERE project_id = ? AND session_generation = ? AND run_id = ?`)
        .run(key.projectId, key.sessionGeneration, key.runId);
      return 'claimed';
    });
  }

  /**
   * Commits a tool outcome before the model may see it. A duplicate identical
   * result is idempotent; a differing result for the same call is a conflict
   * that has to be reconciled, never silently overwritten.
   */
  finishTool(
    key: RunRecoveryKey,
    input: { readonly epoch: number; readonly outcome: ServerRunToolOutcome },
  ): RunOutcomeWrite {
    return this.transaction(() => {
      const row = this.run(key);
      if (!row) return 'unknown-tool';
      if (row.finalized_at !== null) return 'run-finalized';
      if (row.owner_epoch !== input.epoch || row.owner_instance === null) return 'epoch-stale';
      const tool = this.db.prepare(`
        SELECT op_seq, state, args_digest, success, result, model_result, error FROM run_recovery_tools
        WHERE project_id = ? AND session_generation = ? AND run_id = ? AND tool_call_id = ?
      `).get(key.projectId, key.sessionGeneration, key.runId, input.outcome.toolCallId) as
        {
          op_seq: number; state: string; args_digest: string;
          success: number | null; result: string | null; model_result: string | null; error: string | null;
        } | undefined;
      if (!tool) return 'unknown-tool';
      if (tool.args_digest !== input.outcome.argsDigest) return 'conflict';
      const resultText = JSON.stringify(input.outcome.result ?? null);
      if (Buffer.byteLength(resultText, 'utf8') > MAX_RUN_RECOVERY_REQUEST_BYTES) {
        throw new RunRecoveryLimitError('Agent recovery tool outcome exceeds the size limit.');
      }
      if (tool.state === 'outcome') {
        if (tool.success !== (input.outcome.success ? 1 : 0)) return 'conflict';
        if (tool.model_result !== null) return tool.model_result === resultText ? 'duplicate' : 'conflict';
        // The HTTP endpoint committed the browser answer before releasing the
        // waiter. The owner now records the model-facing projection once.
        this.db.prepare(`UPDATE run_recovery_tools SET model_result = ? WHERE project_id = ? AND session_generation = ? AND run_id = ? AND op_seq = ?`)
          .run(resultText, key.projectId, key.sessionGeneration, key.runId, tool.op_seq);
        this.db.prepare(`UPDATE run_recovery_runs SET revision = revision + 1 WHERE project_id = ? AND session_generation = ? AND run_id = ?`)
          .run(key.projectId, key.sessionGeneration, key.runId);
        return 'recorded';
      }
      if (tool.state !== 'claimed' && !input.outcome.local) return 'unclaimed';
      this.db.prepare(`
        UPDATE run_recovery_tools
        SET state = 'outcome', success = ?, result = ?, model_result = ?, updated_at = ?
        WHERE project_id = ? AND session_generation = ? AND run_id = ? AND op_seq = ?
      `).run(
        input.outcome.success ? 1 : 0,
        resultText,
        resultText,
        Date.now(),
        key.projectId,
        key.sessionGeneration,
        key.runId,
        tool.op_seq,
      );
      this.db.prepare(`
        UPDATE run_recovery_runs
        SET completed_through_op_seq = MAX(completed_through_op_seq, ?), revision = revision + 1,
            phase = CASE WHEN phase = 'needs_reconcile' AND reconcile_reason IN ('claimed-outcome-unknown', 'recovery-write-failed') AND NOT EXISTS (
              SELECT 1 FROM run_recovery_tools WHERE project_id = run_recovery_runs.project_id
                AND session_generation = run_recovery_runs.session_generation AND run_id = run_recovery_runs.run_id
                AND state = 'claimed'
            ) THEN CASE WHEN EXISTS (SELECT 1 FROM run_recovery_attempts
              WHERE project_id = run_recovery_runs.project_id AND session_generation = run_recovery_runs.session_generation
                AND run_id = run_recovery_runs.run_id AND attempt_number = run_recovery_runs.attempt_number AND status = 'paused')
              THEN 'paused' ELSE 'executing' END ELSE phase END
        WHERE project_id = ? AND session_generation = ? AND run_id = ?
      `).run(tool.op_seq, key.projectId, key.sessionGeneration, key.runId);
      return 'recorded';
    });
  }

  recordBrowserOutcome(key: RunRecoveryKey, input: {
    toolCallId: string; argsDigest: string; claimId: string; result?: unknown; error?: string;
  }): RunOutcomeWrite {
    return this.transaction(() => {
      const row = this.run(key);
      if (!row) return 'unknown-tool';
      if (row.finalized_at !== null) return 'run-finalized';
      const tool = this.tools(key).find((entry) => entry.tool_call_id === input.toolCallId);
      if (!tool) return 'unknown-tool';
      if (tool.args_digest !== input.argsDigest || tool.claim_id !== input.claimId) return 'conflict';
      if (tool.state !== 'claimed' && tool.state !== 'outcome') return 'unclaimed';
      const result = input.error === undefined ? input.result ?? null : { error: input.error };
      const success = input.error === undefined;
      const resultText = JSON.stringify(result);
      if (Buffer.byteLength(resultText, 'utf8') > MAX_RUN_RECOVERY_REQUEST_BYTES) {
        throw new RunRecoveryLimitError('Agent recovery tool outcome exceeds the size limit.');
      }
      if (tool.state === 'outcome') return tool.result === resultText && tool.success === (success ? 1 : 0) ? 'duplicate' : 'conflict';
      this.db.prepare(`UPDATE run_recovery_tools SET state = 'outcome', success = ?, result = ?, error = ?, updated_at = ?
        WHERE project_id = ? AND session_generation = ? AND run_id = ? AND op_seq = ?`)
        .run(success ? 1 : 0, resultText, input.error ?? null, Date.now(), key.projectId, key.sessionGeneration, key.runId, tool.op_seq);
      this.db.prepare(`UPDATE run_recovery_runs SET revision = revision + 1,
        completed_through_op_seq = MAX(completed_through_op_seq, ?),
        phase = CASE WHEN phase = 'needs_reconcile' AND reconcile_reason IN ('claimed-outcome-unknown', 'recovery-write-failed') AND NOT EXISTS (
          SELECT 1 FROM run_recovery_tools WHERE project_id = run_recovery_runs.project_id AND session_generation = run_recovery_runs.session_generation
            AND run_id = run_recovery_runs.run_id AND state = 'claimed'
        ) THEN CASE WHEN EXISTS (SELECT 1 FROM run_recovery_attempts
              WHERE project_id = run_recovery_runs.project_id AND session_generation = run_recovery_runs.session_generation
                AND run_id = run_recovery_runs.run_id AND attempt_number = run_recovery_runs.attempt_number AND status = 'paused')
              THEN 'paused' ELSE 'executing' END ELSE phase END
        WHERE project_id = ? AND session_generation = ? AND run_id = ?`)
        .run(tool.op_seq, key.projectId, key.sessionGeneration, key.runId);
      return 'recorded';
    });
  }

}
