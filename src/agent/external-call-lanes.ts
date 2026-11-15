/**
 * Lane scheduling for external MCP calls executed by the editor bridge.
 *
 * The editor used to execute one external call at a time: a single hung tool
 * (a stuck import, a frame render that never settles) blocked every later call,
 * including the session-management tools an agent needs to recover. Calls now
 * run in lanes:
 *
 * - Session-management tools run immediately in their own lane, so an agent can
 *   always inspect, discard or recover its draft while another call is busy.
 * - Every other call is serialized per edit session (or in one shared lane when
 *   it carries no session), so draft mutations never interleave.
 */

/** Tools that only read or end edit-session state and must never queue behind a busy call. */
export const EXTERNAL_FAST_LANE_TOOLS: ReadonlySet<string> = new Set([
  'begin_edit_session',
  'get_edit_session',
  'list_edit_sessions',
  'discard_edit_session',
  'recover_edit_session',
]);

export interface LaneCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

/** The lane key for a call; `null` means it runs immediately without queueing. */
export function externalCallLane(call: LaneCall): string | null {
  if (EXTERNAL_FAST_LANE_TOOLS.has(call.name)) return null;
  const sessionId = call.arguments.editSessionId;
  return typeof sessionId === 'string' && sessionId ? `session:${sessionId}` : 'shared';
}

/** Runs tasks concurrently across lanes and strictly in order within a lane. */
export class ExternalCallLanes {
  private readonly tails = new Map<string, Promise<void>>();
  private readonly running = new Set<Promise<void>>();

  run(lane: string | null, task: () => Promise<void>): Promise<void> {
    const previous = lane ? this.tails.get(lane) : undefined;
    const settled = (previous ?? Promise.resolve()).catch(() => undefined).then(task);
    const tracked = settled.finally(() => {
      this.running.delete(tracked);
      if (lane && this.tails.get(lane) === tail) this.tails.delete(lane);
    });
    const tail = tracked.catch(() => undefined);
    if (lane) this.tails.set(lane, tail);
    this.running.add(tracked);
    return tracked;
  }

  /** Number of tasks queued or running, for tests and diagnostics. */
  get size(): number {
    return this.running.size;
  }

  /** Waits for every task started so far to settle. */
  async drain(): Promise<void> {
    await Promise.allSettled([...this.running]);
  }
}

/**
 * Resolves with the task, or rejects as soon as `signal` aborts even when the
 * task itself ignores the signal. A late task result is discarded by the
 * caller's own cancellation checks; this only frees the lane.
 */
export function raceAbort<T>(task: Promise<T>, signal: AbortSignal, onAbort: () => Error): Promise<T> {
  if (signal.aborted) {
    task.catch(() => undefined);
    return Promise.reject(onAbort());
  }
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(onAbort());
    signal.addEventListener('abort', abort, { once: true });
    task.then(
      (value) => { signal.removeEventListener('abort', abort); resolve(value); },
      (error: unknown) => { signal.removeEventListener('abort', abort); reject(error); },
    );
  });
}
