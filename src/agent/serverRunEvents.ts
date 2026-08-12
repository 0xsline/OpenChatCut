import type { DisplayMessage } from './agent-session';
import type { AgentContextUsage } from './context-compaction';
import type { ServerRunEventStream } from './serverRunFetchEventStream';

export type ServerRunTerminalStatus = 'awaiting_user' | 'completed' | 'failed' | 'cancelled';
export type ServerRunEventCommit = 'committed' | 'ignored' | 'failed';

interface ServerRunEventHandlers {
  readonly enabled: () => boolean;
  readonly ready: () => boolean;
  readonly commit: (event: Event) => ServerRunEventCommit;
  readonly commitTextDelta: (event: Event, delta: string) => ServerRunEventCommit;
  readonly ensureAssistantMessage: () => void;
  readonly handleToolRequest: (
    runId: string,
    toolCallId: string,
    name: string,
    args: Record<string, unknown>,
    argsDigest: string,
    admit: () => boolean,
  ) => Promise<boolean>;
  readonly retry: (runId: string) => void;
  readonly finish: (runId: string, status: ServerRunTerminalStatus) => void;
  readonly appendMessage: (message: DisplayMessage) => void;
  readonly onContextUsage: (usage: AgentContextUsage) => void;
  readonly transportError: (source: ServerRunEventStream, runId: string) => void;
  readonly persistenceError: (runId: string) => void;
  readonly opened: () => void;
}

/**
 * Browser-side tool execution scheduling for one run.
 *
 * Exclusive tools (mutable state) serialize against everything: each one
 * waits for the exclusive chain and for every in-flight parallel tool before
 * executing. Parallel tools (pure reads) only wait for the exclusive chain,
 * then execute concurrently with each other. The chain survives fetch-stream
 * reconnects per run.
 */
export class ServerRunToolRequestQueue {
  private readonly exclusiveTails = new Map<string, Promise<void>>();
  private readonly parallelFlights = new Map<string, Set<Promise<void>>>();

  enqueueExclusive<T>(runId: string, request: () => Promise<T>): Promise<T> {
    const previous = this.exclusiveTails.get(runId) ?? Promise.resolve();
    const pending = previous.then(async () => {
      const flights = this.parallelFlights.get(runId);
      if (flights) await Promise.all([...flights]);
      return request();
    });
    const tail = pending.then(() => undefined, () => undefined);
    this.exclusiveTails.set(runId, tail);
    void tail.then(() => {
      if (this.exclusiveTails.get(runId) === tail) this.exclusiveTails.delete(runId);
    });
    return pending;
  }

  enqueueParallel<T>(runId: string, request: () => Promise<T>): Promise<T> {
    const previous = this.exclusiveTails.get(runId);
    const pending = (previous ?? Promise.resolve()).then(request);
    const flight = pending.then(() => undefined, () => undefined);
    let group = this.parallelFlights.get(runId);
    if (!group) {
      group = new Set();
      this.parallelFlights.set(runId, group);
    }
    group.add(flight);
    void flight.then(() => {
      group.delete(flight);
      if (group.size === 0) this.parallelFlights.delete(runId);
    });
    return pending;
  }
}

function eventData(event: Event): unknown {
  if (!('data' in event) || typeof (event as MessageEvent).data !== 'string') return null;
  try {
    return JSON.parse((event as MessageEvent).data);
  } catch {
    return null;
  }
}

function objectRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function terminalStatus(value: unknown): ServerRunTerminalStatus {
  if (!objectRecord(value)) return 'completed';
  if (value.status === 'awaiting-user') return 'awaiting_user';
  return value.status === 'failed' || value.status === 'cancelled'
    ? value.status
    : 'completed';
}

function commitEvent(
  event: Event,
  handlers: ServerRunEventHandlers,
): ServerRunEventCommit {
  return handlers.enabled() ? handlers.commit(event) : 'ignored';
}

function handleCommit(
  outcome: ServerRunEventCommit,
  runId: string,
  handlers: ServerRunEventHandlers,
  committed?: () => void,
): void {
  if (outcome === 'failed') handlers.persistenceError(runId);
  else if (outcome === 'committed') committed?.();
}

function bindTextEvents(
  source: ServerRunEventStream,
  runId: string,
  handlers: ServerRunEventHandlers,
): void {
  source.addEventListener('text-start', (event) => {
    handleCommit(commitEvent(event, handlers), runId, handlers, handlers.ensureAssistantMessage);
  });
  source.addEventListener('text-delta', (event) => {
    const data = eventData(event);
    if (!objectRecord(data) || typeof data.text !== 'string') return;
    handleCommit(handlers.commitTextDelta(event, data.text), runId, handlers);
  });
}

function bindToolRequest(
  source: ServerRunEventStream,
  runId: string,
  handlers: ServerRunEventHandlers,
): void {
  source.addEventListener('tool-request', (event) => {
    if (!handlers.enabled()) return;
    if (!handlers.ready()) return handlers.retry(runId);
    const data = eventData(event);
    if (!objectRecord(data)
      || typeof data.toolCallId !== 'string'
      || typeof data.name !== 'string'
      || typeof data.argsDigest !== 'string'
      || !objectRecord(data.args)) return;
    const admit = (): boolean => {
      const outcome = commitEvent(event, handlers);
      handleCommit(outcome, runId, handlers);
      return outcome === 'committed';
    };
    void handlers.handleToolRequest(
      runId, data.toolCallId, data.name, data.args, data.argsDigest, admit,
    ).catch(() => handlers.persistenceError(runId));
  });
}

function bindCompletionEvents(
  source: ServerRunEventStream,
  runId: string,
  handlers: ServerRunEventHandlers,
): void {
  for (const type of ['text-end', 'tool-result', 'finish', 'status']) {
    source.addEventListener(type, (event) => {
      handleCommit(commitEvent(event, handlers), runId, handlers);
    });
  }
  source.addEventListener('done', (event) => {
    handleCommit(commitEvent(event, handlers), runId, handlers, () => {
      handlers.finish(runId, terminalStatus(eventData(event)));
    });
  });
  source.addEventListener('max-turns', (event) => {
    const data = eventData(event);
    if (!objectRecord(data) || typeof data.turns !== 'number') return;
    handleCommit(commitEvent(event, handlers), runId, handlers, () => {
      handlers.appendMessage({ role: 'continue', text: String(data.turns) });
    });
  });
}

function bindContextUsage(
  source: ServerRunEventStream,
  handlers: ServerRunEventHandlers,
): void {
  source.addEventListener('context-usage', (event) => {
    if (!handlers.enabled()) return;
    const data = eventData(event);
    if (!objectRecord(data) || !objectRecord(data.usage)) return;
    handlers.onContextUsage(data.usage as unknown as AgentContextUsage);
  });
}

function bindErrorEvent(
  source: ServerRunEventStream,
  runId: string,
  handlers: ServerRunEventHandlers,
): void {
  source.addEventListener('error', (event) => {
    if (!handlers.enabled()) return;
    const data = eventData(event);
    if (!objectRecord(data) || typeof data.message !== 'string') {
      handlers.transportError(source, runId);
      return;
    }
    handlers.appendMessage({ role: 'error', text: data.message });
    handleCommit(commitEvent(event, handlers), runId, handlers);
  });
}

/** Bind one fetch event stream to the durable run protocol with runtime payload checks. */
export function bindServerRunEvents(
  source: ServerRunEventStream,
  runId: string,
  handlers: ServerRunEventHandlers,
): void {
  bindTextEvents(source, runId, handlers);
  bindToolRequest(source, runId, handlers);
  bindCompletionEvents(source, runId, handlers);
  bindContextUsage(source, handlers);
  bindErrorEvent(source, runId, handlers);
  source.onopen = handlers.opened;
}
