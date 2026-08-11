import { compactToolResultForModel } from '../../src/agent/tool-result-compaction';
import {
  MAX_SERVER_TOOL_REQUESTS,
  SERVER_TOOL_RESULT_TIMEOUT_MS,
  RunStoreLimitError,
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

type ReadyToolSettlement = {
  request: ServerToolRequest;
  outcomeDigest: string;
};

type RejectedToolSettlement = Exclude<ToolResultOutcome, 'accepted'>;

export async function rejectPendingTools(
  run: ServerRun,
  message: string,
  persist?: (request: ServerToolRequest) => Promise<void>,
): Promise<void> {
  const pending: ServerToolRequest[] = [];
  for (const request of run.toolRequests.values()) {
    if (request.status !== 'pending') continue;
    request.status = 'cancelled';
    if (request.timeout) {
      clearTimeout(request.timeout);
      request.timeout = undefined;
    }
    request.reject(new Error(message));
    pending.push(request);
  }
  if (persist) await Promise.all(pending.map(persist));
}

export function waitForToolResult(
  dependencies: StoreToolDependencies,
  run: ServerRun,
  toolCallId: string,
  toolName: string,
  argsDigest: string,
  timeoutMs = SERVER_TOOL_RESULT_TIMEOUT_MS,
): Promise<unknown> {
  if (dependencies.isRunTerminal(run)) {
    return Promise.reject(new Error('Agent run is already settled.'));
  }
  if (run.toolRequests.has(toolCallId)) {
    return Promise.reject(new Error(`Duplicate toolCallId: ${toolCallId}`));
  }
  if (run.toolRequests.size >= MAX_SERVER_TOOL_REQUESTS) {
    return Promise.reject(new RunStoreLimitError(
      `Agent tool request limit reached (${MAX_SERVER_TOOL_REQUESTS}).`,
    ));
  }
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
    request.timeout = undefined;
    void dependencies.mirrorTool(run, request, 'cancelled');
    reject(new Error(`Agent tool request timed out: ${toolName}.`));
  }, timeoutMs);
  run.toolRequests.set(toolCallId, request);
  void dependencies.mirrorTool(run, request, 'pending');
  return promise;
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
}

export function settleToolResult(
  dependencies: StoreToolDependencies,
  run: ServerRun,
  input: SettleToolInput,
): ToolResultOutcome {
  const validation = validateToolSettlement(dependencies, run, input);
  if (typeof validation === 'string') return validation;
  transitionToolSettlement(validation.request, validation.outcomeDigest);
  deliverToolSettlement(dependencies, run, validation.request, input);
  return 'accepted';
}
