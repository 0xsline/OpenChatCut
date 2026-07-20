import type { GlslTransitionType } from '../editor/types';
import { createGlRuntime, type GlRuntime } from './runtime';
import { ensureSampleFrame, getSampleFrame, SAMPLE_H, SAMPLE_W } from './sampleFrames';
import { GLSL_TRANSITIONS } from './transitions';

// Photoreal A/B samples (outdoor → warm interior) so transition motion is
// obvious. Hover plays full 0→1 with a short hold, then loops.

export const THUMB_W = SAMPLE_W;
export const THUMB_H = SAMPLE_H;
/** resting still — mid-straddle so cards aren't empty */
const PREVIEW_PROGRESS = 0.42;
/** slower + clearer than before so hover reads as a real transition */
export const HOVER_DURATION_MS = 1500;

let glCanvas: HTMLCanvasElement | null = null;
let rt: GlRuntime | null = null;

function ensureRuntime(): boolean {
  if (glCanvas && rt) return true;
  try {
    glCanvas = document.createElement('canvas');
    glCanvas.width = THUMB_W;
    glCanvas.height = THUMB_H;
    rt = createGlRuntime(glCanvas);
    return true;
  } catch {
    glCanvas = null;
    rt = null;
    return false;
  }
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

const cache = new Map<string, string>();

export function transitionThumbUrl(type: GlslTransitionType): string {
  const hit = cache.get(type);
  if (hit) return hit;
  try {
    if (!getSampleFrame('out') || !getSampleFrame('in')) return '';
    const off = document.createElement('canvas');
    off.width = THUMB_W;
    off.height = THUMB_H;
    if (!drawTransitionFrame(off, type, PREVIEW_PROGRESS)) return '';
    const url = off.toDataURL('image/jpeg', 0.85);
    cache.set(type, url);
    return url;
  } catch {
    return '';
  }
}

export async function transitionThumbUrlAsync(type: GlslTransitionType): Promise<string> {
  await Promise.all([ensureSampleFrame('out'), ensureSampleFrame('in')]);
  cache.delete(type);
  return transitionThumbUrl(type);
}
