import { createGlRuntime, type GlRuntime, type UniformValue } from './runtime';
import { cubeSettled, getCubeSync, parseCube, type CubeLut } from './fx/cube';
import { fxUniforms, type FxDef } from './fx/effects';
import { clearSampleFrames, ensureSampleFrame, getSampleFrame, SAMPLE_H, SAMPLE_W } from './sampleFrames';

// Shared WebGL FX/LUT library-card previews. Photoreal sample frame + stronger
// hover animation (u_time + property pulses so static effects also move).

export const FX_THUMB_W = SAMPLE_W;
export const FX_THUMB_H = SAMPLE_H;
export const FX_HOVER_MS = 1600;

let glCanvas: HTMLCanvasElement | null = null;
let rt: GlRuntime | null = null;
let activeRuntimeUsers = 0;
let resourceGeneration = 0;

const PREVIEW_LUT_MAX_ENTRIES = 4;
const PREVIEW_LUT_MAX_BYTES = 12 * 1024 * 1024;
const previewLuts = new Map<string, { lut: CubeLut | null; bytes: number }>();
const pendingLuts = new Map<string, { controller: AbortController; promise: Promise<CubeLut | null> }>();
let previewLutBytes = 0;

function disposeFxThumbRuntime(): void {
  rt?.dispose();
  rt = null;
  if (glCanvas) {
    glCanvas.width = 0;
    glCanvas.height = 0;
  }
  glCanvas = null;
}

export function acquireFxThumbRuntime(): void {
  activeRuntimeUsers++;
}

export function releaseFxThumbRuntime(): void {
  activeRuntimeUsers = Math.max(0, activeRuntimeUsers - 1);
  if (activeRuntimeUsers === 0) disposeFxThumbRuntime();
}

function ensureRuntime(): boolean {
  if (glCanvas && rt) return true;
  try {
    glCanvas = document.createElement('canvas');
    glCanvas.width = FX_THUMB_W;
    glCanvas.height = FX_THUMB_H;
    rt = createGlRuntime(glCanvas);
    return true;
  } catch {
    disposeFxThumbRuntime();
    return false;
  }
}

function readPreviewLut(url: string): CubeLut | null | undefined {
  const entry = previewLuts.get(url);
  if (!entry) return undefined;
  previewLuts.delete(url);
  previewLuts.set(url, entry);
  return entry.lut;
}

function cachePreviewLut(url: string, lut: CubeLut | null): void {
  const previous = previewLuts.get(url);
  if (previous) previewLutBytes -= previous.bytes;
  previewLuts.delete(url);
  const bytes = lut?.data.byteLength ?? 0;
  if (bytes > PREVIEW_LUT_MAX_BYTES) return;
  previewLuts.set(url, { lut, bytes });
  previewLutBytes += bytes;
  while (previewLuts.size > PREVIEW_LUT_MAX_ENTRIES || previewLutBytes > PREVIEW_LUT_MAX_BYTES) {
    const oldest = previewLuts.keys().next().value as string | undefined;
    if (!oldest) break;
    previewLutBytes -= previewLuts.get(oldest)?.bytes ?? 0;
    previewLuts.delete(oldest);
  }
}

function activeOrPreviewLut(url: string): CubeLut | null | undefined {
  const active = getCubeSync(url);
  if (active) return active;
  const preview = readPreviewLut(url);
  if (preview !== undefined) return preview;
  return cubeSettled(url) ? null : undefined;
}

function fetchPreviewLut(url: string, controller: AbortController): Promise<CubeLut | null> {
  return fetch(url, { signal: controller.signal })
    .then((response) => {
      if (!response.ok) throw new Error(`LUT preview HTTP ${response.status}`);
      return response.text();
    })
    .then(parseCube)
    .catch(() => null);
}

async function ensurePreviewLut(url: string): Promise<CubeLut | null> {
  const cached = activeOrPreviewLut(url);
  if (cached !== undefined) return cached;
  const inflight = pendingLuts.get(url);
  if (inflight) return inflight.promise;
  const generation = resourceGeneration;
  const controller = new AbortController();
  let promise: Promise<CubeLut | null>;
  promise = fetchPreviewLut(url, controller).then((lut) => {
    if (resourceGeneration === generation && !controller.signal.aborted) cachePreviewLut(url, lut);
    return lut;
  }).finally(() => {
    if (pendingLuts.get(url)?.promise === promise) pendingLuts.delete(url);
  });
  pendingLuts.set(url, { controller, promise });
  return promise;
}

function clearPreviewLuts(): void {
  resourceGeneration++;
  for (const { controller } of pendingLuts.values()) controller.abort();
  pendingLuts.clear();
  previewLuts.clear();
  previewLutBytes = 0;
}

/** Release decoded/runtime data when leaving FX or LUT resources; encoded stills stay in bounded LRU. */
export function cleanupFxThumbResources(): void {
  clearPreviewLuts();
  clearSampleFrames(['fx']);
  disposeFxThumbRuntime();
}

/**
 * Per-effect hover overrides so static filters (mask/mosaic/magnify/LUT) still
 * read as obvious motion. `phase` is 0..1 over one hover cycle.
 */
type FxOverrides = Record<string, UniformValue>;

function spatialHoverOverrides(id: string, p: number): FxOverrides | null {
  if (id.includes('magnify')) return { magnification: 1.4 + p * 3.2, radius: 0.1 + p * 0.22 };
  if (id.includes('local-mosaic')) {
    return { block_size: 6 + p * 55, width_ratio: 0.25 + p * 0.2, height_ratio: 0.25 + p * 0.2 };
  }
  if (id.includes('circle-mask')) return { radius: 0.12 + p * 0.42 };
  if (id.includes('rect-mask')) {
    return { width: 0.28 + p * 0.5, height: 0.28 + p * 0.45, corner_radius: p * 40 };
  }
  if (id.includes('tilt-shift')) {
    return { focusY: 0.25 + p * 0.5, blurStrength: 6 + p * 28, saturation: 1 + p * 0.8 };
  }
  if (id.includes('luma-key')) return { intensity: 0.4 + p * 2.2, threshold: 0.01 + p * 0.08 };
  if (id.includes('chroma-key')) {
    return { similarity: 0.08 + p * 0.35, smoothness: 0.04 + p * 0.15 };
  }
  return null;
}

function animatedHoverOverrides(id: string, p: number): FxOverrides {
  if (id.includes('crt')) return { scanlineIntensity: 0.2 + p * 0.7, curvature: 0.05 + p * 0.35, rgbShift: 0.001 + p * 0.02 };
  if (id.includes('shake')) return { strength: 0.6 + p * 3.5, speed: 1.2 + p * 4, rotation: 0.4 + p * 2.5 };
  if (id.includes('ascii')) return { glow: 0.6 + p * 2.8, gridSize: 6 + p * 14 };
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
  if (id.includes('look-') || id.includes('slog3') || id.includes('canon-log') || id.includes('lut')) return { intensity: p };
  return {};
}

export function fxHoverOverrides(def: FxDef, phase: number): FxOverrides {
  const tri = phase < 0.5 ? phase * 2 : (1 - phase) * 2;
  const p = tri * tri * (3 - 2 * tri);
  return spatialHoverOverrides(def.id, p) ?? animatedHoverOverrides(def.id, p);
}

function renderFx(def: FxDef, time: number, overrides?: Record<string, UniformValue>): boolean {
  const sample = getSampleFrame('fx');
  if (!sample || !ensureRuntime() || !rt || !glCanvas) return false;
  const u = { ...fxUniforms(def, overrides), u_time: time };
  const lut3d = def.cube ? activeOrPreviewLut(def.cube) ?? undefined : undefined;
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

const STILL_MAX_ENTRIES = 48;
const STILL_MAX_BYTES = 6 * 1024 * 1024;
const stills = new Map<string, { url: string; bytes: number }>();
let stillBytes = 0;

function readStill(id: string): string | undefined {
  const entry = stills.get(id);
  if (!entry) return undefined;
  stills.delete(id);
  stills.set(id, entry);
  return entry.url;
}

export function getCachedFxThumbUrl(id: string): string {
  return readStill(id) ?? '';
}

function cacheStill(id: string, url: string): void {
  const previous = stills.get(id);
  if (previous) stillBytes -= previous.bytes;
  stills.delete(id);
  const bytes = url.length * 2;
  if (bytes > STILL_MAX_BYTES) return;
  stills.set(id, { url, bytes });
  stillBytes += bytes;
  while (stills.size > STILL_MAX_ENTRIES || stillBytes > STILL_MAX_BYTES) {
    const oldest = stills.keys().next().value as string | undefined;
    if (!oldest) break;
    stillBytes -= stills.get(oldest)?.bytes ?? 0;
    stills.delete(oldest);
  }
}

/** memoized still at rest (defaults + time 0.5) */
export function fxThumbUrl(def: FxDef): string {
  const hit = readStill(def.id);
  if (hit) return hit;
  try {
    if (!getSampleFrame('fx')) return '';
    const off = document.createElement('canvas');
    off.width = FX_THUMB_W;
    off.height = FX_THUMB_H;
    if (!drawFxFrame(off, def, 0.5)) return '';
    const url = off.toDataURL('image/jpeg', 0.85);
    cacheStill(def.id, url);
    return url;
  } catch {
    return '';
  }
}

/** wait for sample photo (and the def's .cube LUT) then return still URL */
export async function fxThumbUrlAsync(def: FxDef): Promise<string> {
  const cached = readStill(def.id);
  if (cached) return cached;
  const generation = resourceGeneration;
  try {
    await ensureSampleFrame('fx');
    if (resourceGeneration !== generation) return '';
    if (def.cube && !await ensurePreviewLut(def.cube)) return '';
    if (resourceGeneration !== generation) return '';
    return fxThumbUrl(def);
  } catch {
    return '';
  } finally {
    if (activeRuntimeUsers === 0) disposeFxThumbRuntime();
  }
}

export function clearFxThumbStillCache(): void {
  stills.clear();
  stillBytes = 0;
}
