import type { GlslTransitionType } from '../editor/types';
import { createGlRuntime, type GlRuntime } from './runtime';
import { clearSampleFrames, ensureSampleFrame, getSampleFrame, SAMPLE_H, SAMPLE_W } from './sampleFrames';
import { GLSL_TRANSITIONS } from './transitions';

// Photoreal A/B samples (outdoor → warm interior) so transition motion is
// obvious. Hover plays full 0→1 with a short hold, then loops.

export const THUMB_W = SAMPLE_W;
export const THUMB_H = SAMPLE_H;
/** resting still — mid-straddle so cards aren't empty */
const PREVIEW_PROGRESS = 0.42;
/** slower + clearer than before so hover reads as a real transition */
export const HOVER_DURATION_MS = 1500;
export const HOVER_HOLD_FRACTION = 0.1;

let glCanvas: HTMLCanvasElement | null = null;
let rt: GlRuntime | null = null;
let activeRuntimeUsers = 0;
let resourceGeneration = 0;

function disposeTransitionThumbRuntime(): void {
  rt?.dispose();
  rt = null;
  if (glCanvas) {
    glCanvas.width = 0;
    glCanvas.height = 0;
  }
  glCanvas = null;
}

export function acquireTransitionThumbRuntime(): void {
  activeRuntimeUsers++;
}

export function releaseTransitionThumbRuntime(): void {
  activeRuntimeUsers = Math.max(0, activeRuntimeUsers - 1);
  if (activeRuntimeUsers === 0) disposeTransitionThumbRuntime();
}

export function disposeIdleTransitionThumbRuntime(): void {
  if (activeRuntimeUsers === 0) disposeTransitionThumbRuntime();
}

function ensureRuntime(): boolean {
  if (glCanvas && rt) return true;
  try {
    glCanvas = document.createElement('canvas');
    glCanvas.width = THUMB_W;
    glCanvas.height = THUMB_H;
    rt = createGlRuntime(glCanvas);
    return true;
  } catch {
    disposeTransitionThumbRuntime();
    return false;
  }
}

/** Release decoded/runtime data when leaving transition resources; encoded stills stay in bounded LRU. */
export function cleanupTransitionThumbResources(): void {
  resourceGeneration++;
  clearSampleFrames(['out', 'in']);
  disposeTransitionThumbRuntime();
}

/** 2D fallback when GL compile/draw fails — still show a readable A/B mix. */
function drawFallback(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  sampleA: CanvasImageSource,
  sampleB: CanvasImageSource,
  progress: number,
  type: GlslTransitionType,
): void {
  ctx.fillStyle = '#141414';
  ctx.fillRect(0, 0, w, h);
  const p = Math.max(0, Math.min(1, progress));
  ctx.globalAlpha = 1 - p;
  ctx.drawImage(sampleA, 0, 0, w, h);
  ctx.globalAlpha = p;
  ctx.drawImage(sampleB, 0, 0, w, h);
  ctx.globalAlpha = 1;
  // tint for color-flash transitions so the card isn't a plain crossfade
  if (type === 'dip-to-color') {
    const mid = 1 - Math.abs(p * 2 - 1); // peak at 0.5
    ctx.fillStyle = `rgba(242, 97, 36, ${0.55 * mid})`;
    ctx.fillRect(0, 0, w, h);
  }
}

function paintTransition(
  dest: HTMLCanvasElement | CanvasRenderingContext2D,
  frag: string | null,
  progress: number,
  extra: Record<string, import('./runtime').UniformValue>,
  fallbackType: GlslTransitionType | 'custom',
): boolean {
  const sampleA = getSampleFrame('out');
  const sampleB = getSampleFrame('in');
  const ctx = dest instanceof HTMLCanvasElement ? dest.getContext('2d') : dest;
  if (!ctx || !sampleA || !sampleB) return false;
  const w = dest instanceof HTMLCanvasElement ? dest.width : ctx.canvas.width;
  const h = dest instanceof HTMLCanvasElement ? dest.height : ctx.canvas.height;
  const fbType: GlslTransitionType = fallbackType === 'custom' ? 'cross-dissolve' : fallbackType;

  try {
    if (!ensureRuntime() || !glCanvas || !rt || !frag) {
      drawFallback(ctx, w, h, sampleA, sampleB, progress, fbType);
      return true;
    }
    rt.render(frag, sampleA, sampleB, progress, extra);
    ctx.fillStyle = '#141414';
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(glCanvas, 0, 0, w, h);
    return true;
  } catch {
    try {
      drawFallback(ctx, w, h, sampleA, sampleB, progress, fbType);
      return true;
    } catch {
      return false;
    }
  }
}

export function drawTransitionFrame(
  dest: HTMLCanvasElement | CanvasRenderingContext2D,
  type: GlslTransitionType,
  progress: number,
): boolean {
  const def = GLSL_TRANSITIONS[type];
  const aspect = THUMB_W / THUMB_H;
  const extra = def?.uniforms({ time: progress * 2, aspect, direction: 'left' }) ?? {};
  return paintTransition(dest, def?.frag ?? null, progress, extra, type);
}

/** 自定义/插件转场(registry frag + 默认 uniforms)的 A/B 预览 */
export function drawCustomTransitionFrame(
  dest: HTMLCanvasElement | CanvasRenderingContext2D,
  frag: string,
  progress: number,
  uniforms: Record<string, number> = {},
): boolean {
  return paintTransition(dest, frag, progress, uniforms, 'custom');
}

const STILL_MAX_ENTRIES = 24;
const STILL_MAX_BYTES = 4 * 1024 * 1024;
const stills = new Map<string, { url: string; bytes: number }>();
let stillBytes = 0;

function readStill(type: string): string | undefined {
  const entry = stills.get(type);
  if (!entry) return undefined;
  stills.delete(type);
  stills.set(type, entry);
  return entry.url;
}

function cacheStill(type: string, url: string): void {
  const previous = stills.get(type);
  if (previous) stillBytes -= previous.bytes;
  stills.delete(type);
  const bytes = url.length * 2;
  if (bytes > STILL_MAX_BYTES) return;
  stills.set(type, { url, bytes });
  stillBytes += bytes;
  while (stills.size > STILL_MAX_ENTRIES || stillBytes > STILL_MAX_BYTES) {
    const oldest = stills.keys().next().value as string | undefined;
    if (!oldest) break;
    stillBytes -= stills.get(oldest)?.bytes ?? 0;
    stills.delete(oldest);
  }
}

export function transitionThumbUrl(type: GlslTransitionType): string {
  const hit = readStill(type);
  if (hit) return hit;
  try {
    if (!getSampleFrame('out') || !getSampleFrame('in')) return '';
    const off = document.createElement('canvas');
    off.width = THUMB_W;
    off.height = THUMB_H;
    if (!drawTransitionFrame(off, type, PREVIEW_PROGRESS)) return '';
    const url = off.toDataURL('image/jpeg', 0.85);
    cacheStill(type, url);
    return url;
  } catch {
    return '';
  }
}

function hashShader(frag: string): string {
  let hash = 2166136261;
  for (let i = 0; i < frag.length; i++) {
    hash ^= frag.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function customStillKey(id: string, frag: string): string {
  return `custom:${id}:${hashShader(frag)}`;
}

export function getCachedTransitionThumbUrl(type: GlslTransitionType): string {
  return readStill(type) ?? '';
}

export function getCachedCustomTransitionThumbUrl(id: string, frag: string): string {
  return readStill(customStillKey(id, frag)) ?? '';
}

export function customTransitionThumbUrl(
  id: string,
  frag: string,
  uniforms: Record<string, number>,
): string {
  const key = customStillKey(id, frag);
  const hit = readStill(key);
  if (hit) return hit;
  try {
    if (!getSampleFrame('out') || !getSampleFrame('in')) return '';
    const off = document.createElement('canvas');
    off.width = THUMB_W;
    off.height = THUMB_H;
    if (!drawCustomTransitionFrame(off, frag, PREVIEW_PROGRESS, uniforms)) return '';
    const url = off.toDataURL('image/jpeg', 0.85);
    cacheStill(key, url);
    return url;
  } catch {
    return '';
  }
}

export async function transitionThumbUrlAsync(type: GlslTransitionType): Promise<string> {
  const cached = readStill(type);
  if (cached) return cached;
  const generation = resourceGeneration;
  try {
    await Promise.all([ensureSampleFrame('out'), ensureSampleFrame('in')]);
    if (resourceGeneration !== generation) return '';
    return transitionThumbUrl(type);
  } catch {
    return '';
  } finally {
    disposeIdleTransitionThumbRuntime();
  }
}

export function clearTransitionThumbStillCache(): void {
  stills.clear();
  stillBytes = 0;
}
