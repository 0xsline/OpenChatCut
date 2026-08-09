import { areModelPacksInstalled } from '../../../shared/model-packs';
import { resampleMonoSamples } from './audioDecode';
import { BEAT_THIS_FPS, BEAT_THIS_SAMPLE_RATE } from './beatThisPreprocess';
import type { BeatThisAnalysis } from './types';

export type { BeatThisAnalysis } from './types';

const PEAK_RADIUS = 3;
const PEAK_THRESHOLD = 0;
const DEDUPLICATE_WIDTH = 2;
const WEBGPU_IDLE_TIMEOUT_MS = 2 * 60_000;
const WASM_IDLE_TIMEOUT_MS = 5 * 60_000;
const MAX_WEBGPU_INPUT_BYTES = 128 * 1024 * 1024;

type Backend = 'webgpu' | 'wasm';
type ProgressListener = (progress: number) => void;

type WorkerResponse =
  | { readonly id: number; readonly type: 'progress'; readonly progress: number }
  | { readonly id: number; readonly type: 'result'; readonly beat: Float32Array; readonly downbeat: Float32Array }
  | { readonly id: number; readonly type: 'error'; readonly message: string };

interface WorkerLogits {
  readonly beat: Float32Array;
  readonly downbeat: Float32Array;
}

export interface BeatThisPeaks {
  readonly beats: number[];
  readonly downbeats: number[];
}
function abortError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  const error = new Error(signal.reason === undefined ? 'Beat This analysis aborted' : String(signal.reason));
  error.name = 'AbortError';
  return error;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError(signal);
}



function localMaxima(logits: Float32Array): number[] {
  const peaks: number[] = [];
  for (let index = 0; index < logits.length; index += 1) {
    const from = Math.max(0, index - PEAK_RADIUS);
    const to = Math.min(logits.length - 1, index + PEAK_RADIUS);
    let best = logits[from]!;
    for (let candidate = from + 1; candidate <= to; candidate += 1) {
      if (logits[candidate]! > best) best = logits[candidate]!;
    }
    if (logits[index] === best && logits[index]! > PEAK_THRESHOLD) peaks.push(index);
  }
  return peaks;
}

function deduplicatePeaks(peaks: readonly number[]): number[] {
  const result: number[] = [];
  let current = 0;
  let count = 0;
  for (const peak of peaks) {
    if (count > 0 && peak - current <= DEDUPLICATE_WIDTH) {
      count += 1;
      current += (peak - current) / count;
    } else {
      if (count > 0) result.push(current);
      current = peak;
      count = 1;
    }
  }
  if (count > 0) result.push(current);
  return result;
}

function snapToNearest(values: readonly number[], targets: readonly number[]): number[] {
  if (targets.length === 0) return [...values];
  return values.map((value) => {
    let best = targets[0]!;
    let distance = Math.abs(best - value);
    for (const target of targets) {
      const candidate = Math.abs(target - value);
      if (candidate < distance) {
        best = target;
        distance = candidate;
      }
    }
    return best;
  });
}

export function pickBeatThisPeaks(beatLogits: Float32Array, downbeatLogits: Float32Array): BeatThisPeaks {
  if (beatLogits.length !== downbeatLogits.length) throw new Error('Beat This logit lengths do not match');
  const beats = deduplicatePeaks(localMaxima(beatLogits));
  const snapped = snapToNearest(deduplicatePeaks(localMaxima(downbeatLogits)), beats);
  const downbeats = [...new Set(snapped)].sort((left, right) => left - right);
  return { beats, downbeats };
}

function percentile(sorted: readonly number[], ratio: number): number {
  if (sorted.length === 0) return 0;
  const position = ratio * (sorted.length - 1);
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower]!;
  return sorted[lower]! + (position - lower) * (sorted[upper]! - sorted[lower]!);
}

function median(values: readonly number[]): number {
  return percentile([...values].sort((left, right) => left - right), 0.5);
}

function beatIntervals(beats: readonly number[]): number[] {
  const intervals: number[] = [];
  for (let index = 1; index < beats.length; index += 1) intervals.push(beats[index]! - beats[index - 1]!);
  return intervals;
}

function withoutIntervalOutliers(intervals: readonly number[]): number[] {
  if (intervals.length < 4) return [...intervals];
  const sorted = [...intervals].sort((left, right) => left - right);
  const q1 = percentile(sorted, 0.25);
  const q3 = percentile(sorted, 0.75);
  const spread = q3 - q1;
  const low = q1 - 1.5 * spread;
  const high = q3 + 1.5 * spread;
  const filtered = intervals.filter((interval) => interval >= low && interval <= high);
  return filtered.length ? filtered : [...intervals];
}

function estimateBpm(beatFrames: readonly number[]): number {
  if (beatFrames.length < 2) return 0;
  const intervalFrames = median(withoutIntervalOutliers(beatIntervals(beatFrames)));
  if (intervalFrames <= 0) return 0;
  return (60 * BEAT_THIS_FPS) / intervalFrames;
}

function roundHalfToEven(value: number): number {
  const floor = Math.floor(value);
  if (value - floor !== 0.5) return Math.round(value);
  return floor % 2 === 0 ? floor : floor + 1;
}

function estimateMeter(beats: readonly number[], downbeats: readonly number[]): number {
  if (beats.length < 2 || downbeats.length < 2) return 4;
  const counts: number[] = [];
  let beatIndex = 0;
  for (let bar = 0; bar < downbeats.length - 1; bar += 1) {
    const from = downbeats[bar]! - 1e-3;
    const to = downbeats[bar + 1]! - 1e-3;
    while (beatIndex < beats.length && beats[beatIndex]! < from) beatIndex += 1;
    let end = beatIndex;
    while (end < beats.length && beats[end]! < to) end += 1;
    if (end > beatIndex) counts.push(end - beatIndex);
    beatIndex = end;
  }
  return counts.length ? Math.max(1, Math.min(12, roundHalfToEven(median(counts)))) : 4;
}

function deriveConfidence(beatLogits: Float32Array, beatFrames: readonly number[]): number {
  if (beatFrames.length === 0) return 0;
  const strengths = beatFrames.map((frame) => {
    const logit = beatLogits[Math.max(0, Math.min(beatLogits.length - 1, Math.round(frame)))]!;
    return 1 / (1 + Math.exp(-logit));
  });
  const intervals = beatIntervals(beatFrames);
  const center = median(intervals);
  const deviation = center > 0 ? median(intervals.map((value) => Math.abs(value - center))) / center : 1;
  const regularity = Math.max(0, 1 - deviation * 5);
  const coverage = Math.min(1, beatFrames.length / 8);
  return Math.round(Math.max(0, Math.min(1, median(strengths) * 0.65 + regularity * 0.3 + coverage * 0.05)) * 1_000) / 1_000;
}

function deriveBeatEnergy(
  samples: Float32Array,
  sampleRate: number,
  beatsMs: readonly number[],
): number[] {
  const radius = Math.max(1, Math.round(sampleRate * 0.08));
  const raw = beatsMs.map((time) => {
    const center = Math.round((time * sampleRate) / 1_000);
    const from = Math.max(0, center - radius);
    const to = Math.min(samples.length, center + radius + 1);
    let sum = 0;
    for (let index = from; index < to; index += 1) sum += samples[index]! * samples[index]!;
    return Math.log1p(100 * Math.sqrt(sum / Math.max(1, to - from)));
  });
  if (raw.length === 0) return [];
  const sorted = [...raw].sort((left, right) => left - right);
  const low = percentile(sorted, 0.1);
  const high = percentile(sorted, 0.9);
  if (high - low < 1e-8) return raw.map((value) => (value > 0 ? 0.5 : 0));
  return raw.map((value) => Math.round(Math.max(0, Math.min(1, (value - low) / (high - low))) * 1_000) / 1_000);
}

function reportProgress(listener: ProgressListener | undefined, progress: number): void {
  try {
    listener?.(Math.max(0, Math.min(1, progress)));
  } catch {
    // Progress observers must not be able to fail model inference.
  }
}

function createBeatWorker(): Worker {
  return new Worker(new URL('./beatThis.worker.ts', import.meta.url), { type: 'module' });
}

interface WorkerAttemptLifecycle {
  readonly settle: (action: () => void) => void;
  readonly armTimeout: () => void;
  readonly bindAbort: () => boolean;
}

function createWorkerAttemptLifecycle(
  worker: Worker,
  backend: Backend,
  signal: AbortSignal | undefined,
  reject: (reason?: unknown) => void,
): WorkerAttemptLifecycle {
  const timeoutMs = backend === 'webgpu' ? WEBGPU_IDLE_TIMEOUT_MS : WASM_IDLE_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  let done = false;
  const settle = (action: () => void) => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    if (onAbort) signal?.removeEventListener('abort', onAbort);
    worker.terminate();
    action();
  };
  const armTimeout = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      settle(() => reject(new Error(`${backend} worker timed out after ${timeoutMs / 1_000}s without progress`)));
    }, timeoutMs);
  };
  const bindAbort = () => {
    onAbort = () => settle(() => reject(abortError(signal!)));
    if (signal?.aborted) {
      onAbort();
      return false;
    }
    signal?.addEventListener('abort', onAbort, { once: true });
    return true;
  };
  return { settle, armTimeout, bindAbort };
}

function attachWorkerAttemptListeners(
  worker: Worker,
  backend: Backend,
  onProgress: ProgressListener,
  resolve: (value: WorkerLogits | PromiseLike<WorkerLogits>) => void,
  reject: (reason?: unknown) => void,
  lifecycle: WorkerAttemptLifecycle,
): void {
  worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
    const message = event.data;
    if (message.id !== 1) return;
    if (message.type === 'progress') {
      lifecycle.armTimeout();
      onProgress(message.progress);
    } else if (message.type === 'error') {
      lifecycle.settle(() => reject(new Error(message.message)));
    } else {
      lifecycle.settle(() => resolve({ beat: message.beat, downbeat: message.downbeat }));
    }
  };
  worker.onerror = (event) => {
    const location = event.filename ? ` at ${event.filename}:${event.lineno}:${event.colno}` : '';
    lifecycle.settle(() => reject(new Error(event.message
      ? `Beat This ${backend} worker crashed: ${event.message}${location}`
      : `Beat This ${backend} worker crashed${location}`)));
  };
}

function runWorkerAttempt(
  backend: Backend,
  samples: Float32Array,
  onProgress: ProgressListener,
  signal?: AbortSignal,
): Promise<WorkerLogits> {
  const worker = createBeatWorker();
  const { promise, resolve, reject } = Promise.withResolvers<WorkerLogits>();
  const lifecycle = createWorkerAttemptLifecycle(worker, backend, signal, reject);
  attachWorkerAttemptListeners(worker, backend, onProgress, resolve, reject, lifecycle);
  if (!lifecycle.bindAbort()) return promise;
  lifecycle.armTimeout();
  try {
    worker.postMessage({ id: 1, type: 'analyze', backend, samples }, [samples.buffer]);
  } catch (error) {
    lifecycle.settle(() => reject(error));
  }
  return promise;
}

async function inferBeatThis(
  samples: Float32Array,
  onProgress?: ProgressListener,
  signal?: AbortSignal,
): Promise<WorkerLogits> {
  const hasWebGpu = typeof navigator !== 'undefined'
    && 'gpu' in navigator
    && samples.byteLength <= MAX_WEBGPU_INPUT_BYTES;
  if (!hasWebGpu) {
    return runWorkerAttempt('wasm', samples, (value) => reportProgress(onProgress, value), signal);
  }
  try {
    const webGpuSamples = samples.slice();
    const result = await runWorkerAttempt('webgpu', webGpuSamples, (value) => reportProgress(onProgress, value * 0.5), signal);
    reportProgress(onProgress, 1);
    return result;
  } catch (webGpuError) {
    throwIfAborted(signal);
    try {
      return await runWorkerAttempt('wasm', samples, (value) => reportProgress(onProgress, 0.5 + value * 0.5), signal);
    } catch (wasmError) {
      throwIfAborted(signal);
      const first = webGpuError instanceof Error ? webGpuError.message : String(webGpuError);
      const second = wasmError instanceof Error ? wasmError.message : String(wasmError);
      throw new Error(`Beat This WebGPU failed (${first}); fresh WASM worker failed (${second})`);
    }
  }
}

export async function analyzeBeatThis(
  samples: Float32Array,
  sampleRate: number,
  onProgress?: ProgressListener,
  signal?: AbortSignal,
): Promise<BeatThisAnalysis> {
  if (!(samples instanceof Float32Array) || samples.length === 0) throw new Error('Beat This audio samples are empty');
  if (!Number.isInteger(sampleRate) || sampleRate < 8_000 || sampleRate > 192_000) {
    throw new Error(`Invalid Beat This sample rate: ${sampleRate}`);
  }
  for (let index = 0; index < samples.length; index += 1) {
    if (!Number.isFinite(samples[index])) throw new Error(`Beat This audio contains a non-finite sample at ${index}`);
  }
  throwIfAborted(signal);
  if (!await areModelPacksInstalled(['rhythm-lite'])) {
    throw new Error('Beat This model pack rhythm-lite is not installed');
  }
  throwIfAborted(signal);
  reportProgress(onProgress, 0);
  const modelSamples = await resampleMonoSamples(samples, sampleRate, BEAT_THIS_SAMPLE_RATE);
  throwIfAborted(signal);
  if (modelSamples.length <= 512) throw new Error('Beat This audio is too short for reflect-padded analysis');
  const logits = await inferBeatThis(modelSamples, onProgress, signal);
  throwIfAborted(signal);
  const peaks = pickBeatThisPeaks(logits.beat, logits.downbeat);
  const beatsMs = peaks.beats.map((frame) => Math.round((frame * 1_000) / BEAT_THIS_FPS));
  const downbeatsMs = peaks.downbeats.map((frame) => Math.round((frame * 1_000) / BEAT_THIS_FPS));
  return {
    bpm: estimateBpm(peaks.beats),
    meter: estimateMeter(peaks.beats, peaks.downbeats),
    confidence: deriveConfidence(logits.beat, peaks.beats),
    beatsMs,
    downbeatsMs,
    beatEnergy: deriveBeatEnergy(samples, sampleRate, beatsMs),
  };
}
