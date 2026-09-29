import { compactToolResultForModel } from '../../src/agent/tool-result-compaction';
import { isFailedToolResult, toolFailureReason } from '../../src/agent/toolFailure';
import {
  SERVER_TOOL_RESULT_TIMEOUT_MS,
  type ServerRun,
  type ServerToolRequest,
  type ToolClaimOutcome,
  type ToolResultOutcome,
} from './store-types';
import { digestValue } from './store-values';

type ApprovalStatus = 'pending' | 'allowed' | 'denied' | 'cancelled';

export interface StoreToolDependencies {
  isRunTerminal: (run: ServerRun) => boolean;
  mirrorTool: (
    run: ServerRun,
    request: ServerToolRequest,
    status: ApprovalStatus,
  ) => Promise<void>;
  pushRunEvent: (run: ServerRun, type: string, data: unknown) => void;
}

type SettleToolInput = {
  toolCallId: string;
  argsDigest: string;
  claimId?: string;
  result?: unknown;
  error?: string;
};

function normalizeToolSettlement(input: SettleToolInput): SettleToolInput {
  if (input.error !== undefined || !isFailedToolResult(input.result)) return input;
  return { ...input, result: undefined, error: toolFailureReason(input.result) };
}

type ReadyToolSettlement = {
  request: ServerToolRequest;
  outcomeDigest: string;
};

type RejectedToolSettlement = Exclude<ToolResultOutcome, 'accepted'>;

const released = (): void => {};

/**
 * A run makes as many tool calls as its turn needs, and every settled or
 * cancelled request stays in run.toolRequests so a late claim or a re-sent
 * result still reads as 'run-settled' or 'duplicate'. Drop the promise
 * callbacks once it settles: they keep the delivered result reachable.
 */
function releaseToolRequest(request: ServerToolRequest): void {
  clearTimeout(request.timeout);
  request.timeout = undefined;
  request.resolve = released;
  request.reject = released;
}

export async function rejectPendingTools(
  run: ServerRun,
  message: string,
  persist?: (request: ServerToolRequest) => Promise<void>,
): Promise<void> {
  const pending: ServerToolRequest[] = [];
  for (const request of run.toolRequests.values()) {
    if (request.status !== 'pending') continue;
    request.status = 'cancelled';
    const { reject } = request;
    releaseToolRequest(request);
    reject(new Error(message));
    pending.push(request);
  }
  if (persist) await Promise.all(pending.map(persist));
}

/**
 * Registers a browser tool request and returns its eventual result. It throws
 * instead of registering, so the caller announces a request only once the
 * browser can claim it; an announced request that was never registered makes
 * the claim 404 and the browser abandon the whole run (#186).
 */
export function registerToolRequest(
  dependencies: StoreToolDependencies,
  run: ServerRun,
  toolCallId: string,
  toolName: string,
  argsDigest: string,
  timeoutMs = SERVER_TOOL_RESULT_TIMEOUT_MS,
): Promise<unknown> {
  // Once settlement starts, pending requests have been cancelled and new
  // events are dropped, so a request registered now would never be served.
  if (dependencies.isRunTerminal(run) || run.terminalPromise) {
    throw new Error('Agent run is already settled.');
  }
  if (run.toolRequests.has(toolCallId)) throw new Error(`Duplicate toolCallId: ${toolCallId}`);
  const { promise, resolve, reject } = Promise.withResolvers<unknown>();
  const request: ServerToolRequest = {
    toolCallId,
    toolName,
    argsDigest,
    status: 'pending',
    resolve,
    reject,
  };
  request.timeout = setTimeout(() => {
    if (request.status !== 'pending') return;
    request.status = 'cancelled';
    releaseToolRequest(request);
    void dependencies.mirrorTool(run, request, 'cancelled');
    reject(new Error(`Agent tool request timed out: ${toolName}.`));
  }, timeoutMs);
  run.toolRequests.set(toolCallId, request);
  void dependencies.mirrorTool(run, request, 'pending');
  return promise;
}

export function waitForToolResult(
  dependencies: StoreToolDependencies,
  run: ServerRun,
  toolCallId: string,
  toolName: string,
  argsDigest: string,
  timeoutMs = SERVER_TOOL_RESULT_TIMEOUT_MS,
): Promise<unknown> {
  try {
    return registerToolRequest(dependencies, run, toolCallId, toolName, argsDigest, timeoutMs);
  } catch (error) {
    return Promise.reject(error);
  }
}

export function claimToolRequest(
  dependencies: Pick<StoreToolDependencies, 'isRunTerminal'>,
  run: ServerRun,
  input: { toolCallId: string; argsDigest: string; claimId: string },
): ToolClaimOutcome {
  const request = run.toolRequests.get(input.toolCallId);
  if (!request) return dependencies.isRunTerminal(run) ? 'run-settled' : 'unknown-call';
  if (request.argsDigest !== input.argsDigest) return 'mismatch';
  if (request.status !== 'pending') return 'run-settled';
  if (!request.claimId) {
    request.claimId = input.claimId;
    request.claimedAt = Date.now();
    return 'claimed';
  }
  return request.claimId === input.claimId ? 'duplicate' : 'already-claimed';
}

function validateToolSettlement(
  dependencies: StoreToolDependencies,
  run: ServerRun,
  input: SettleToolInput,
): ReadyToolSettlement | RejectedToolSettlement {
  const request = run.toolRequests.get(input.toolCallId);
  if (!request) return dependencies.isRunTerminal(run) ? 'run-settled' : 'unknown-call';
  if (request.argsDigest !== input.argsDigest) return 'mismatch';
  if (!request.claimId) return 'unclaimed';
  if (request.claimId !== input.claimId) return 'mismatch';
  const outcomeDigest = digestValue(
    input.error === undefined ? { result: input.result } : { error: input.error },
  );
  if (request.status === 'settled') {
    return request.outcomeDigest === outcomeDigest ? 'duplicate' : 'mismatch';
  }
  if (request.status !== 'pending' || dependencies.isRunTerminal(run)) return 'run-settled';
  return { request, outcomeDigest };
}

function transitionToolSettlement(
  request: ServerToolRequest,
  outcomeDigest: string,
): void {
  request.status = 'settled';
  clearTimeout(request.timeout);
  request.timeout = undefined;
  request.outcomeDigest = outcomeDigest;
}

function deliverToolSettlement(
  dependencies: StoreToolDependencies,
  run: ServerRun,
  request: ServerToolRequest,
  input: SettleToolInput,
): void {
  void dependencies.mirrorTool(
    run,
    request,
    input.error === undefined ? 'allowed' : 'denied',
  );
  const eventResult = input.error === undefined
    ? compactToolResultForModel(input.result)
    : undefined;
  try {
    dependencies.pushRunEvent(run, 'tool-result', {
      toolCallId: request.toolCallId,
      toolName: request.toolName,
      argsDigest: request.argsDigest,
      ...(input.error === undefined ? { result: eventResult } : { error: input.error }),
    });
  } catch {
    // Event-cap settlement is handled by the transport terminal queue.
  }
  if (input.error === undefined) request.resolve(input.result);
  else request.reject(new Error(input.error));
  releaseToolRequest(request);
}

export function settleToolResult(
  dependencies: StoreToolDependencies,
  run: ServerRun,
  input: SettleToolInput,
): ToolResultOutcome {
  const settled = normalizeToolSettlement(input);
  const validation = validateToolSettlement(dependencies, run, settled);
  if (typeof validation === 'string') return validation;
  transitionToolSettlement(validation.request, validation.outcomeDigest);
  deliverToolSettlement(dependencies, run, validation.request, settled);
  return 'accepted';
}
