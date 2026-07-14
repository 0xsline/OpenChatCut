import { createGlRuntime, type GlRuntime } from './runtime';
import { fxUniforms, type FxDef } from './fx/effects';

// Render a per-clip effect to a small preview thumbnail (data URL) for the
// resource-library cards. Uses ONE shared WebGL context (browsers cap ~16), and
// copies each result to a 2D canvas immediately after draw (the GL drawing
// buffer isn't preserved). A synthetic sample frame — gradient + a bright disc +
// a dark corner — exercises color grades, keys, masks and blurs visibly.

const W = 132;
const H = 74;

let glCanvas: HTMLCanvasElement | null = null;
let rt: GlRuntime | null = null;
let sample: HTMLCanvasElement | null = null;

function buildSample(): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const ctx = c.getContext('2d')!;
  const g = ctx.createLinearGradient(0, 0, W, H);
  g.addColorStop(0, '#0a1830');
  g.addColorStop(0.5, '#3aa0ff');
  g.addColorStop(1, '#ffd27a');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = '#000';           // dark corner → luma-key / masks show it
  ctx.fillRect(0, 0, W * 0.28, H * 0.4);
  ctx.fillStyle = '#fff';           // bright disc → magnify / grade highlight
  ctx.beginPath();
  ctx.arc(W * 0.68, H * 0.55, H * 0.24, 0, Math.PI * 2);
  ctx.fill();
  return c;
}

const cache = new Map<string, string>();

/** memoized data-URL thumbnail of `def` applied to the sample frame */
export function fxThumbUrl(def: FxDef): string {
  const hit = cache.get(def.id);
  if (hit) return hit;
  try {
    if (!glCanvas) {
      glCanvas = document.createElement('canvas');
      glCanvas.width = W;
      glCanvas.height = H;
      rt = createGlRuntime(glCanvas);
      sample = buildSample();
    }
    const u = { ...fxUniforms(def), u_time: 0.5 };
    if (def.passes && def.passes.length > 1) rt!.renderFxChain(def.passes.map((frag) => ({ frag, uniforms: u })), sample!);
    else rt!.renderFx(def.frag, sample!, u);
    // copy immediately (buffer not preserved); dark bg shows through masked areas
    const out = document.createElement('canvas');
    out.width = W;
    out.height = H;
    const ctx = out.getContext('2d')!;
    ctx.fillStyle = '#141414';
    ctx.fillRect(0, 0, W, H);
    ctx.drawImage(glCanvas, 0, 0);
    const url = out.toDataURL('image/png');
    cache.set(def.id, url);
    return url;
  } catch {
    return '';
  }
}
