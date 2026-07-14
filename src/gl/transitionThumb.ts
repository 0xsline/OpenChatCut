import type { GlslTransitionType } from '../editor/types';
import { createGlRuntime, type GlRuntime } from './runtime';
import { GLSL_TRANSITIONS } from './transitions';

// Shared WebGL transition previews for the resource-library cards.
// One GL context (browser limit ~16): static mid-frame data-URLs + live
// hover animation both route through the same samples + runtime.

export const THUMB_W = 132;
export const THUMB_H = 74;
/** mid-straddle progress — resting card state (most wipes/dissolves read well) */
const PREVIEW_PROGRESS = 0.48;
/** full 0→1 playthrough duration on hover (ms), ~source library feel */
export const HOVER_DURATION_MS = 1100;

let glCanvas: HTMLCanvasElement | null = null;
let rt: GlRuntime | null = null;
let sampleA: HTMLCanvasElement | null = null;
let sampleB: HTMLCanvasElement | null = null;

function paintSample(kind: 'out' | 'in'): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = THUMB_W;
  c.height = THUMB_H;
  const ctx = c.getContext('2d')!;
  if (kind === 'out') {
    // cool landscape-ish gradient (outgoing)
    const g = ctx.createLinearGradient(0, 0, THUMB_W, THUMB_H);
    g.addColorStop(0, '#1a3a5c');
    g.addColorStop(0.55, '#5aa8e8');
    g.addColorStop(1, '#c8e6ff');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, THUMB_W, THUMB_H);
    ctx.fillStyle = '#0d2035';
    ctx.beginPath();
    ctx.moveTo(0, THUMB_H * 0.62);
    ctx.lineTo(THUMB_W * 0.35, THUMB_H * 0.48);
    ctx.lineTo(THUMB_W * 0.7, THUMB_H * 0.68);
    ctx.lineTo(THUMB_W, THUMB_H * 0.55);
    ctx.lineTo(THUMB_W, THUMB_H);
    ctx.lineTo(0, THUMB_H);
    ctx.fill();
    ctx.fillStyle = '#fff8';
    ctx.beginPath();
    ctx.arc(THUMB_W * 0.22, THUMB_H * 0.28, THUMB_H * 0.12, 0, Math.PI * 2);
    ctx.fill();
  } else {
    // warm interior-ish gradient (incoming)
    const g = ctx.createLinearGradient(0, 0, THUMB_W, THUMB_H);
    g.addColorStop(0, '#3a2010');
    g.addColorStop(0.45, '#d4893a');
    g.addColorStop(1, '#ffe0a0');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, THUMB_W, THUMB_H);
    ctx.fillStyle = '#1a1008';
    ctx.fillRect(THUMB_W * 0.18, THUMB_H * 0.35, THUMB_W * 0.64, THUMB_H * 0.5);
    ctx.fillStyle = '#ffd27a';
    ctx.fillRect(THUMB_W * 0.28, THUMB_H * 0.45, THUMB_W * 0.18, THUMB_H * 0.28);
    ctx.fillStyle = '#8ec8ff';
    ctx.fillRect(THUMB_W * 0.55, THUMB_H * 0.48, THUMB_W * 0.18, THUMB_H * 0.18);
  }
  return c;
}

function ensureRuntime(): boolean {
  if (glCanvas && rt && sampleA && sampleB) return true;
  try {
    glCanvas = document.createElement('canvas');
    glCanvas.width = THUMB_W;
    glCanvas.height = THUMB_H;
    rt = createGlRuntime(glCanvas);
    sampleA = paintSample('out');
    sampleB = paintSample('in');
    return true;
  } catch {
    glCanvas = null;
    rt = null;
    return false;
  }
}

/**
 * Render one transition frame into `dest` (canvas or 2d context).
 * Shared GL is not preserved — caller must use the result immediately.
 */
export function drawTransitionFrame(
  dest: HTMLCanvasElement | CanvasRenderingContext2D,
  type: GlslTransitionType,
  progress: number,
): boolean {
  try {
    if (!ensureRuntime()) return false;
    const def = GLSL_TRANSITIONS[type];
    if (!def || !glCanvas || !rt || !sampleA || !sampleB) return false;
    const aspect = THUMB_W / THUMB_H;
    // wall-clock-ish for time-varying noise (organic dissolve)
    const time = progress * 1.2;
    const extra = def.uniforms({ time, aspect, direction: 'left' });
    rt.render(def.frag, sampleA, sampleB, progress, extra);

    const ctx = dest instanceof HTMLCanvasElement ? dest.getContext('2d') : dest;
    if (!ctx) return false;
    const w = dest instanceof HTMLCanvasElement ? dest.width : ctx.canvas.width;
    const h = dest instanceof HTMLCanvasElement ? dest.height : ctx.canvas.height;
    ctx.fillStyle = '#141414';
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(glCanvas, 0, 0, w, h);
    return true;
  } catch {
    return false;
  }
}

const cache = new Map<string, string>();

/** memoized data-URL thumbnail of a GLSL transition at mid progress */
export function transitionThumbUrl(type: GlslTransitionType): string {
  const hit = cache.get(type);
  if (hit) return hit;
  try {
    if (!ensureRuntime()) return '';
    const off = document.createElement('canvas');
    off.width = THUMB_W;
    off.height = THUMB_H;
    if (!drawTransitionFrame(off, type, PREVIEW_PROGRESS)) return '';
    const url = off.toDataURL('image/png');
    cache.set(type, url);
    return url;
  } catch {
    return '';
  }
}
