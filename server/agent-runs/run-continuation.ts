import type { ServerResponse } from 'node:http';
import { executeRun, type ServerRunInput } from './executor';
import { isRunTerminal, type ServerRun } from './store';
import { canonicalServerRunToolCatalog } from './tool-policy';
import { runRecoveryStore, supportsDurableRunRecovery, type RunRecoveryRun } from './run-recovery-store';
import { beginRunRecoveryRuntime, hasLiveRunRecoveryRuntime, runRecoveryKeyOf, stopRunRecoveryRuntime } from './run-recovery-runtime';

type Reply = (res: ServerResponse, status: number, body: unknown) => void;
interface ContinuationRequest { continuationId: string; message: string; expectedRevision: number; }

function request(body: Record<string, unknown>): ContinuationRequest | null {
  return typeof body.continuationId === 'string' && !!body.continuationId.trim() && body.continuationId.length <= 256
    && typeof body.message === 'string' && !!body.message.trim() && body.message.length <= 64_000
    && Number.isSafeInteger(body.expectedRevision) && Number(body.expectedRevision) >= 0
    ? { continuationId: body.continuationId, message: body.message, expectedRevision: Number(body.expectedRevision) }
    : null;
}

function accepted(res: ServerResponse, reply: Reply, outcome: 'started' | 'duplicate', record: RunRecoveryRun, id: string): void {
  reply(res, outcome === 'started' ? 202 : 200, { ok: true, outcome, mode: 'continue',
    continuationId: id, attemptNumber: record.attemptNumber, revision: record.revision });
}

/** Idempotently append an instruction to a paused run, then start its next attempt. */
export function continueServerRun(
  run: ServerRun, body: Record<string, unknown>, origin: string, res: ServerResponse, reply: Reply, execute = executeRun,
): void {
  const input = request(body);
  if (!input) return reply(res, 400, { error: 'continuationId, message and expectedRevision are required' });
  if (!supportsDurableRunRecovery(run.backend)) return reply(res, 409, { error: 'this backend does not support task continuation' });
  const key = runRecoveryKeyOf(run);
  const store = runRecoveryStore();
  const record = store.load(key);
  if (!record) return reply(res, 409, { error: 'the task has no saved continuation checkpoint' });
  if (record.attempts.some((attempt) => attempt.continuationId === input.continuationId)) {
    // Check the durable request identity before leases/revisions, even if the
    // original response was lost and its attempt has since finished.
    const outcome = store.continueAttempt(key, { epoch: record.ownerEpoch,
      continuationId: input.continuationId, message: input.message });
    if (outcome === 'duplicate') return accepted(res, reply, 'duplicate', record, input.continuationId);
    return reply(res, 409, { error: 'continuationId was already used with a different message', outcome });
  }
  if (isRunTerminal(run) || record.phase === 'finalized') return reply(res, 409, { error: 'task already ended' });
  if (record.phase !== 'paused' && record.phase !== 'needs_reconcile') {
    return reply(res, 409, { error: 'task is still running; wait until it pauses' });
  }
  if (run.abort || hasLiveRunRecoveryRuntime(run)) return reply(res, 409, { error: 'previous attempt is still stopping; retry shortly' });
  if (record.revision !== input.expectedRevision) return reply(res, 409, { error: 'recovery revision is stale' });
  if (record.tools.some((tool) => tool.state === 'claimed')) return reply(res, 409, { error: 'run is waiting for tool reconciliation' });
  if (!record.executionInput) return reply(res, 409, { error: 'persisted execution input is unavailable' });
  const catalog = canonicalServerRunToolCatalog(run.askOnly);
  const tools = record.executionInput.toolNames.map((name) => catalog.find((tool) => tool.name === name));
  if (tools.some((tool) => !tool)) return reply(res, 409, { error: 'persisted tool catalog is unavailable' });
  const runtime = beginRunRecoveryRuntime(run, { instanceId: `continue:${process.pid}:${crypto.randomUUID()}`,
    expectedRevision: input.expectedRevision });
  if (!runtime) return reply(res, 409, { error: 'execution authority changed; refresh recovery metadata' });
  try {
    const outcome = store.continueAttempt(key, { epoch: runtime.epoch,
      continuationId: input.continuationId, message: input.message });
    if (outcome === 'duplicate') {
      stopRunRecoveryRuntime(run);
      return accepted(res, reply, 'duplicate', store.load(key)!, input.continuationId);
    }
    if (outcome !== 'accepted') {
      stopRunRecoveryRuntime(run);
      return reply(res, 409, { error: `task continuation rejected: ${outcome}`, outcome });
    }
    const resumed = store.load(key)!;
    const { toolNames: _tools, references: _references, ...execution } = resumed.executionInput!;
    // The transaction above is the acknowledgment boundary. A crash before
    // execution can be resumed using the same run/checkpoint on reconnect.
    void execute(run, { ...execution, origin, tools: tools as ServerRunInput['tools'] }, { resume: resumed }).catch(() => stopRunRecoveryRuntime(run));
    accepted(res, reply, 'started', resumed, input.continuationId);
  } catch (error) {
    stopRunRecoveryRuntime(run);
    throw error;
  }
}
