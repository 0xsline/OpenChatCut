import { areModelPacksInstalled } from '../../../shared/model-packs';
import {
  CLAP_EMBEDDING_DIMENSION,
  CLAP_SAMPLE_RATE,
  type ClapBackend,
  type ClapWorkerRequest,
  type ClapWorkerResponse,
  type ClapWorkerResult,
} from './clapTypes';
import { resampleMonoSamples } from './audioDecode';

const DEFAULT_LOAD_TIMEOUT_MS = 3 * 60_000;
const MIN_EMBED_TIMEOUT_MS = 60_000;
const MAX_EMBED_TIMEOUT_MS = 15 * 60_000;
const WINDOW_SECONDS = 10;
const WINDOW_STEP_SECONDS = 8;
// Whole-track labels need representative coverage, not exhaustive segment retrieval.
const MAX_REPRESENTATIVE_WINDOWS = 24;
const SEMANTIC_PACK_ID = 'music-semantics-lite' as const;

export type ClapProgressListener = (progress: number) => void;
export type ClapWorkerFactory = () => Worker;
export type ClapPackChecker = (ids: readonly [typeof SEMANTIC_PACK_ID]) => Promise<boolean>;

export interface ClapClientOptions {
  createWorker?: ClapWorkerFactory;
  arePacksInstalled?: ClapPackChecker;
  loadTimeoutMs?: number;
  embedTimeoutMs?: number;
}

interface PendingWorkerRequest {
  resolve: (result: ClapWorkerResult) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  settled: boolean;
  cleanup?: () => void;
}
function abortError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  const error = new Error(signal.reason === undefined ? 'CLAP analysis aborted' : String(signal.reason));
  error.name = 'AbortError';
  return error;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError(signal);
}



export class ClapClient {
  private readonly createWorker: ClapWorkerFactory;
  private readonly checkPacks: ClapPackChecker;
  private readonly loadTimeoutMs: number;
  private readonly embedTimeoutMs?: number;

  constructor(options: ClapClientOptions = {}) {
    this.createWorker = options.createWorker ?? createClapWorker;
    this.checkPacks = options.arePacksInstalled ?? areModelPacksInstalled;
    this.loadTimeoutMs = positiveTimeout(options.loadTimeoutMs, DEFAULT_LOAD_TIMEOUT_MS);
    this.embedTimeoutMs = options.embedTimeoutMs === undefined
      ? undefined
      : positiveTimeout(options.embedTimeoutMs, MIN_EMBED_TIMEOUT_MS);
  }

  async embed(
    samples: Float32Array,
    sampleRate: number,
    onProgress?: ClapProgressListener,
    signal?: AbortSignal,
  ): Promise<number[]> {
    validateInput(samples, sampleRate);
    throwIfAborted(signal);
    if (!await this.checkPacks([SEMANTIC_PACK_ID])) {
      throw new Error('CLAP model pack music-semantics-lite is not installed');
    }
    throwIfAborted(signal);
    let completedProgress = 0;
    const reportProgress = onProgress ? (progress: number) => {
      completedProgress = Math.max(completedProgress, progress);
      onProgress(completedProgress);
    } : undefined;
    let webGpuError: unknown;
    try {
      return await this.runAttempt('webgpu', samples, sampleRate, reportProgress, signal);
    } catch (reason) {
      throwIfAborted(signal);
      webGpuError = reason;
    }
    try {
      return await this.runAttempt('wasm', samples, sampleRate, reportProgress, signal);
    } catch (wasmError) {
      throwIfAborted(signal);
      throw new AggregateError([webGpuError, wasmError], 'CLAP failed on WebGPU and WASM');
    }
  }

  private async runAttempt(
    backend: ClapBackend,
    samples: Float32Array,
    sampleRate: number,
    onProgress?: ClapProgressListener,
    signal?: AbortSignal,
  ): Promise<number[]> {
    const worker = this.createWorker();
    try {
      const loaded = await requestWorker(
        worker,
        { id: 1, type: 'load', backend },
        this.loadTimeoutMs,
        onProgress,
        [],
        signal,
      );
      if (loaded.type !== 'loaded') throw new Error('CLAP worker returned an unexpected load result');
      throwIfAborted(signal);
      return await embedWindows(
        worker,
        samples,
        sampleRate,
        this.embedTimeoutMs ?? Math.min(MAX_EMBED_TIMEOUT_MS, MIN_EMBED_TIMEOUT_MS + 20_000),
        onProgress,
        signal,
      );
    } finally {
      worker.terminate();
    }
  }
}

export async function embedMusicAudio(
  samples: Float32Array,
  sampleRate: number,
  onProgress?: ClapProgressListener,
  signal?: AbortSignal,
): Promise<number[]> {
  return new ClapClient().embed(samples, sampleRate, onProgress, signal);
}

function createClapWorker(): Worker {
  return new Worker(new URL('./clap.worker.ts', import.meta.url), { type: 'module' });
}

function positiveTimeout(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value <= 0) throw new Error('CLAP timeout must be a positive number');
  return value;
}

function sourceWindowStarts(sampleCount: number, sampleRate: number): number[] {
  const windowSamples = sampleRate * WINDOW_SECONDS;
  const stepSamples = sampleRate * WINDOW_STEP_SECONDS;
  const candidates = [0];
  while (candidates[candidates.length - 1]! + windowSamples < sampleCount) {
    candidates.push(candidates[candidates.length - 1]! + stepSamples);
  }
  return uniformlySelectStarts(candidates);
}

function uniformlySelectStarts(candidates: readonly number[]): number[] {
  if (candidates.length <= MAX_REPRESENTATIVE_WINDOWS) return [...candidates];
  const lastIndex = candidates.length - 1;
  return Array.from(
    { length: MAX_REPRESENTATIVE_WINDOWS },
    (_, index) => candidates[Math.round((index * lastIndex) / (MAX_REPRESENTATIVE_WINDOWS - 1))]!,
  );
}

function normalizedMean(sum: Float64Array, count: number): number[] {
  const mean = Array.from(sum, (value) => value / count);
  const norm = Math.hypot(...mean);
  if (!Number.isFinite(norm) || norm <= Number.EPSILON) throw new Error('CLAP returned a zero mean embedding');
  return validateEmbedding(mean.map((value) => value / norm));
}

async function embedWindows(
  worker: Worker,
  samples: Float32Array,
  sampleRate: number,
  timeoutMs: number,
  onProgress?: ClapProgressListener,
  signal?: AbortSignal,
): Promise<number[]> {
  const starts = sourceWindowStarts(samples.length, sampleRate);
  const sum = new Float64Array(CLAP_EMBEDDING_DIMENSION);
  for (let index = 0; index < starts.length; index += 1) {
    throwIfAborted(signal);
    const source = samples.slice(starts[index], starts[index]! + sampleRate * WINDOW_SECONDS);
    const owned = await resampleMonoSamples(source, sampleRate, CLAP_SAMPLE_RATE);
    const result = await requestWorker(
      worker,
      { id: index + 2, type: 'embed', samples: owned, sampleRate: CLAP_SAMPLE_RATE },
      timeoutMs,
      (progress) => onProgress?.((index + progress) / starts.length),
      [owned.buffer],
      signal,
    );
    if (result.type !== 'embedding') throw new Error('CLAP worker returned no embedding');
    const vector = validateEmbedding(result.vector);
    for (let dimension = 0; dimension < sum.length; dimension += 1) sum[dimension] += vector[dimension]!;
  }
  return normalizedMean(sum, starts.length);
}

function validateInput(samples: Float32Array, sampleRate: number): void {
  if (!(samples instanceof Float32Array) || samples.length === 0) {
    throw new Error('CLAP audio samples must be a non-empty Float32Array');
  }
  if (!Number.isInteger(sampleRate) || sampleRate < 8_000 || sampleRate > 192_000) {
    throw new Error(`Invalid CLAP sample rate: ${sampleRate}`);
  }
  for (const sample of samples) {
    if (!Number.isFinite(sample)) throw new Error('CLAP audio samples contain non-finite values');
  }
}

function requestWorker(
  worker: Worker,
  request: ClapWorkerRequest,
  timeoutMs: number,
  onProgress?: ClapProgressListener,
  transfer: Transferable[] = [],
  signal?: AbortSignal,
): Promise<ClapWorkerResult> {
  const { promise, resolve, reject } = Promise.withResolvers<ClapWorkerResult>();
  const pending: PendingWorkerRequest = {
    resolve,
    reject,
    timer: setTimeout(
      () => settlePending(pending, new Error(`CLAP ${request.type} timed out after ${timeoutMs}ms`)),
      timeoutMs,
    ),
    settled: false,
  };
  const onAbort = () => settlePending(pending, abortError(signal!));
  pending.cleanup = () => signal?.removeEventListener('abort', onAbort);
  if (signal?.aborted) {
    onAbort();
    return promise;
  }
  signal?.addEventListener('abort', onAbort, { once: true });
  worker.onmessage = (event: MessageEvent<unknown>) => {
    try {
      handleWorkerMessage(event.data, request.id, pending, onProgress);
    } catch (reason) {
      settlePending(pending, reason instanceof Error ? reason : new Error(String(reason)));
    }
  };
  worker.onerror = (event) => settlePending(pending, new Error(event.message || 'CLAP worker failed'));
  try {
    worker.postMessage(request, transfer);
  } catch (reason) {
    settlePending(pending, reason instanceof Error ? reason : new Error(String(reason)));
  }
  return promise;
}

function handleWorkerMessage(
  value: unknown,
  requestId: number,
  pending: PendingWorkerRequest,
  onProgress?: ClapProgressListener,
): void {
  const response = validateWorkerResponse(value);
  if (response.id !== requestId) return;
  if (response.type === 'progress') {
    onProgress?.(response.progress);
    return;
  }
  if (response.type === 'error') settlePending(pending, new Error(response.message));
  else settlePending(pending, undefined, response.result);
}

function settlePending(
  pending: PendingWorkerRequest,
  error?: Error,
  result?: ClapWorkerResult,
): void {
  if (pending.settled) return;
  pending.settled = true;
  pending.cleanup?.();
  clearTimeout(pending.timer);
  if (error) pending.reject(error);
  else if (result) pending.resolve(result);
  else pending.reject(new Error('CLAP worker returned no result'));
}

function validateWorkerResponse(value: unknown): ClapWorkerResponse {
  if (!value || typeof value !== 'object') throw new Error('CLAP worker returned an invalid response');
  const response = value as Record<string, unknown>;
  if (!Number.isSafeInteger(response.id)) throw new Error('CLAP worker returned an invalid request id');
  if (response.type === 'error' && typeof response.message === 'string') return response as ClapWorkerResponse;
  if (response.type === 'progress' && typeof response.progress === 'number'
    && Number.isFinite(response.progress) && response.progress >= 0 && response.progress <= 1) {
    return response as ClapWorkerResponse;
  }
  if (response.type === 'result' && isWorkerResult(response.result)) return response as ClapWorkerResponse;
  throw new Error('CLAP worker returned an invalid response payload');
}

function isWorkerResult(value: unknown): value is ClapWorkerResult {
  if (!value || typeof value !== 'object') return false;
  const result = value as Record<string, unknown>;
  if (result.type === 'loaded') return true;
  return result.type === 'embedding' && Array.isArray(result.vector)
    && result.vector.every((entry) => typeof entry === 'number' && Number.isFinite(entry));
}

function validateEmbedding(vector: number[]): number[] {
  if (vector.length !== CLAP_EMBEDDING_DIMENSION) {
    throw new Error(`CLAP returned ${vector.length} dimensions; expected ${CLAP_EMBEDDING_DIMENSION}`);
  }
  let squaredLength = 0;
  for (const value of vector) {
    if (!Number.isFinite(value)) throw new Error('CLAP returned a non-finite embedding');
    squaredLength += value * value;
  }
  const length = Math.sqrt(squaredLength);
  if (!Number.isFinite(length) || Math.abs(length - 1) > 1e-3) {
    throw new Error(`CLAP returned a non-unit embedding (length ${length})`);
  }
  return vector;
}
