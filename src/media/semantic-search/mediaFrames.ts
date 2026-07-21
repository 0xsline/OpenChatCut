import type { MediaAsset } from '../../editor/types';
import type { FramePixels } from './types';

const MAX_FRAME_EDGE = 448;
const VIDEO_SAMPLE_INTERVAL_SECONDS = 15;
const MAX_VIDEO_SAMPLE_COUNT = 12;
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

function capturePixels(source: CanvasImageSource, width: number, height: number, sampleTime: number): FramePixels {
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
  return { data: pixels.data, width: targetWidth, height: targetHeight, sampleTime };
}

async function sampleImage(asset: MediaAsset, signal: AbortSignal): Promise<FramePixels[]> {
  const image = new Image();
  image.crossOrigin = 'anonymous';
  image.src = asset.src;
  if (!image.complete) await waitForMedia(image, 'load', signal);
  throwIfAborted(signal);
  return [capturePixels(image, image.naturalWidth, image.naturalHeight, 0)];
}

async function seekVideo(video: HTMLVideoElement, time: number, signal: AbortSignal): Promise<void> {
  if (Math.abs(video.currentTime - time) < SAME_SEEK_THRESHOLD_SECONDS) return;
  video.currentTime = time;
  await waitForMedia(video, 'seeked', signal);
}

function videoSampleTimes(duration: number): number[] {
  if (!Number.isFinite(duration) || duration <= MIN_VIDEO_DURATION_SECONDS) return [0];
  const count = Math.min(MAX_VIDEO_SAMPLE_COUNT, Math.max(1, Math.ceil(duration / VIDEO_SAMPLE_INTERVAL_SECONDS)));
  const step = duration / count;
  return Array.from({ length: count }, (_, index) => {
    const midpoint = step * (index + 0.5);
    return Number(Math.min(duration - VIDEO_END_EPSILON_SECONDS, midpoint).toFixed(3));
  });
}

async function sampleVideo(asset: MediaAsset, signal: AbortSignal): Promise<FramePixels[]> {
  const video = document.createElement('video');
  video.crossOrigin = 'anonymous';
  video.preload = 'auto';
  video.muted = true;
  video.src = asset.src;
  await waitForMedia(video, 'loadeddata', signal);
  let frames: FramePixels[] = [];
  for (const time of videoSampleTimes(video.duration)) {
    throwIfAborted(signal);
    await seekVideo(video, time, signal);
    frames = [...frames, capturePixels(video, video.videoWidth, video.videoHeight, time)];
  }
  video.removeAttribute('src');
  video.load();
  return frames;
}

export const isSemanticMedia = (asset: MediaAsset) =>
  asset.kind === 'video' || asset.kind === 'image' || asset.kind === 'gif' || asset.kind === 'svg';

export async function sampleAssetFrames(asset: MediaAsset, signal: AbortSignal): Promise<FramePixels[]> {
  throwIfAborted(signal);
  return asset.kind === 'video' ? sampleVideo(asset, signal) : sampleImage(asset, signal);
}
