import type { MediaAsset } from '../../editor/types';
import type { FramePixels } from './types';
import {
  readSamplingConfig,
  type SemanticSamplingConfig,
} from './samplingConfig';

const MAX_FRAME_EDGE = 448;
const LONG_VIDEO_SECONDS = 60;
const SHORT_SCENE_SECONDS = 4;
const MAX_DETECTED_SCENES = 500;
const SAME_SEEK_THRESHOLD_SECONDS = 0.01;
const MIN_VIDEO_DURATION_SECONDS = 0.25;
const VIDEO_END_EPSILON_SECONDS = 0.01;

export class SemanticMediaDecodeError extends Error {
  constructor() {
    super('Unable to decode media for semantic indexing');
    this.name = 'SemanticMediaDecodeError';
  }
}

const throwIfAborted = (signal: AbortSignal) => {
  if (signal.aborted) throw new DOMException('Indexing canceled', 'AbortError');
};

function waitForMedia(target: HTMLImageElement | HTMLVideoElement, eventName: string, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      target.removeEventListener(eventName, onReady);
      target.removeEventListener('error', onError);
      signal.removeEventListener('abort', onAbort);
    };
    const onReady = () => { cleanup(); resolve(); };
    const onError = () => { cleanup(); reject(new SemanticMediaDecodeError()); };
    const onAbort = () => { cleanup(); reject(new DOMException('Indexing canceled', 'AbortError')); };
    target.addEventListener(eventName, onReady, { once: true });
    target.addEventListener('error', onError, { once: true });
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function capturePixels(
  source: CanvasImageSource,
  width: number,
  height: number,
  sample: Pick<FramePixels, 'sampleTime' | 'sceneId' | 'sceneStart' | 'sceneEnd'>,
): FramePixels {
  const scale = Math.min(1, MAX_FRAME_EDGE / Math.max(width, height));
  const targetWidth = Math.max(1, Math.round(width * scale));
  const targetHeight = Math.max(1, Math.round(height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = targetWidth;
  canvas.height = targetHeight;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('Canvas is unavailable');
  context.drawImage(source, 0, 0, targetWidth, targetHeight);
  const pixels = context.getImageData(0, 0, targetWidth, targetHeight);
  return { data: pixels.data, width: targetWidth, height: targetHeight, ...sample };
}

async function sampleImage(asset: MediaAsset, signal: AbortSignal): Promise<FramePixels[]> {
  const image = new Image();
  image.crossOrigin = 'anonymous';
  image.src = asset.src;
  if (!image.complete) await waitForMedia(image, 'load', signal);
  throwIfAborted(signal);
  return [capturePixels(image, image.naturalWidth, image.naturalHeight, { sampleTime: 0 })];
}

async function seekVideo(video: HTMLVideoElement, time: number, signal: AbortSignal): Promise<void> {
  if (Math.abs(video.currentTime - time) < SAME_SEEK_THRESHOLD_SECONDS) return;
  video.currentTime = time;
  await waitForMedia(video, 'seeked', signal);
}

function fallbackSamplePlan(
  duration: number,
  config: SemanticSamplingConfig = readSamplingConfig(),
): SceneSamplePlan[] {
  if (!Number.isFinite(duration) || duration <= MIN_VIDEO_DURATION_SECONDS) {
    return [{ sampleTime: 0 }];
  }
  const count = Math.min(
    config.maxFallbackFrames,
    Math.max(1, Math.ceil(duration / config.intervalSeconds)),
  );
  const step = duration / count;
  return Array.from({ length: count }, (_, index) => {
    return {
      sampleTime: Number(Math.min(
        duration - VIDEO_END_EPSILON_SECONDS,
        step * (index + 0.5),
      ).toFixed(3)),
    };
  });
}

export interface SceneSamplePlan {
  sceneId?: string;
  sceneStart?: number;
  sceneEnd?: number;
  sampleTime: number;
}

function evenlySelect<T>(values: readonly T[], count: number): T[] {
  if (count >= values.length) return [...values];
  return Array.from({ length: count }, (_, index) => values[Math.floor(index * values.length / count)]!);
}

/**
 * One representative midpoint per detected shot. When the hard budget is exceeded,
 * short shots win first and remaining slots are spread across the whole source.
 */
export function sceneAwareSamplePlan(
  duration: number,
  boundaries: readonly number[],
  maxSamples: number = readSamplingConfig().maxSceneFrames,
): SceneSamplePlan[] {
  if (!Number.isFinite(duration) || duration <= MIN_VIDEO_DURATION_SECONDS) {
    return [{ sceneId: 'scene-0-0', sceneStart: 0, sceneEnd: Math.max(0, duration), sampleTime: 0 }];
  }
  const cap = Math.max(1, Math.round(maxSamples));
  const cuts = [...new Set(boundaries
    .filter((time) => Number.isFinite(time) && time > 0 && time < duration)
    .map((time) => Number(time.toFixed(3))))]
    .sort((left, right) => left - right);
  const edges = [0, ...cuts, duration];
  const shots = edges.slice(0, -1).map((sceneStart, index) => {
    const sceneEnd = edges[index + 1]!;
    return {
      sceneId: `scene-${Math.round(sceneStart * 1000)}-${Math.round(sceneEnd * 1000)}`,
      sceneStart,
      sceneEnd,
      sampleTime: Number(Math.min(
        duration - VIDEO_END_EPSILON_SECONDS,
        sceneStart + (sceneEnd - sceneStart) / 2,
      ).toFixed(3)),
    };
  });
  if (shots.length <= cap) return shots;

  const selected = new Set<SceneSamplePlan>();
  const shortShots = shots
    .filter((shot) => shot.sceneEnd - shot.sceneStart <= SHORT_SCENE_SECONDS)
    .sort((left, right) => (
      (left.sceneEnd - left.sceneStart) - (right.sceneEnd - right.sceneStart)
      || left.sceneStart - right.sceneStart
    ));
  for (const shot of shortShots.slice(0, cap)) selected.add(shot);
  const remaining = shots.filter((shot) => !selected.has(shot));
  for (const shot of evenlySelect(remaining, cap - selected.size)) selected.add(shot);
  return [...selected].sort((left, right) => left.sampleTime - right.sampleTime);
}

export async function detectSceneBoundaries(
  asset: MediaAsset,
  signal: AbortSignal,
): Promise<number[] | null> {
  if (!asset.src.startsWith('/media/uploads/')) return null;
  try {
    const response = await fetch('/api/detect-scenes', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ src: asset.src, minSceneMs: 250, maxScenes: MAX_DETECTED_SCENES }),
      signal,
    });
    if (!response.ok) return null;
    const result = await response.json() as { scenes?: Array<{ timeMs?: number }> };
    return (result.scenes ?? [])
      .map((scene) => Number(scene.timeMs) / 1000)
      .filter(Number.isFinite);
  } catch (error) {
    if (signal.aborted) throw error;
    return null;
  }
}

async function scenePlanForLongVideo(
  asset: MediaAsset,
  duration: number,
  signal: AbortSignal,
  config: SemanticSamplingConfig,
): Promise<SceneSamplePlan[] | null> {
  if (duration < LONG_VIDEO_SECONDS) return null;
  const boundaries = await detectSceneBoundaries(asset, signal);
  return boundaries ? sceneAwareSamplePlan(duration, boundaries, config.maxSceneFrames) : null;
}

async function sampleVideo(asset: MediaAsset, signal: AbortSignal): Promise<FramePixels[]> {
  const video = document.createElement('video');
  video.crossOrigin = 'anonymous';
  video.preload = 'auto';
  video.muted = true;
  video.src = asset.src;
  try {
    await waitForMedia(video, 'loadeddata', signal);
    const config = readSamplingConfig();
    const plan = await scenePlanForLongVideo(asset, video.duration, signal, config)
      ?? fallbackSamplePlan(video.duration, config);
    const frames: FramePixels[] = [];
    for (const sample of plan) {
      throwIfAborted(signal);
      await seekVideo(video, sample.sampleTime, signal);
      frames.push(capturePixels(video, video.videoWidth, video.videoHeight, sample));
    }
    return frames;
  } finally {
    video.removeAttribute('src');
    video.load();
  }
}

export const isSemanticMedia = (asset: MediaAsset) =>
  asset.kind === 'video' || asset.kind === 'image' || asset.kind === 'gif' || asset.kind === 'svg';

export async function sampleAssetFrames(asset: MediaAsset, signal: AbortSignal): Promise<FramePixels[]> {
  throwIfAborted(signal);
  return asset.kind === 'video' ? sampleVideo(asset, signal) : sampleImage(asset, signal);
}
