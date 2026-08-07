/**
 * Geometry-specific frame sampler: uniform coverage of the whole asset at
 * GEOM_FPS (≤ GEOM_MAX_FRAMES), sized for face detection (512 long edge).
 *
 * The semantic-search sampler is too sparse for geometry (a 10s clip yields
 * one frame); safe zones need samples everywhere the subject may appear.
 */

import type { MediaAsset } from '../editor/types';
import {
  detectSceneBoundaries,
  sceneAwareSamplePlan,
  type SceneSamplePlan,
} from '../media/semantic-search/mediaFrames';
import { GEOM_FPS, GEOM_MAX_FRAMES, INFERENCE_EDGE } from './mediapipe';

const MEDIA_EVENT_TIMEOUT_MS = 8_000;
const VIDEO_END_EPSILON_SECONDS = 0.01;

interface PromiseResolvers<T> {
  promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
  reject(reason?: unknown): void;
}

const promiseConstructor = Promise as unknown as {
  withResolvers<T>(): PromiseResolvers<T>;
};

export interface GeometrySample {
  data: Uint8ClampedArray;
  width: number;
  height: number;
  /** Source-seconds timestamp of the sample. */
  sampleTime: number;
  /** Full decoded source duration. */
  durationSec: number;
  sceneId?: string;
  sceneStart?: number;
  sceneEnd?: number;
}

function waitForMedia(
  video: HTMLVideoElement,
  event: 'loadeddata' | 'seeked',
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  if (event === 'loadeddata' && video.readyState >= 2) return Promise.resolve();
  const { promise, resolve, reject } = promiseConstructor.withResolvers<void>();
  let timer: number | undefined;
  const cleanup = (): void => {
    video.removeEventListener(event, onEvent);
    video.removeEventListener('error', onError);
    signal.removeEventListener('abort', onAbort);
    clearTimeout(timer);
  };
  const finish = (error?: Error): void => {
    cleanup();
    if (error) reject(error);
    else resolve(undefined);
  };
  const onEvent = () => finish();
  const onError = () => finish(new Error(`geometry media ${event} failed`));
  const onAbort = () => finish(new DOMException('aborted', 'AbortError'));
  video.addEventListener(event, onEvent, { once: true });
  video.addEventListener('error', onError, { once: true });
  signal.addEventListener('abort', onAbort, { once: true });
  timer = window.setTimeout(
    () => finish(new Error(`geometry media ${event} timed out`)),
    MEDIA_EVENT_TIMEOUT_MS,
  );
  return promise;
}

/** Uniform sample plan with an inclusive terminal timestamp and a hard cap. */
export function geometrySampleTimes(
  durationSec: number,
  maxSamples = GEOM_MAX_FRAMES,
): number[] {
  if (!Number.isFinite(durationSec) || durationSec <= 0) return [];
  const requested = Number.isFinite(maxSamples) ? Math.floor(maxSamples) : GEOM_MAX_FRAMES;
  const cap = Math.max(1, Math.min(GEOM_MAX_FRAMES, requested));
  if (cap === 1) return [0];
  const count = Math.min(cap, Math.max(2, Math.ceil(durationSec * GEOM_FPS) + 1));
  return Array.from({ length: count }, (_, index) => (
    index === count - 1
      ? durationSec
      : Number((durationSec * index / (count - 1)).toFixed(3))
  ));
}

const evenlySelect = <T>(values: readonly T[], count: number): T[] => {
  if (count >= values.length) return [...values];
  return Array.from(
    { length: Math.max(0, count) },
    (_, index) => values[Math.floor(index * values.length / count)]!,
  );
};

function scenePlan(
  durationSec: number,
  boundaries: readonly number[],
  maxSamples: number,
): SceneSamplePlan[] {
  const requested = Number.isFinite(maxSamples) ? Math.floor(maxSamples) : GEOM_MAX_FRAMES;
  const cap = Math.max(1, Math.min(GEOM_MAX_FRAMES, requested));
  const scenes = sceneAwareSamplePlan(durationSec, boundaries, cap);
  if (scenes.length >= cap) return scenes;
  const cuts = [...new Set(boundaries
    .filter((time) => Number.isFinite(time) && time > 0 && time < durationSec)
    .map((time) => Number(time.toFixed(3))))]
    .toSorted((left, right) => left - right);
  const edges = [0, ...cuts, durationSec];
  const uniform = geometrySampleTimes(durationSec, cap).map((sampleTime) => {
    const edgeIndex = edges.findIndex((edge) => edge > sampleTime);
    const endIndex = edgeIndex < 0 ? edges.length - 1 : edgeIndex;
    const sceneStart = edges[Math.max(0, endIndex - 1)]!;
    const sceneEnd = edges[endIndex]!;
    return {
      sceneId: `scene-${Math.round(sceneStart * 1000)}-${Math.round(sceneEnd * 1000)}`,
      sceneStart,
      sceneEnd,
      sampleTime,
    };
  });
  const seen = new Set(scenes.map((sample) => Math.round(sample.sampleTime * 1000)));
  const candidates = uniform.filter((sample) => !seen.has(Math.round(sample.sampleTime * 1000)));
  return [...scenes, ...evenlySelect(candidates, cap - scenes.length)]
    .toSorted((left, right) => left.sampleTime - right.sampleTime);
}

/** Stream sampled frames from a video asset for geometry analysis. */
export async function* sampleGeometryFrames(
  asset: MediaAsset,
  signal: AbortSignal,
  maxSamples = GEOM_MAX_FRAMES,
): AsyncGenerator<GeometrySample> {
  const video = document.createElement('video');
  video.crossOrigin = 'anonymous';
  video.preload = 'auto';
  video.muted = true;
  video.src = asset.src;
  try {
    await waitForMedia(video, 'loadeddata', signal);
    const durationSec = video.duration;
    if (!(durationSec > 0)) return;
    const scale = Math.min(1, INFERENCE_EDGE / Math.max(video.videoWidth, video.videoHeight));
    const width = Math.max(2, Math.round(video.videoWidth * scale));
    const height = Math.max(2, Math.round(video.videoHeight * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) return;
    const boundaries = await detectSceneBoundaries(asset, signal);
    const plan = boundaries?.length
      ? scenePlan(durationSec, boundaries, maxSamples)
      : geometrySampleTimes(durationSec, maxSamples).map((sampleTime) => ({ sampleTime }));
    for (const sample of plan) {
      signal.throwIfAborted();
      const seekTime = Math.min(
        Math.max(0, durationSec - VIDEO_END_EPSILON_SECONDS),
        sample.sampleTime,
      );
      if (Math.abs(video.currentTime - seekTime) > 0.01) {
        video.currentTime = seekTime;
        await waitForMedia(video, 'seeked', signal);
      }
      context.drawImage(video, 0, 0, width, height);
      const pixels = context.getImageData(0, 0, width, height);
      yield { data: pixels.data, width, height, durationSec, ...sample };
    }
  } finally {
    video.removeAttribute('src');
    video.load();
  }
}
