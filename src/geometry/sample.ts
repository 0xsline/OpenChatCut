/**
 * Geometry-specific frame sampler: uniform coverage of the whole asset at
 * GEOM_FPS (≤ GEOM_MAX_FRAMES), sized for face detection (512 long edge).
 *
 * The semantic-search sampler is too sparse for geometry (a 10s clip yields
 * one frame); safe zones need samples everywhere the subject may appear.
 */

import type { MediaAsset } from '../editor/types';
import { GEOM_FPS, GEOM_MAX_FRAMES, INFERENCE_EDGE } from './mediapipe';

export interface GeometrySample {
  data: Uint8ClampedArray;
  width: number;
  height: number;
  /** Source-seconds timestamp of the sample. */
  sampleTime: number;
}

function waitForMedia(video: HTMLVideoElement, event: 'loadeddata' | 'seeked', signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (event === 'loadeddata' && video.readyState >= 2) {
      resolve();
      return;
    }
    const onAbort = () => {
      video.removeEventListener(event, onEvent);
      reject(new DOMException('aborted', 'AbortError'));
    };
    const onEvent = () => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    };
    video.addEventListener(event, onEvent, { once: true });
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** Uniform sample plan: short clips at GEOM_FPS, long clips spread MAX_FRAMES. */
export function geometrySampleTimes(durationSec: number): number[] {
  const step = Math.max(1 / GEOM_FPS, durationSec / GEOM_MAX_FRAMES);
  const times: number[] = [];
  for (let t = 0; t < durationSec && times.length < GEOM_MAX_FRAMES; t += step) {
    times.push(Math.min(durationSec, t));
  }
  if (!times.length || times[times.length - 1] !== durationSec) times.push(durationSec);
  return times;
}

/** Sample uniform frames from a video asset for geometry analysis. */
export async function sampleGeometryFrames(
  asset: MediaAsset,
  signal: AbortSignal,
): Promise<GeometrySample[]> {
  const video = document.createElement('video');
  video.preload = 'auto';
  video.muted = true;
  video.src = asset.src;
  try {
    await waitForMedia(video, 'loadeddata', signal);
    const duration = video.duration;
    if (!(duration > 0)) return [];
    const scale = Math.min(1, INFERENCE_EDGE / Math.max(video.videoWidth, video.videoHeight));
    const width = Math.max(2, Math.round(video.videoWidth * scale));
    const height = Math.max(2, Math.round(video.videoHeight * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) return [];
    const samples: GeometrySample[] = [];
    for (const t of geometrySampleTimes(duration)) {
      signal.throwIfAborted();
      // Seeking to the current position never fires `seeked`; skip it.
      if (Math.abs(video.currentTime - t) > 0.01) {
        video.currentTime = t;
        await waitForMedia(video, 'seeked', signal);
      }
      context.drawImage(video, 0, 0, width, height);
      const pixels = context.getImageData(0, 0, width, height);
      samples.push({ data: pixels.data, width, height, sampleTime: t });
    }
    return samples;
  } finally {
    video.removeAttribute('src');
    video.load();
  }
}
