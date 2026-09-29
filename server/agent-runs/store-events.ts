import {
  appendAgentRunEvent,
  patchAgentRun,
  upsertAgentApproval,
  type AgentRunContext,
  type AgentRunStatus,
} from '../../src/persist/agentRuntimeStore';
import {
  MAX_SERVER_EVENT_BYTES,
  MAX_SERVER_RUN_BYTES,
  MAX_SERVER_TOOL_REQUEST_EVENT_BYTES,
  MAX_SERVER_RUN_EVENTS,
  MAX_SERVER_RUN_EVENTS_HARD,
  RunStoreLimitError,
  type ServerRun,
  type ServerRunEvent,
  type ServerRunStatus,
  type ServerToolRequest,
} from './store-types';
import { eventBytes, runtimeEvent } from './store-values';
import { rejectPendingTools } from './store-tools';

export interface StoreEventDependencies {
  mirror: (run: ServerRun, work: () => Promise<void>) => Promise<void>;
  flushRunPersistence: (run: ServerRun) => Promise<void>;
  isRunTerminal: (run: ServerRun) => boolean;
  pruneRuns: () => void;
}

export function wakeSubscribers(run: ServerRun): void {
  for (const waiter of [...run.waiters]) waiter();
}

export function updateRuntimeContext(
  run: ServerRun,
  patch: Partial<AgentRunContext>,
): AgentRunContext {
  run.runtimeContext = { ...run.runtimeContext, ...patch };
  return run.runtimeContext;
}

function runtimeStatus(status: ServerRunStatus): AgentRunStatus {
  if (status === 'awaiting-confirmation') return 'waiting_approval';
  return status === 'awaiting-user' ? 'awaiting_user' : 'running';
}

function updateReplayStart(run: ServerRun): void {
  run.replayStart = run.events[0]?.id ?? ((run.events.at(-1)?.id ?? 0) + 1);
}

function dropOldest(run: ServerRun): void {
  const removed = run.events.shift();
  if (removed) {
    run.retainedEventBytes = Math.max(0, run.retainedEventBytes - eventBytes(removed));
  }
  updateReplayStart(run);
}

/** Events that may roll off the replay window of a long-running run. */
const ROLLABLE_EVENT: ReadonlySet<string> = new Set([
  'diagnostic',
  'configured',
  'text-start',
  'text-delta',
  'thinking-delta',
  'text-end',
  'context-usage',
]);

/**
 * Long runs (no turn cap) would otherwise die on the event count/byte caps.
 * Make room by dropping the oldest rollable events; requests, results,
 * status, retries and terminal events always stay.
 */
function dropRollableForSpace(
  run: ServerRun,
  incomingBytes: number,
): void {
  let guard = run.events.length + 1;
  while (guard > 0
    && (run.events.length + 1 > MAX_SERVER_RUN_EVENTS
      || run.retainedEventBytes + incomingBytes > MAX_SERVER_RUN_BYTES)) {
    guard -= 1;
    const index = run.events.findIndex((event) => ROLLABLE_EVENT.has(event.type));
    if (index < 0) break;
    const [removed] = run.events.splice(index, 1);
    run.retainedEventBytes = Math.max(0, run.retainedEventBytes - eventBytes(removed!));
  }
  updateReplayStart(run);
}

function eventToolCallId(event: ServerRunEvent): string | undefined {
  const data = event.data;
  if (data === null || typeof data !== 'object') return undefined;
  const id = (data as { toolCallId?: unknown }).toolCallId;
  return typeof id === 'string' ? id : undefined;
}

function overHardCeiling(run: ServerRun, incomingEvents: number, incomingBytes: number): boolean {
  return run.events.length + incomingEvents > MAX_SERVER_RUN_EVENTS_HARD
    || run.retainedEventBytes + incomingBytes > MAX_SERVER_RUN_BYTES * 4;
}

function finishedToolEvent(run: ServerRun, event: ServerRunEvent): boolean {
  if (event.type === 'tool-result') return true;
  if (event.type !== 'tool-request') return false;
  const id = eventToolCallId(event);
  return id === undefined || run.toolRequests.get(id)?.status !== 'pending';
}

function removeEventAt(run: ServerRun, index: number): ServerRunEvent | undefined {
  const [removed] = run.events.splice(index, 1);
  if (removed) run.retainedEventBytes = Math.max(0, run.retainedEventBytes - eventBytes(removed));
  return removed;
}

/**
 * Every tool call adds a request and a result that never roll off, so a long
 * turn used to reach the hard ceiling and fail. Retire the oldest finished
 * calls instead, a request together with its result; the persisted log and
 * the run's draft artifacts still hold them. Requests the browser may still
 * claim stay, and so does the first event, which anchors the replay window:
 * a reconnect skips the retired calls instead of finding its cursor gone.
 */
function retireFinishedToolCalls(run: ServerRun, incomingEvents: number, incomingBytes: number): void {
  while (overHardCeiling(run, incomingEvents, incomingBytes)) {
    const index = run.events.findIndex((event, position) => position > 0 && finishedToolEvent(run, event));
    if (index < 0) return;
    const retired = removeEventAt(run, index);
    const id = retired?.type === 'tool-request' ? eventToolCallId(retired) : undefined;
    if (id === undefined) continue;
    const result = run.events.findIndex((event) => event.type === 'tool-result' && eventToolCallId(event) === id);
    if (result >= 0) removeEventAt(run, result);
  }
}

function appendEvent(
  dependencies: StoreEventDependencies,
  run: ServerRun,
  type: string,
  data: unknown,
): Promise<void> {
  const event = { id: run.eventCursor + 1, type, data, at: Date.now() };
  const bytes = eventBytes(event);
  const maxBytes = type === 'tool-request'
    ? MAX_SERVER_TOOL_REQUEST_EVENT_BYTES
    : MAX_SERVER_EVENT_BYTES;
  if (bytes > maxBytes) {
    throw new RunStoreLimitError(`Agent run event exceeds ${maxBytes} bytes.`);
  }
  if (
    run.events.length + 1 > MAX_SERVER_RUN_EVENTS
    || run.retainedEventBytes + bytes > MAX_SERVER_RUN_BYTES
  ) {
    dropRollableForSpace(run, bytes);
  }
  retireFinishedToolCalls(run, 1, bytes);
  run.eventCursor = event.id;
  run.pendingEventCount += 1;
  run.pendingEventBytes += bytes;
  return dependencies.mirror(run, async () => {
    try {
      await appendAgentRunEvent(run.projectId, run.id, runtimeEvent(event));
      run.retainedEventBytes += bytes;
      run.events.push(event);
      // In-flight mirrors from a synchronous burst settle one by one; roll
      // the window again after each commit so bursts cannot overflow it.
      while (run.events.length > MAX_SERVER_RUN_EVENTS
        || run.retainedEventBytes > MAX_SERVER_RUN_BYTES) {
        const index = run.events.findIndex((item) => ROLLABLE_EVENT.has(item.type));
        if (index < 0) break;
        const [removed] = run.events.splice(index, 1);
        run.retainedEventBytes = Math.max(0, run.retainedEventBytes - eventBytes(removed!));
      }
      retireFinishedToolCalls(run, 0, 0);
      updateReplayStart(run);
      wakeSubscribers(run);
    } finally {
      run.pendingEventCount = Math.max(0, run.pendingEventCount - 1);
      run.pendingEventBytes = Math.max(0, run.pendingEventBytes - bytes);
    }
  });
}

async function mirrorStatus(
  dependencies: StoreEventDependencies,
  run: ServerRun,
): Promise<void> {
  updateRuntimeContext(run, {
    transportStatus: run.status,
    transportError: run.error,
  });
  await dependencies.mirror(run, async () => {
    await patchAgentRun(run.projectId, run.id, {
      status: runtimeStatus(run.status),
      context: run.runtimeContext,
    });
  });
}

export function mirrorTool(
  dependencies: Pick<StoreEventDependencies, 'mirror'>,
  run: ServerRun,
  request: ServerToolRequest,
  status: 'pending' | 'allowed' | 'denied' | 'cancelled',
): Promise<void> {
  return dependencies.mirror(run, async () => {
    await upsertAgentApproval({
      version: 1,
      approvalId: `${run.id}-${request.toolCallId}`,
      projectId: run.projectId,
      runId: run.id,
      toolCallId: request.toolCallId,
      toolName: request.toolName,
      argsDigest: request.argsDigest,
      // Each tool call is its own operation. Without an id, two identical
      // calls in one step read as one approval pending twice, and the second
      // mirror fails the run.
      operationId: request.toolCallId,
      status,
      createdAt: run.createdAt,
      ...(status !== 'pending' ? { decidedAt: Date.now() } : {}),
    });
  });
}

async function appendTerminalEvents(
  dependencies: StoreEventDependencies,
  run: ServerRun,
  status: Extract<ServerRunStatus, 'awaiting-user' | 'completed' | 'failed' | 'cancelled'>,
): Promise<void> {
  if (run.terminalPromise) return run.terminalPromise;
  const settle = async (): Promise<void> => {
    await rejectPendingTools(
      run,
      `Agent run ${status}.`,
      (request) => mirrorTool(dependencies, run, request, 'cancelled'),
    );
    await dependencies.flushRunPersistence(run);
    const terminalBytes = eventBytes({
      id: run.eventCursor + 1,
      type: 'status',
      data: { status, error: run.error },
      at: Date.now(),
    }) + eventBytes({
      id: run.eventCursor + 2,
      type: 'done',
      data: { status, error: run.error },
      at: Date.now(),
    });
    while (
      run.events.length > MAX_SERVER_RUN_EVENTS - 2
      || run.retainedEventBytes + terminalBytes > MAX_SERVER_RUN_BYTES
    ) {
      dropOldest(run);
    }
    await appendEvent(dependencies, run, 'status', { status, error: run.error });
    updateRuntimeContext(run, {
      transportStatus: status,
      transportError: run.error,
    });
    await dependencies.mirror(run, async () => {
      await patchAgentRun(run.projectId, run.id, { context: run.runtimeContext });
    });
    await appendEvent(dependencies, run, 'done', { status, error: run.error });
    run.status = status;
    wakeSubscribers(run);
    dependencies.pruneRuns();
  };
  run.terminalPromise = settle();
  void run.terminalPromise.catch(() => undefined);
  return run.terminalPromise;
}

export function pushRunEvent(
  dependencies: StoreEventDependencies,
  run: ServerRun,
  type: string,
  data: unknown,
): void {
  if (dependencies.isRunTerminal(run) || run.terminalPromise) return;
  try {
    void appendEvent(dependencies, run, type, data);
  } catch (error) {
    run.error = error instanceof Error ? error.message : String(error);
    run.abort?.abort(error);
    void appendTerminalEvents(dependencies, run, 'failed').catch(() => undefined);
    throw error;
  }
}

export async function setRunStatus(
  dependencies: StoreEventDependencies,
  run: ServerRun,
  status: ServerRunStatus,
): Promise<void> {
  if (dependencies.isRunTerminal(run)) return;
  if (status === 'awaiting-user' || status === 'completed'
    || status === 'failed' || status === 'cancelled') {
    await appendTerminalEvents(dependencies, run, status);
    return;
  }
  if (run.status === status) return;
  run.status = status;
  pushRunEvent(dependencies, run, 'status', { status });
  await mirrorStatus(dependencies, run);
}

export function waitForRunEvents(
  dependencies: Pick<StoreEventDependencies, 'isRunTerminal'>,
  run: ServerRun,
  afterId: number,
  signal?: AbortSignal,
): Promise<void> {
  if (
    dependencies.isRunTerminal(run)
    || (run.events.at(-1)?.id ?? 0) > afterId
    || signal?.aborted
  ) {
    return Promise.resolve();
  }
  const { promise, resolve } = Promise.withResolvers<void>();
  const finish = (): void => {
    run.waiters.delete(notify);
    signal?.removeEventListener('abort', notify);
    resolve();
  };
  const notify = (): void => {
    if (
      dependencies.isRunTerminal(run)
      || (run.events.at(-1)?.id ?? 0) > afterId
      || signal?.aborted
    ) {
      finish();
    }
  };
  run.waiters.add(notify);
  signal?.addEventListener('abort', notify, { once: true });
  return promise;
}

export async function cancelRun(
  dependencies: StoreEventDependencies,
  run: ServerRun,
): Promise<void> {
  if (dependencies.isRunTerminal(run)) return;
  if (run.terminalPromise) {
    await run.terminalPromise;
    return;
  }
  run.error = 'Agent run cancelled.';
  run.abort?.abort(new Error(run.error));
  await appendTerminalEvents(dependencies, run, 'cancelled');
}
