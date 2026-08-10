import { randomUUID } from 'node:crypto';

export type ServerRunStatus =
  | 'queued'
  | 'running'
  | 'awaiting-confirmation'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface ServerRunEvent {
  id: number;
  type: string;
  data: unknown;
  at: number;
}

export interface ServerRun {
  id: string;
  projectId: string;
  provider: string;
  model: string;
  status: ServerRunStatus;
  createdAt: number;
  events: ServerRunEvent[];
  error: string | null;
  /** Abort controller for the active LLM stream. */
  abort?: AbortController;
  /** Subscribers waiting on new events (SSE). */
  waiters: Set<() => void>;
  /** Incremented on every event batch so subscribers can dedupe. */
  eventCursor: number;
}

const runs = new Map<string, ServerRun>();

export function createRun(input: {
  projectId: string;
  provider: string;
  model: string;
}): ServerRun {
  const run: ServerRun = {
    id: randomUUID(),
    projectId: input.projectId,
    provider: input.provider,
    model: input.model,
    status: 'queued',
    createdAt: Date.now(),
    events: [],
    error: null,
    waiters: new Set(),
    eventCursor: 0,
  };
  runs.set(run.id, run);
  return run;
}

export function getRun(id: string): ServerRun | undefined {
  return runs.get(id);
}

export function pushRunEvent(run: ServerRun, type: string, data: unknown): void {
  run.events.push({ id: ++run.eventCursor, type, data, at: Date.now() });
  for (const waiter of run.waiters) waiter();
}

export function setRunStatus(run: ServerRun, status: ServerRunStatus): void {
  run.status = status;
  pushRunEvent(run, 'status', { status });
}

/** Wait until the run has events past `afterId`, or it settles. */
export function waitForRunEvents(run: ServerRun, afterId: number): Promise<void> {
  const settled = run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled';
  if (settled || run.eventCursor > afterId) return Promise.resolve();
  return new Promise((resolve) => {
    const waiter = (): void => {
      run.waiters.delete(waiter);
      resolve();
    };
    run.waiters.add(waiter);
  });
}

export function cancelRun(run: ServerRun): void {
  run.abort?.abort();
  if (run.status === 'queued' || run.status === 'running') setRunStatus(run, 'cancelled');
}

/** Runs older than the retention window are dropped from memory. */
export function pruneRuns(retentionMs = 30 * 60 * 1_000): void {
  const cutoff = Date.now() - retentionMs;
  for (const [id, run] of runs) {
    if (run.createdAt < cutoff) runs.delete(id);
  }
}
