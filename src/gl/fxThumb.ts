import { createGlRuntime, type GlRuntime, type UniformValue } from './runtime';
import { ensureCube, getCubeSync } from './fx/cube';
import { fxUniforms, type FxDef } from './fx/effects';
import { ensureSampleFrame, getSampleFrame, SAMPLE_H, SAMPLE_W } from './sampleFrames';

// Shared WebGL FX/LUT library-card previews. Photoreal sample frame + stronger
// hover animation (u_time + property pulses so static effects also move).

export const FX_THUMB_W = SAMPLE_W;
export const FX_THUMB_H = SAMPLE_H;
export const FX_HOVER_MS = 1600;

let glCanvas: HTMLCanvasElement | null = null;
let rt: GlRuntime | null = null;

function ensureRuntime(): boolean {
  if (glCanvas && rt) return true;
  try {
    glCanvas = document.createElement('canvas');
    glCanvas.width = FX_THUMB_W;
    glCanvas.height = FX_THUMB_H;
    rt = createGlRuntime(glCanvas);
    return true;
  } catch {
    glCanvas = null;
    rt = null;
    return false;
  }
}

/**
 * Per-effect hover overrides so static filters (mask/mosaic/magnify/LUT) still
 * read as obvious motion. `phase` is 0..1 over one hover cycle.
 */
export function fxHoverOverrides(def: FxDef, phase: number): Record<string, UniformValue> {
  // ease triangle: 0→1→0 so loop is seamless
  const tri = phase < 0.5 ? phase * 2 : (1 - phase) * 2;
  const p = tri * tri * (3 - 2 * tri); // smoothstep
  const id = def.id;
  if (id.includes('magnify')) {
    return { magnification: 1.4 + p * 3.2, radius: 0.1 + p * 0.22 };
  }
  if (id.includes('local-mosaic')) {
    return { block_size: 6 + p * 55, width_ratio: 0.25 + p * 0.2, height_ratio: 0.25 + p * 0.2 };
  }
  if (id.includes('circle-mask')) {
    return { radius: 0.12 + p * 0.42 };
  }
  if (id.includes('rect-mask')) {
    return { width: 0.28 + p * 0.5, height: 0.28 + p * 0.45, corner_radius: p * 40 };
  }
  if (id.includes('tilt-shift')) {
    return { focusY: 0.25 + p * 0.5, blurStrength: 6 + p * 28, saturation: 1 + p * 0.8 };
  }
  if (id.includes('luma-key')) {
    return { intensity: 0.4 + p * 2.2, threshold: 0.01 + p * 0.08 };
  }
  if (id.includes('chroma-key')) {
    return { similarity: 0.08 + p * 0.35, smoothness: 0.04 + p * 0.15 };
  }
  if (id.includes('crt')) {
    return { scanlineIntensity: 0.2 + p * 0.7, curvature: 0.05 + p * 0.35, rgbShift: 0.001 + p * 0.02 };
  }
  if (id.includes('shake')) {
    return { strength: 0.6 + p * 3.5, speed: 1.2 + p * 4, rotation: 0.4 + p * 2.5 };
  }
  if (id.includes('ascii')) {
    return { glow: 0.6 + p * 2.8, gridSize: 6 + p * 14 };
  }
  if (id.includes('vignette')) return { amount: 0.2 + p * 0.75 };
  if (id.includes('film-grain')) return { amount: 0.05 + p * 0.4 };
  if (id.includes('rgb-split')) return { amount: 0.002 + p * 0.03, angle: p * 6.28 };
  if (id.includes('glitch')) return { intensity: 0.3 + p * 1.5 };
  if (id.includes('bloom')) return { intensity: 0.2 + p * 2.2, threshold: 0.3 + p * 0.4 };
  if (id.includes('pixelate')) return { blockSize: 4 + p * 40 };
  if (id.includes('posterize')) return { levels: 3 + p * 10 };
  if (id.includes('duotone')) return { intensity: 0.3 + p * 0.7 };
  if (id.includes('mirror')) return { axis: 0.35 + p * 0.3 };
  if (id.includes('fisheye')) return { strength: 0.15 + p * 1.1 };
  if (id.includes('kaleidoscope')) return { angle: p * 6.28, segments: 4 + Math.floor(p * 8) };
  if (id.includes('edge-glow')) return { strength: 0.4 + p * 3 };
  if (id.includes('soft-blur')) return { amount: 0.5 + p * 8 };
  if (id.includes('light-leak')) return { intensity: 0.2 + p * 1.1, angle: p * 6.28 };
  if (id.includes('look-') || id.includes('slog3') || id.includes('canon-log') || id.includes('lut')) {
    return { intensity: p };
  }
  return {};
}

function renderFx(def: FxDef, time: number, overrides?: Record<string, UniformValue>): boolean {
  const sample = getSampleFrame('fx');
  if (!sample || !ensureRuntime() || !rt || !glCanvas) return false;
  const u = { ...fxUniforms(def, overrides), u_time: time };
  // cube LUT card: Don’t draw until the data arrives (the asynchronous entry will wait ensureCube again)
  const lut3d = def.cube ? getCubeSync(def.cube) ?? undefined : undefined;
  if (def.cube && !lut3d) return false;
  if (def.pipeline) rt.renderFxChain(def.pipeline(u), sample);
  else if (def.passes && def.passes.length > 1) {
    rt.renderFxChain(def.passes.map((frag) => ({ frag, uniforms: u })), sample);
  } else {
    rt.renderFx(def.frag, sample, u, lut3d);
  }
  return true;
}

/** draw one FX frame into dest */
export function drawFxFrame(
  dest: HTMLCanvasElement | CanvasRenderingContext2D,
  def: FxDef,
  time = 0.5,
  overrides?: Record<string, UniformValue>,
): boolean {
  try {
    if (!renderFx(def, time, overrides) || !glCanvas) return false;
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

/** memoized still at rest (defaults + time 0.5) */
export function fxThumbUrl(def: FxDef): string {
  const hit = cache.get(def.id);
  if (hit) return hit;
  try {
    if (!getSampleFrame('fx')) return '';
    const off = document.createElement('canvas');
    off.width = FX_THUMB_W;
    off.height = FX_THUMB_H;
    if (!drawFxFrame(off, def, 0.5)) return '';
    const url = off.toDataURL('image/jpeg', 0.85);
    cache.set(def.id, url);
    return url;
  } catch {
    return '';
  }
}

/** wait for sample photo (and the def's .cube LUT) then return still URL */
export async function fxThumbUrlAsync(def: FxDef): Promise<string> {
  await ensureSampleFrame('fx');
  if (def.cube) await ensureCube(def.cube);
  cache.delete(def.id);
  return fxThumbUrl(def);
}
