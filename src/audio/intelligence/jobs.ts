import type { MediaAsset } from '../../editor/types';
import { sourceRevisionOf } from '../../editor/mediaSourceRevision';
import { areModelPacksInstalled } from '../../../shared/model-packs';
import type { MusicAnalysisProgress } from './analysis';
import { getAutoMusicAnalysisEnabled } from './preferences';
import { loadMusicAnalysisForAsset, saveMusicAnalysis } from './store';
import { MUSIC_ANALYZER_FINGERPRINT } from './types';
import type { MusicAnalysis, MusicAnalysisStatus } from './types';

const REQUIRED_MODEL_PACKS = ['rhythm-lite', 'music-semantics-lite'] as const;
const DEFAULT_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_RETRIES = 1;
const IDLE_STATUS: MusicAnalysisStatus = Object.freeze({ state: 'idle' });
interface PromiseResolvers<T> {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
}

const promiseConstructor = Promise as unknown as {
  withResolvers<T>(): PromiseResolvers<T>;
};

export interface EnqueueMusicAnalysisOptions {
  /** Skip a valid derived-cache entry and run the analyzers again. */
  force?: boolean;
  /** Automatic import/relink work observes the persisted opt-in preference. */
  automatic?: boolean;
  retries?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export type MusicAnalysisListener = () => void;

const statuses = new Map<string, MusicAnalysisStatus>();
const activeKeys = new Map<string, string>();
const flights = new Map<string, Promise<MusicAnalysis | null>>();
const listeners = new Set<MusicAnalysisListener>();
let heavyInferenceTail: Promise<void> = Promise.resolve();

function jobKey(asset: MediaAsset): string {
  return JSON.stringify([asset.id, sourceRevisionOf(asset), MUSIC_ANALYZER_FINGERPRINT]);
}

function publish(assetId: string, key: string, status: MusicAnalysisStatus): void {
  if (activeKeys.get(assetId) !== key) return;
  statuses.set(assetId, status);
  for (const listener of listeners) {
    try { listener(); } catch { /* observers cannot break imports or inference */ }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function cancellationError(message: string, name: 'AbortError' | 'TimeoutError'): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}

function normalizedOptions(options: EnqueueMusicAnalysisOptions): Required<Pick<EnqueueMusicAnalysisOptions, 'retries' | 'timeoutMs'>> {
  const requestedRetries = typeof options.retries === 'number' && Number.isFinite(options.retries) ? options.retries : DEFAULT_RETRIES;
  const requestedTimeout = typeof options.timeoutMs === 'number' && Number.isFinite(options.timeoutMs) ? options.timeoutMs : DEFAULT_TIMEOUT_MS;
  return {
    retries: Math.max(0, Math.min(3, Math.floor(requestedRetries))),
    timeoutMs: Math.max(1, Math.min(60 * 60_000, Math.floor(requestedTimeout))),
  };
}

function progressStatus(progress: MusicAnalysisProgress): MusicAnalysisStatus {
  const value = Number.isFinite(progress.progress) ? progress.progress : 0;
  return { state: 'running', phase: progress.phase, progress: Math.max(0, Math.min(1, value)) };
}

async function runAttempt(
  asset: MediaAsset,
  key: string,
  options: EnqueueMusicAnalysisOptions,
): Promise<MusicAnalysis> {
  const limits = normalizedOptions(options);
  const controller = new AbortController();
  const deadline = promiseConstructor.withResolvers<never>();
  let stopped = false;
  const stop = (error: Error) => {
    if (stopped) return;
    stopped = true;
    publish(asset.id, key, { state: 'error', message: error.message });
    controller.abort(error);
    deadline.reject(error);
  };
  const onAbort = () => stop(cancellationError('Music analysis aborted', 'AbortError'));
  const timer = setTimeout(() => stop(cancellationError(`Music analysis timed out after ${limits.timeoutMs} ms`, 'TimeoutError')), limits.timeoutMs);
  options.signal?.addEventListener('abort', onAbort, { once: true });
  if (options.signal?.aborted) onAbort();
  const task = import('./analysis').then(({ analyzeMusicAsset }) => analyzeMusicAsset(asset, {
    signal: controller.signal,
    onProgress: (progress) => { if (!stopped) publish(asset.id, key, progressStatus(progress)); },
  }));
  try {
    return await Promise.race([task, deadline.promise]);
  } catch (error) {
    controller.abort(error);
    await task.catch(() => undefined);
    throw error;
  } finally {
    stopped = true;
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onAbort);
  }
}

async function runWithRetries(
  asset: MediaAsset,
  key: string,
  options: EnqueueMusicAnalysisOptions,
): Promise<MusicAnalysis | null> {
  const { retries } = normalizedOptions(options);
  let lastError: unknown = new Error('Music analysis failed');
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    if (activeKeys.get(asset.id) !== key) return null;
    if (options.signal?.aborted) {
      lastError = cancellationError('Music analysis aborted', 'AbortError');
      break;
    }
    publish(asset.id, key, { state: 'running', phase: 'decode', progress: 0 });
    try {
      const analysis = await runAttempt(asset, key, options);
      await saveMusicAnalysis(analysis);
      publish(asset.id, key, { state: 'ready', analysis });
      return analysis;
    } catch (error) {
      lastError = error;
      if (options.signal?.aborted || (error instanceof Error && error.name === 'AbortError')) break;
    }
  }
  publish(asset.id, key, { state: 'error', message: errorMessage(lastError) });
  return null;
}

function enqueueHeavy(
  asset: MediaAsset,
  key: string,
  options: EnqueueMusicAnalysisOptions,
): Promise<MusicAnalysis | null> {
  const run = heavyInferenceTail.then(
    () => runWithRetries(asset, key, options),
    () => runWithRetries(asset, key, options),
  );
  heavyInferenceTail = run.then(() => undefined, () => undefined);
  return run;
}

async function prepareJob(
  asset: MediaAsset,
  key: string,
  options: EnqueueMusicAnalysisOptions,
): Promise<MusicAnalysis | null> {
  try {
    if (!options.force) {
      const cached = await loadMusicAnalysisForAsset(asset);
      if (cached) {
        publish(asset.id, key, { state: 'ready', analysis: cached });
        return cached;
      }
    }
    if (activeKeys.get(asset.id) !== key) return null;
    if (!await areModelPacksInstalled(REQUIRED_MODEL_PACKS)) {
      publish(asset.id, key, { state: 'error', message: 'Install rhythm-lite and music-semantics-lite before music analysis' });
      return null;
    }
    return await enqueueHeavy(asset, key, options);
  } catch (error) {
    publish(asset.id, key, { state: 'error', message: errorMessage(error) });
    return null;
  }
}

function finishFlight(key: string, flight: Promise<MusicAnalysis | null>): void {
  if (flights.get(key) === flight) flights.delete(key);
}

export function enqueueMusicAnalysis(
  asset: MediaAsset,
  options: EnqueueMusicAnalysisOptions = {},
): Promise<MusicAnalysis | null> {
  const key = jobKey(asset);
  activeKeys.set(asset.id, key);
  if (options.automatic && !getAutoMusicAnalysisEnabled()) {
    publish(asset.id, key, IDLE_STATUS);
    return Promise.resolve(null);
  }
  if (asset.kind !== 'audio' && asset.kind !== 'video') {
    publish(asset.id, key, { state: 'error', message: 'Music analysis supports audio and video assets only' });
    return Promise.resolve(null);
  }
  if (!asset.src || asset.src.startsWith('blob:') || asset.src.startsWith('data:')) {
    publish(asset.id, key, { state: 'error', message: 'Music analysis requires a ready media source' });
    return Promise.resolve(null);
  }
  const existing = flights.get(key);
  if (existing) return existing;
  publish(asset.id, key, { state: 'queued' });
  const flight = prepareJob(asset, key, options);
  flights.set(key, flight);
  void flight.then(() => finishFlight(key, flight), () => finishFlight(key, flight));
  return flight;
}

export function refreshMusicAnalysis(
  asset: MediaAsset,
  options: Omit<EnqueueMusicAnalysisOptions, 'force'> = {},
): Promise<MusicAnalysis | null> {
  return enqueueMusicAnalysis(asset, { ...options, force: options.automatic !== true });
}

export function subscribeMusicAnalysis(listener: MusicAnalysisListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function musicAnalysisStatus(assetId: string): MusicAnalysisStatus {
  return statuses.get(assetId) ?? IDLE_STATUS;
}
