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

export function drawTransitionFrame(
  dest: HTMLCanvasElement | CanvasRenderingContext2D,
  type: GlslTransitionType,
  progress: number,
): boolean {
  try {
    const sampleA = getSampleFrame('out');
    const sampleB = getSampleFrame('in');
    if (!sampleA || !sampleB || !ensureRuntime() || !glCanvas || !rt) return false;
    const def = GLSL_TRANSITIONS[type];
    if (!def) return false;
    const aspect = THUMB_W / THUMB_H;
    const extra = def.uniforms({ time: progress * 2, aspect, direction: 'left' });
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
