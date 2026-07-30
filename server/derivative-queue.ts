const DEFAULT_DERIVATIVE_CONCURRENCY = 2;
export const MAX_DERIVATIVE_CONCURRENCY = 4;

export type DerivativeWork<T> = (signal: AbortSignal) => Promise<T>;

export interface DerivativeLease<T> {
  promise: Promise<T>;
  release: () => void;
}

type JobState = 'queued' | 'running' | 'done';

interface Job<T> {
  key: string;
  state: JobState;
  consumers: number;
  controller: AbortController;
  work: DerivativeWork<T>;
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

function configuredConcurrency(value = process.env.OPENCHATCUT_DERIVATIVE_CONCURRENCY): number {
  const parsed = Number.parseInt(value ?? '', 10);
  if (!Number.isFinite(parsed)) return DEFAULT_DERIVATIVE_CONCURRENCY;
  return Math.max(1, Math.min(MAX_DERIVATIVE_CONCURRENCY, parsed));
}

function cancellationError(): Error {
  const error = new Error('derivative request cancelled');
  error.name = 'AbortError';
  return error;
}

export class DerivativeQueue {
  readonly concurrency: number;
  private readonly jobs = new Map<string, Job<unknown>>();
  private readonly pending: Job<unknown>[] = [];
  private active = 0;

  constructor(concurrency = configuredConcurrency()) {
    const normalized = Number.isFinite(concurrency) ? Math.floor(concurrency) : DEFAULT_DERIVATIVE_CONCURRENCY;
    this.concurrency = Math.max(1, Math.min(MAX_DERIVATIVE_CONCURRENCY, normalized));
  }

  acquire<T>(key: string, work: DerivativeWork<T>): DerivativeLease<T> {
    const running = this.jobs.get(key) as Job<T> | undefined;
    if (running) {
      running.consumers += 1;
      return this.lease(running);
    }
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((ok, fail) => { resolve = ok; reject = fail; });
    const job: Job<T> = {
      key, state: 'queued', consumers: 1, controller: new AbortController(),
      work, promise, resolve, reject,
    };
    this.jobs.set(key, job as Job<unknown>);
    this.pending.push(job as Job<unknown>);
    this.pump();
    return this.lease(job);
  }

  private lease<T>(job: Job<T>): DerivativeLease<T> {
    let released = false;
    return {
      promise: job.promise,
      release: () => {
        if (released) return;
        released = true;
        this.release(job as Job<unknown>);
      },
    };
  }

  private release(job: Job<unknown>): void {
    job.consumers = Math.max(0, job.consumers - 1);
    if (job.consumers || job.state === 'done') return;
    if (job.state === 'running') {
      job.controller.abort();
      return;
    }
    const index = this.pending.indexOf(job);
    if (index >= 0) this.pending.splice(index, 1);
    job.state = 'done';
    if (this.jobs.get(job.key) === job) this.jobs.delete(job.key);
    job.reject(cancellationError());
  }

  private pump(): void {
    while (this.active < this.concurrency) {
      const job = this.pending.shift();
      if (!job) return;
      if (job.state !== 'queued') continue;
      this.start(job);
    }
  }

  private start(job: Job<unknown>): void {
    job.state = 'running';
    this.active += 1;
    void Promise.resolve()
      .then(() => job.work(job.controller.signal))
      .then(job.resolve, job.reject)
      .finally(() => {
        job.state = 'done';
        if (this.jobs.get(job.key) === job) this.jobs.delete(job.key);
        this.active -= 1;
        this.pump();
      });
  }
}

export const derivativeQueue = new DerivativeQueue();
