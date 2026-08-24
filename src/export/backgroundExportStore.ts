import type {
  ExportEngineInfo,
  ExportEngineReason,
  ExportProgress,
  ExportQaUiState,
  RenderEngine,
  StateSetter,
} from './exportWorkflowTypes';
import {
  createExportFailure,
  exportFailureFrom,
  type ExportFailure,
} from './exportFailure';

export interface BackgroundExportJob {
  id: string;
  label: string;
  targetPath: string | null;
  createdAt: number;
  updatedAt: number;
  busy: string | null;
  clock: number;
  engineInfo: ExportEngineInfo | null;
  engineReason: ExportEngineReason;
  error: string | null;
  failure: ExportFailure | null;
  progress: ExportProgress;
  qa: ExportQaUiState | null;
  renderEngine: RenderEngine;
}

export interface BackgroundExportSnapshot {
  jobs: readonly BackgroundExportJob[];
}

export interface BackgroundExportJobSetters {
  setBusy: StateSetter<string | null>;
  setClock: StateSetter<number>;
  setEngineInfo: StateSetter<ExportEngineInfo | null>;
  setEngineReason: StateSetter<ExportEngineReason>;
  setError: StateSetter<string | null>;
  setFailure: StateSetter<ExportFailure | null>;
  setProgress: StateSetter<ExportProgress | null>;
  setQa: StateSetter<ExportQaUiState | null>;
  beginTargetCommit(): void;
  endTargetCommit(): void;
  markTargetCommitted(): void;
  setRenderEngine: StateSetter<RenderEngine>;
}

export interface BackgroundExportExecution {
  signal: AbortSignal;
  setters: BackgroundExportJobSetters;
}

export interface StartBackgroundExport {
  label: string;
  targetPath: string | null;
  execute(execution: BackgroundExportExecution): Promise<void>;
}
export interface RecoverBackgroundExport extends StartBackgroundExport {
  id: string;
  createdAt: number;
}


export interface ExportJobStore {
  getSnapshot(): BackgroundExportSnapshot;
  subscribe(listener: () => void): () => void;
  getActiveCount(): number;
  subscribeActive(listener: () => void): () => void;
  start(input: StartBackgroundExport): string;
  recover(input: RecoverBackgroundExport): boolean;
  cancel(jobId: string): boolean;
  clearTerminal(): void;
}

const TERMINAL_PHASE: Partial<Record<ExportProgress['phase'], true>> = {
  completed: true,
  failed: true,
  cancelled: true,
};
type StateUpdate<Value> = Value | ((value: Value) => Value);

function nextValue<Value>(current: Value, update: StateUpdate<Value>): Value {
  return typeof update === 'function'
    ? (update as (value: Value) => Value)(current)
    : update;
}

export function createExportJobStore(now: () => number = Date.now): ExportJobStore {
  let snapshot: BackgroundExportSnapshot = Object.freeze({ jobs: Object.freeze([]) });
  let activeCount = 0;
  const listeners = new Set<() => void>();
  const activeListeners = new Set<() => void>();
  const controllers = new Map<string, AbortController>();
  const committedJobs = new Set<string>();
  const committingJobs = new Set<string>();
  const cancelRequestedJobs = new Set<string>();

  const publish = (jobs: readonly BackgroundExportJob[]) => {
    const nextActiveCount = jobs.filter((job) => !TERMINAL_PHASE[job.progress.phase]).length;
    const activeCountChanged = nextActiveCount !== activeCount;
    activeCount = nextActiveCount;
    snapshot = Object.freeze({ jobs: Object.freeze(jobs) });
    for (const listener of listeners) listener();
    if (activeCountChanged) {
      for (const listener of activeListeners) listener();
    }
  };
  const update = (jobId: string, transform: (job: BackgroundExportJob) => BackgroundExportJob) => {
    const index = snapshot.jobs.findIndex((job) => job.id === jobId);
    if (index < 0) return;
    const current = snapshot.jobs[index];
    const changed = transform(current);
    if (changed === current) return;
    const jobs = [...snapshot.jobs];
    jobs[index] = Object.freeze({ ...changed, updatedAt: now() });
    publish(jobs);
  };
  const markCancelled = (jobId: string) => {
    const existing = snapshot.jobs.find((job) => job.id === jobId);
    if (!existing || TERMINAL_PHASE[existing.progress.phase]) return;
    const failure = createExportFailure({
      stage: 'cancel',
      code: 'export_cancelled',
      retryable: false,
      targetPath: existing.targetPath,
      message: '已取消导出',
    });
    update(jobId, (job) => ({
      ...job,
      busy: null,
      error: failure.message,
      failure,
      progress: { ...job.progress, phase: 'cancelled', finishedAt: now() },
    }));
  };
  const settersFor = (jobId: string): BackgroundExportJobSetters => ({
    beginTargetCommit: () => { committingJobs.add(jobId); },
    endTargetCommit: () => {
      committingJobs.delete(jobId);
      if (cancelRequestedJobs.delete(jobId)) markCancelled(jobId);
    },
    markTargetCommitted: () => {
      committingJobs.delete(jobId);
      cancelRequestedJobs.delete(jobId);
      committedJobs.add(jobId);
    },
    setBusy: (value) => update(jobId, (job) => ({ ...job, busy: nextValue(job.busy, value) })),
    setClock: (value) => update(jobId, (job) => ({ ...job, clock: nextValue(job.clock, value) })),
    setEngineInfo: (value) => update(jobId, (job) => ({ ...job, engineInfo: nextValue(job.engineInfo, value) })),
    setEngineReason: (value) => update(jobId, (job) => ({ ...job, engineReason: nextValue(job.engineReason, value) })),
    setError: (value) => update(jobId, (job) => ({ ...job, error: nextValue(job.error, value) })),
    setFailure: (value) => update(jobId, (job) => ({ ...job, failure: nextValue(job.failure, value) })),
    setProgress: (value) => update(jobId, (job) => {
      if (TERMINAL_PHASE[job.progress.phase]) return job;
      const next = nextValue<ExportProgress | null>(job.progress, value);
      return next ? { ...job, progress: next } : job;
    }),
    setQa: (value) => update(jobId, (job) => ({ ...job, qa: nextValue(job.qa, value) })),
    setRenderEngine: (value) => update(jobId, (job) => ({ ...job, renderEngine: nextValue(job.renderEngine, value) })),
  });
  const failUnexpectedly = (jobId: string, reason: unknown) => {
    const existing = snapshot.jobs.find((job) => job.id === jobId);
    if (!existing || TERMINAL_PHASE[existing.progress.phase]) return;
    const aborted = reason instanceof DOMException && reason.name === 'AbortError';
    const failure = exportFailureFrom(reason) ?? createExportFailure({
      stage: aborted ? 'cancel' : 'render',
      code: aborted ? 'export_cancelled' : 'unexpected_export_failure',
      retryable: !aborted,
      targetPath: existing.targetPath,
      message: aborted ? '已取消导出' : reason instanceof Error ? reason.message : String(reason),
    });
    update(jobId, (job) => ({
      ...job,
      busy: null,
      error: failure.message,
      failure,
      progress: {
        ...job.progress,
        phase: aborted ? 'cancelled' : 'failed',
        finishedAt: now(),
      },
    }));
  };

  const launch = (id: string, input: StartBackgroundExport, startedAt: number): boolean => {
    if (snapshot.jobs.some((job) => job.id === id)) return false;
    const job: BackgroundExportJob = Object.freeze({
      id,
      label: input.label,
      targetPath: input.targetPath,
      createdAt: startedAt,
      updatedAt: startedAt,
      busy: '等待导出…',
      clock: startedAt,
      engineInfo: null,
      engineReason: null,
      error: null,
      failure: null,
      progress: { phase: 'queued', percent: 0, startedAt } satisfies ExportProgress,
      qa: null,
      renderEngine: 'idle',
    });
    const controller = new AbortController();
    controllers.set(id, controller);
    publish([...snapshot.jobs, job]);
    void Promise.resolve()
      .then(() => input.execute({ signal: controller.signal, setters: settersFor(id) }))
      .catch((reason: unknown) => failUnexpectedly(id, reason))
      .finally(() => {
        controllers.delete(id);
        committedJobs.delete(id);
        committingJobs.delete(id);
        cancelRequestedJobs.delete(id);
      });
    return true;
  };

  return {
    getSnapshot: () => snapshot,
    getActiveCount: () => activeCount,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    subscribeActive(listener) {
      activeListeners.add(listener);
      return () => activeListeners.delete(listener);
    },
    start(input) {
      const existing = input.targetPath
        ? snapshot.jobs.find((job) => job.targetPath === input.targetPath && !TERMINAL_PHASE[job.progress.phase])
        : undefined;
      if (existing) return existing.id;
      const id = globalThis.crypto?.randomUUID?.() ?? `export-${now()}-${Math.random().toString(36).slice(2)}`;
      launch(id, input, now());
      return id;
    },
    recover(input) {
      return launch(input.id, input, input.createdAt);
    },
    cancel(jobId) {
      const controller = controllers.get(jobId);
      if (committedJobs.has(jobId)) return false;
      if (!controller || controller.signal.aborted) return false;
      controller.abort(new DOMException('Export cancelled', 'AbortError'));
      if (committingJobs.has(jobId)) {
        cancelRequestedJobs.add(jobId);
        return true;
      }
      markCancelled(jobId);
      return true;
    },
    clearTerminal() {
      publish(snapshot.jobs.filter((job) => !TERMINAL_PHASE[job.progress.phase]));
    },
  };
}

export function countActiveExportJobs(snapshot: BackgroundExportSnapshot): number {
  return snapshot.jobs.filter((job) => !TERMINAL_PHASE[job.progress.phase]).length;
}
