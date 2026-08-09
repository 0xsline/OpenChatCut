// Shared bounded admission with per-target serialization and abortable queue waits.
export const NORMALIZE_CONCURRENCY = 2;
export const NORMALIZE_MAX_QUEUED = 8;

export type ReleaseNormalizePermit = () => void;

export interface NormalizeAdmission {
  acquire: (key: string, signal?: AbortSignal) => Promise<ReleaseNormalizePermit>;
  snapshot: () => { active: number; queued: number };
}

interface WaitingNormalizePermit {
  key: string;
  resolve: (release: ReleaseNormalizePermit) => void;
  reject: (error: unknown) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

export class NormalizeAdmissionFullError extends Error {
  constructor() {
    super('media normalization queue is full');
    this.name = 'NormalizeAdmissionFullError';
  }
}

export function normalizationAbortError(signal?: AbortSignal): Error {
  if (signal?.reason instanceof Error) return signal.reason;
  return new DOMException('media normalization was cancelled', 'AbortError');
}

export function throwIfNormalizationAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw normalizationAbortError(signal);
}

function validateAdmissionLimits(concurrency: number, maxQueued: number): void {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new RangeError('normalize concurrency must be a positive integer');
  }
  if (!Number.isInteger(maxQueued) || maxQueued < 0) {
    throw new RangeError('normalize queue limit must be a non-negative integer');
  }
}


class NormalizeAdmissionQueue implements NormalizeAdmission {
  private active = 0;
  private readonly activeKeys = new Set<string>();
  private readonly waiting: WaitingNormalizePermit[] = [];
  private readonly concurrency: number;
  private readonly maxQueued: number;

  constructor(concurrency: number, maxQueued: number) {
    this.concurrency = concurrency;
    this.maxQueued = maxQueued;
  }

  acquire(key: string, signal?: AbortSignal): Promise<ReleaseNormalizePermit> {
    try {
      throwIfNormalizationAborted(signal);
    } catch (error) {
      return Promise.reject(error);
    }
    if (this.active < this.concurrency && !this.activeKeys.has(key)) {
      this.active += 1;
      this.activeKeys.add(key);
      return Promise.resolve(this.releaseOnce(key));
    }
    if (this.waiting.length >= this.maxQueued) {
      return Promise.reject(new NormalizeAdmissionFullError());
    }
    const deferred = Promise.withResolvers<ReleaseNormalizePermit>();
    const entry: WaitingNormalizePermit = {
      key,
      resolve: deferred.resolve,
      reject: deferred.reject,
      ...(signal ? { signal } : {}),
    };
    entry.onAbort = () => {
      signal?.removeEventListener('abort', entry.onAbort!);
      const index = this.waiting.indexOf(entry);
      if (index >= 0) this.waiting.splice(index, 1);
      entry.reject(normalizationAbortError(signal));
    };
    this.waiting.push(entry);
    signal?.addEventListener('abort', entry.onAbort, { once: true });
    if (signal?.aborted) entry.onAbort();
    return deferred.promise;
  }

  snapshot(): { active: number; queued: number } {
    return { active: this.active, queued: this.waiting.length };
  }

  private drain(): void {
    while (this.active < this.concurrency) {
      const index = this.waiting.findIndex(({ key }) => !this.activeKeys.has(key));
      if (index < 0) return;
      const [next] = this.waiting.splice(index, 1);
      if (next.signal && next.onAbort) next.signal.removeEventListener('abort', next.onAbort);
      this.active += 1;
      this.activeKeys.add(next.key);
      next.resolve(this.releaseOnce(next.key));
    }
  }

  private releaseOnce(key: string): ReleaseNormalizePermit {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active -= 1;
      this.activeKeys.delete(key);
      this.drain();
    };
  }
}

export function createNormalizeAdmission(
  concurrency = NORMALIZE_CONCURRENCY,
  maxQueued = NORMALIZE_MAX_QUEUED,
): NormalizeAdmission {
  validateAdmissionLimits(concurrency, maxQueued);
  return new NormalizeAdmissionQueue(concurrency, maxQueued);
}
