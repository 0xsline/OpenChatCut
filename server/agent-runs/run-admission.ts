// Deferred run admission. `POST /` creates a run record but does not execute
// it: the browser must first open the event stream and then `POST /start`, so
// no tokens are spent on a run nobody is listening to. A run that is never
// admitted within the timeout is cancelled rather than left queued forever.
import { executeRun, type ServerRunInput } from './executor';
import { cancelRun } from './store';
import type { ServerRun } from './store-types';

const SERVER_RUN_ADMISSION_TIMEOUT_MS = 60_000;

interface DeferredRun {
  readonly input: ServerRunInput;
  readonly timeout: NodeJS.Timeout;
}

const deferredRuns = new Map<string, DeferredRun>();
const startedRuns = new Set<string>();

export function deferRunExecution(run: ServerRun, input: ServerRunInput): void {
  const timeout = setTimeout(() => {
    if (!deferredRuns.delete(run.id)) return;
    void cancelRun(run);
  }, SERVER_RUN_ADMISSION_TIMEOUT_MS);
  deferredRuns.set(run.id, { input, timeout });
}

export function startDeferredRun(run: ServerRun): 'started' | 'already_started' | 'unavailable' {
  const deferred = deferredRuns.get(run.id);
  if (!deferred) {
    return startedRuns.has(run.id) || run.status !== 'queued'
      ? 'already_started'
      : 'unavailable';
  }
  deferredRuns.delete(run.id);
  clearTimeout(deferred.timeout);
  startedRuns.add(run.id);
  void executeRun(run, deferred.input).finally(() => startedRuns.delete(run.id));
  return 'started';
}

export function discardDeferredRun(runId: string): void {
  const deferred = deferredRuns.get(runId);
  if (deferred) clearTimeout(deferred.timeout);
  deferredRuns.delete(runId);
}

/** Re-arm admission for a queued run recovered without an in-memory timer. */
export function ensureDeferredRunExecution(run: ServerRun, input: ServerRunInput): void {
  if (run.status !== 'queued' || deferredRuns.has(run.id) || startedRuns.has(run.id)) return;
  deferRunExecution(run, input);
}
