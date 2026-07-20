// Browser-side contact sheet for blob:/data: sources (upload-in-progress placeholders).
// view_asset_frames can use editor-local bytes before remoteUrl exists; this is
// Browser fallback: <video> seek + canvas → tile via /api is unavailable for
// blob URLs, so we assemble a simple grid with Canvas 2D in the page.
import type { MediaAsset } from '../../editor/types';

const MAX_SAMPLES = 16;

function sampleTimesMs(durationMs: number, count: number, fromMs = 0, toMs?: number): number[] {
  const n = Math.max(1, Math.min(MAX_SAMPLES, Math.round(count)));
  const lo = Math.max(0, fromMs);
  const hi = Math.max(lo + 1, toMs ?? durationMs);
  const span = hi - lo;
  return Array.from({ length: n }, (_, i) => Math.round(lo + ((i + 0.5) / n) * span));
}

function formatLabel(ms: number): string {
  const sec = ms / 1000;
  if (sec < 60) return `${sec.toFixed(1)}s`;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function loadVideo(src: string): Promise<HTMLVideoElement> {
  return new Promise((resolve, reject) => {
    const v = document.createElement('video');
    v.muted = true;
    v.playsInline = true;
    v.preload = 'auto';
    v.crossOrigin = 'anonymous';
    const onErr = () => reject(new Error('video load failed'));
    v.addEventListener('error', onErr, { once: true });
    v.addEventListener('loadedmetadata', () => resolve(v), { once: true });
    v.src = src;
  });
}

function seekTo(v: HTMLVideoElement, timeSec: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onSeek = () => {
      v.removeEventListener('seeked', onSeek);
      resolve();
    };
    const onErr = () => {
      v.removeEventListener('error', onErr);
      reject(new Error('seek failed'));
    };
    v.addEventListener('seeked', onSeek, { once: true });
    v.addEventListener('error', onErr, { once: true });
    const t = Math.min(Math.max(0, timeSec), Math.max(0, (v.duration || 0) - 0.05));
    if (Math.abs(v.currentTime - t) < 0.01) {
      v.removeEventListener('seeked', onSeek);
      resolve();
      return;
    }
    v.currentTime = t;
  });
}

/**
 * Build a labeled contact sheet from a blob:/data: video URL.
 * Returns base64 JPEG (no data: prefix) + labels, or null if not in browser / not video.
 */
export async function extractBlobContactSheet(
  src: string,
  opts: {
    sourceTimesMs?: number[];
    count?: number;
    fromMs?: number;
    toMs?: number;
  } = {},
): Promise<{ base64: string; labels: string[]; sourceTimesMs: number[]; sampleCount: number } | null> {
  if (typeof document === 'undefined') return null;
  if (!src.startsWith('blob:') && !src.startsWith('data:')) return null;

  let video: HTMLVideoElement;
  try {
    video = await loadVideo(src);
  } catch {
    return null;
  }

  const durationMs = Math.max(1, Math.round((video.duration || 1) * 1000));
  const times = opts.sourceTimesMs?.length
    ? opts.sourceTimesMs.filter((t) => Number.isFinite(t) && t >= 0).slice(0, MAX_SAMPLES)
    : sampleTimesMs(durationMs, opts.count ?? 12, opts.fromMs ?? 0, opts.toMs);

  if (!times.length) return null;

  const cellW = times.length > 9 ? 280 : 320;
  const cellH = Math.round(cellW * 9 / 16) & ~1;
  const cols = Math.ceil(Math.sqrt(times.length));
  const rows = Math.ceil(times.length / cols);
  const canvas = document.createElement('canvas');
  canvas.width = cols * cellW;
  canvas.height = rows * cellH;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const labels: string[] = [];
  for (let i = 0; i < times.length; i += 1) {
    const ms = times[i]!;
    try {
      await seekTo(video, ms / 1000);
    } catch {
      continue;
    }
    const col = i % cols;
    const row = Math.floor(i / cols);
    const x = col * cellW;
    const y = row * cellH;
    // letterbox draw
    const vw = video.videoWidth || cellW;
    const vh = video.videoHeight || cellH;
    const scale = Math.min(cellW / vw, cellH / vh);
    const dw = Math.round(vw * scale);
    const dh = Math.round(vh * scale);
    const dx = x + Math.round((cellW - dw) / 2);
    const dy = y + Math.round((cellH - dh) / 2);
    ctx.drawImage(video, dx, dy, dw, dh);
    const label = formatLabel(ms);
    labels.push(label);
    // label bar
    ctx.fillStyle = 'rgba(0,0,0,0.65)';
    ctx.fillRect(x + 4, y + 4, Math.min(cellW - 8, 12 + label.length * 9), 22);
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 14px system-ui,sans-serif';
    ctx.fillText(label, x + 10, y + 20);
  }

  video.removeAttribute('src');
  video.load();

  if (!labels.length) return null;
  const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
  const base64 = dataUrl.replace(/^data:image\/jpeg;base64,/, '');
  return {
    base64,
    labels,
    sourceTimesMs: times.slice(0, labels.length),
    sampleCount: labels.length,
  };
}

/** Still image blob:/data: → single-cell preview as base64 JPEG. */
export async function extractBlobImagePreview(src: string): Promise<string | null> {
  if (typeof document === 'undefined') return null;
  if (!src.startsWith('blob:') && !src.startsWith('data:')) return null;
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const max = 640;
      const scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
      const w = Math.max(1, Math.round(img.naturalWidth * scale));
      const h = Math.max(1, Math.round(img.naturalHeight * scale));
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      const ctx = c.getContext('2d');
      if (!ctx) { resolve(null); return; }
      ctx.drawImage(img, 0, 0, w, h);
      resolve(c.toDataURL('image/jpeg', 0.88).replace(/^data:image\/jpeg;base64,/, ''));
    };
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

export function isBlobishSrc(src: string | undefined): boolean {
  return !!src && (src.startsWith('blob:') || src.startsWith('data:'));
}

export type { MediaAsset };
