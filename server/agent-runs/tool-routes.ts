import type { IncomingMessage, ServerResponse } from 'node:http';
import { isFailedToolResult, toolFailureReason } from '../../src/agent/toolFailure';
import { claimRunRecoveryTool, recordRunBrowserOutcome } from './run-recovery-runtime';
import { claimToolRequest, settleToolResult, type ServerRun, type ToolClaimOutcome, type ToolResultOutcome } from './store';
import { readJson, requireProjectId } from './request';

const MAX_TOOL_RESULT_BODY_BYTES = 1024 * 1024;

interface ToolRouteContext {
  readonly boundRun: (req: IncomingMessage, res: ServerResponse, projectId: string, runId: string) => Promise<ServerRun | null>;
  readonly sendJson: (res: ServerResponse, status: number, body: unknown) => void;
}

function outcomeStatus(outcome: ToolClaimOutcome | ToolResultOutcome): number {
  if (outcome === 'unknown-call') return 404;
  return outcome === 'mismatch' || outcome === 'unclaimed'
    || outcome === 'already-claimed' || outcome === 'run-settled'
    ? 409
    : 200;
}

/** Tool authority and outcomes must reach the durable ledger before HTTP acknowledgment. */
export function createToolRouteHandlers({ boundRun, sendJson }: ToolRouteContext) {
  function toolBinding(body: Record<string, unknown>) {
    const toolCallId = typeof body.toolCallId === 'string' ? body.toolCallId.trim() : '';
    const argsDigest = typeof body.argsDigest === 'string' ? body.argsDigest.trim() : '';
    const claimId = typeof body.claimId === 'string' ? body.claimId.trim() : '';
    if (!toolCallId || !argsDigest || !claimId) {
      throw new Error('toolCallId, argsDigest, and claimId are required');
    }
    return { toolCallId, argsDigest, claimId };
  }

  async function handleToolClaim(req: IncomingMessage, res: ServerResponse, runId: string): Promise<void> {
    const body = await readJson(req);
    const projectId = requireProjectId(body.projectId);
    const run = await boundRun(req, res, projectId, runId);
    if (!run) return;
    const binding = toolBinding(body);
    // A delayed SSE replay from the old process carries no current waiter.
    // Do not turn its unclaimed intent into a durable claim during takeover.
    if (run.toolRequests.get(binding.toolCallId)?.status !== 'pending') {
      const outcome = claimToolRequest(run, binding);
      return sendJson(res, outcomeStatus(outcome), { claimed: false, outcome });
    }
    // The durable claim commits before the answer: "no claim record" is the only
    // evidence that execution authority was never granted, so recording it after
    // the response would make that inference false.
    let recoveryOutcome: ReturnType<typeof claimRunRecoveryTool>;
    try {
      recoveryOutcome = claimRunRecoveryTool(run, binding);
    } catch {
      // The claim could not be written. Answering `claimed` here would let the
      // browser execute work the server cannot account for after a restart.
      sendJson(res, 409, { claimed: false, outcome: 'claim-write-failed' });
      return;
    }
    if (recoveryOutcome !== null
      && recoveryOutcome !== 'claimed'
      && recoveryOutcome !== 'duplicate') {
      // A run whose execution authority cannot be proven must not hand out new
      // authority; report the durable reason instead of the in-memory one.
      sendJson(res, recoveryOutcome === 'unknown-tool' ? 404 : 409, {
        claimed: false,
        outcome: recoveryOutcome,
      });
      return;
    }
    const outcome = claimToolRequest(run, binding);
    sendJson(res, outcomeStatus(outcome), {
      claimed: outcome === 'claimed' || outcome === 'duplicate',
      outcome,
    });
  }

  async function handleToolResult(req: IncomingMessage, res: ServerResponse, runId: string): Promise<void> {
    const body = await readJson(req, MAX_TOOL_RESULT_BODY_BYTES);
    const projectId = requireProjectId(body.projectId);
    const run = await boundRun(req, res, projectId, runId);
    if (!run) return;
    const binding = toolBinding(body);
    const hasResult = Object.hasOwn(body, 'result');
    const error = typeof body.error === 'string' ? body.error : undefined;
    const hasError = Object.hasOwn(body, 'error');
    if (hasResult === hasError || (hasError && error === undefined)) {
      throw new Error('provide exactly one of result or string error');
    }
    const normalizedError = error ?? (isFailedToolResult(body.result) ? toolFailureReason(body.result) : undefined);
    let durable: ReturnType<typeof recordRunBrowserOutcome>;
    try {
      durable = recordRunBrowserOutcome(run, {
        ...binding,
        ...(normalizedError === undefined ? { result: body.result } : { error: normalizedError }),
      });
    } catch {
      return sendJson(res, 409, { ok: false, outcome: 'outcome-write-failed' });
    }
    if (durable !== null && durable !== 'recorded' && durable !== 'duplicate') {
      return sendJson(res, 409, { ok: false, outcome: durable });
    }
    const outcome = settleToolResult(run, {
      ...binding,
      ...(error === undefined ? { result: body.result } : { error }),
    });
    sendJson(res, durable === 'recorded' || durable === 'duplicate' ? 200 : outcomeStatus(outcome), {
      ok: durable === 'recorded' || durable === 'duplicate' || outcome === 'accepted' || outcome === 'duplicate',
      outcome: durable === 'recorded' ? 'accepted' : durable === 'duplicate' ? 'duplicate' : outcome,
    });
  }

  return { handleToolClaim, handleToolResult };
}
