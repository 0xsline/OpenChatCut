import type { MediaAsset } from '../../editor/types';

// Pure URL/media detection assistance for the stock/download tool (unpacked from stock-tools.ts, subject to the 500-line file limit).
// No side effects: URL sniffing, naming, duration profiling, browser-side metadata detection.

export type PoolKind = MediaAsset['kind'];

const IMAGE_SECONDS = 3;
const CLIP_SECONDS = 5;
const PROBE_TIMEOUT_MS = 8000;

const EXT_KIND: Record<string, MediaAsset['kind']> = {
  mp4: 'video', mov: 'video', webm: 'video', m4v: 'video', avi: 'video',
  jpg: 'image', jpeg: 'image', png: 'image', gif: 'image', webp: 'image', svg: 'image', avif: 'image',
  mp3: 'audio', wav: 'audio', m4a: 'audio', aac: 'audio', ogg: 'audio', flac: 'audio',
};

export function sniffKind(url: string): PoolKind | null {
  const clean = url.split('?')[0].split('#')[0];
  const base = clean.split('/').filter(Boolean).pop() ?? '';
  const ext = base.includes('.') ? base.split('.').pop()!.toLowerCase() : '';
  return ext ? (EXT_KIND[ext] ?? null) : null;
}

export function nameFromUrl(url: string): string {
  const clean = url.split('?')[0].split('#')[0];
  const base = clean.split('/').filter(Boolean).pop();
  if (!base) return url;
  try {
    return decodeURIComponent(base);
  } catch {
    return base;
  }
}

export function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

export function fallbackDuration(kind: PoolKind, fps: number): number {
  return Math.round((kind === 'image' ? IMAGE_SECONDS : CLIP_SECONDS) * fps);
}

export interface ProbeResult {
  durationInFrames: number;
  width?: number;
  height?: number;
}

/** Browser-side media detection metadata(duration/width and height);node or timeout/failed → fallback duration. */
export function probeUrl(url: string, kind: PoolKind, fps: number): Promise<ProbeResult> {
  const fallback: ProbeResult = { durationInFrames: fallbackDuration(kind, fps) };
  if (typeof document === 'undefined') return Promise.resolve(fallback);

  if (kind === 'image') {
    return new Promise((resolve) => {
      let done = false;
      const finish = (result: ProbeResult) => { if (!done) { done = true; resolve(result); } };
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => finish({
        durationInFrames: fallbackDuration('image', fps),
        width: img.naturalWidth,
        height: img.naturalHeight,
      });
      img.onerror = () => finish(fallback);
      img.src = url;
      setTimeout(() => finish(fallback), PROBE_TIMEOUT_MS);
    });
  }

  if (kind === 'motion-graphic') return Promise.resolve(fallback);

  return new Promise((resolve) => {
    let done = false;
    const finish = (result: ProbeResult) => { if (!done) { done = true; resolve(result); } };
    const el = document.createElement(kind === 'video' ? 'video' : 'audio') as HTMLVideoElement;
    el.preload = 'metadata';
    el.crossOrigin = 'anonymous';
    el.onloadedmetadata = () => {
      const durationInFrames = Math.max(1, Math.round((el.duration || CLIP_SECONDS) * fps));
      finish({
        durationInFrames,
        width: kind === 'video' ? el.videoWidth : undefined,
        height: kind === 'video' ? el.videoHeight : undefined,
      });
    };
    el.onerror = () => finish(fallback);
    el.src = url;
    setTimeout(() => finish(fallback), PROBE_TIMEOUT_MS);
  });
}
