export const EXPORT_RESOLUTIONS = { '480p': 480, '720p': 720, '1080p': 1080, '4k': 2160 } as const;
export type ExportResolution = keyof typeof EXPORT_RESOLUTIONS;

export const EXPORT_FPS_OPTIONS = [24, 25, 30, 50, 60] as const;

/** Both Remotion renderers (`@remotion/renderer`, `@remotion/web-renderer`) reject `scale > 16`. */
export const MAX_RENDER_SCALE = 16;
/**
 * Hardware H.264 encoders (NVENC, VideoToolbox, QSV, and the GPU behind
 * WebCodecs) cap each dimension at 4096. Mirrors H264_HARDWARE_MAX_DIMENSION in
 * remotion/performance.mjs, which the server renderer enforces at render time.
 */
export const H264_HARDWARE_MAX_DIMENSION = 4096;
/**
 * How far (relative to the requested scale) the local renderer may land from
 * the preset before the size is treated as unreachable on that route. Beyond
 * this the nearest exact scale is a different resolution, not an approximation
 * of the one the user picked.
 */
const SERVER_SCALE_TOLERANCE = 0.1;

interface ExportDimensions {
  width: number;
  height: number;
  scale: number;
}

export interface ServerExportDimensions extends ExportDimensions {
  /**
   * False when no scale the local renderer accepts lands within tolerance of
   * the preset. The dimensions are then the nearest exact size, for display;
   * the export itself should take the browser route or fail preflight.
   */
  representable: boolean;
}

interface SafeRenderPlan {
  browser: ExportDimensions;
  server: ServerExportDimensions;
}

const canvasDimension = (value: unknown, fallback: number): number => {
  const dimension = Number(value);
  return Number.isFinite(dimension) && dimension > 0 ? dimension : fallback;
};

function greatestCommonDivisor(a: number, b: number): number {
  let left = Math.abs(a);
  let right = Math.abs(b);
  while (right > 0) {
    const next = left % right;
    left = right;
    right = next;
  }
  return left || 1;
}

function withinHardwareCap(width: number, height: number): boolean {
  return width <= H264_HARDWARE_MAX_DIMENSION && height <= H264_HARDWARE_MAX_DIMENSION;
}

/**
 * A double `scale` such that `width * scale` and `height * scale` are EXACTLY
 * the integer candidates as JavaScript computes them. Rational exactness is not
 * enough: 25 * 86.4 is 2160.0000000000005 and 1272 * (480 / 1272) is
 * 480.00000000000006, and Remotion validates the float product. The nearest
 * double to the ratio is not always the one whose products round cleanly, so
 * try each natural representation and a few neighbouring doubles of each.
 */
function exactScale(
  width: number,
  height: number,
  candidateWidth: number,
  candidateHeight: number,
  seed: number,
): number | null {
  for (const base of [seed, candidateWidth / width, candidateHeight / height]) {
    for (let nudge = 0; nudge <= 8; nudge += 1) {
      for (const direction of nudge === 0 ? [0] : [1, -1]) {
        const scale = base * (1 + direction * nudge * Number.EPSILON);
        if (width * scale === candidateWidth && height * scale === candidateHeight) return scale;
      }
    }
  }
  return null;
}

/**
 * The local renderer's plan. Remotion multiplies the composition size by
 * `scale` with no rounding and rejects a fractional product ("must be an
 * integer"); the composition cannot be resized instead, because
 * TimelineComposition lays every layer out in state.width/state.height
 * coordinates, so `scale` is the only knob that resizes without moving content.
 *
 * A scale of m/n in lowest terms lands BOTH axes on integers only when n
 * divides gcd(width, height), so the achievable sizes are exactly the even
 * multiples of the reduced aspect ratio. That grid is fine for 16:9 canvases
 * (gcd 120) and coarse for odd ones: 1366x768 (gcd 2) can only be rendered at
 * integer scales, so no 480p exists on this route and the caller must say so
 * rather than silently render a different resolution.
 *
 * Ties prefer the candidate a hardware H.264 encoder can still take (both
 * dimensions within 4096), then the larger one so an export is never smaller
 * than requested when the choice is otherwise even.
 */
function serverRenderPlan(width: number, height: number, targetScale: number): ServerExportDimensions {
  const divisor = greatestCommonDivisor(width, height);
  const unitWidth = width / divisor;
  const unitHeight = height / divisor;
  const ideal = targetScale * divisor;
  // Both axes are even at every second step at worst, and the exact-float
  // search rejects only a few steps, so a window this wide always holds a
  // candidate for any target this function is asked for.
  let best: ExportDimensions | null = null;
  let bestDistance = Infinity;
  for (let step = Math.max(1, Math.floor(ideal) - 24); step <= Math.ceil(ideal) + 24; step += 1) {
    const candidateWidth = unitWidth * step;
    const candidateHeight = unitHeight * step;
    if (candidateWidth % 2 !== 0 || candidateHeight % 2 !== 0) continue;
    const scale = exactScale(width, height, candidateWidth, candidateHeight, step / divisor);
    if (scale === null || scale > MAX_RENDER_SCALE) continue;
    const distance = Math.abs(scale - targetScale);
    if (best && distance > bestDistance) continue;
    if (best && distance === bestDistance) {
      const bestOnHardware = withinHardwareCap(best.width, best.height);
      const candidateOnHardware = withinHardwareCap(candidateWidth, candidateHeight);
      if (bestOnHardware && !candidateOnHardware) continue;
      if (bestOnHardware === candidateOnHardware && scale < best.scale) continue;
    }
    best = { width: candidateWidth, height: candidateHeight, scale };
    bestDistance = distance;
  }
  if (!best) {
    // Unreachable in practice (see the window comment); report the canvas
    // itself as an honest, always-exact size rather than invent a fractional one.
    return { width, height, scale: 1, representable: false };
  }
  return { ...best, representable: bestDistance <= targetScale * SERVER_SCALE_TOLERANCE };
}

/**
 * The browser plan. `@remotion/web-renderer` sizes its canvas with
 * Math.ceil(dimension * scale), so any scale is acceptable as long as the
 * ceilings are even; the search below picks the even size nearest the preset
 * and a scale whose ceilings land exactly on it. This is what lets the browser
 * route export every canvas, including the ones the local renderer cannot.
 */
function browserRenderPlan(width: number, height: number, targetScale: number): ExportDimensions {
  const baseWidth = Math.max(2, Math.ceil(width * targetScale));
  const baseHeight = Math.max(2, Math.ceil(height * targetScale));
  const nearestWidth = Math.max(2, Math.round(baseWidth / 2) * 2);
  const nearestHeight = Math.max(2, Math.round(baseHeight / 2) * 2);
  let best: ExportDimensions | null = null;
  let bestDistance = Infinity;
  for (let widthOffset = -32; widthOffset <= 32; widthOffset += 2) {
    const candidateWidth = nearestWidth + widthOffset;
    if (candidateWidth < 2) continue;
    for (let heightOffset = -32; heightOffset <= 32; heightOffset += 2) {
      const candidateHeight = nearestHeight + heightOffset;
      if (candidateHeight < 2) continue;
      const lower = Math.max((candidateWidth - 1) / width, (candidateHeight - 1) / height);
      const upper = Math.min(candidateWidth / width, candidateHeight / height);
      if (lower >= upper) continue;
      const scale = targetScale > lower && targetScale < upper ? targetScale : (lower + upper) / 2;
      if (scale > MAX_RENDER_SCALE) continue;
      if (Math.ceil(width * scale) !== candidateWidth || Math.ceil(height * scale) !== candidateHeight) continue;
      const distance = Math.abs(scale - targetScale);
      if (best && distance >= bestDistance) continue;
      best = { width: candidateWidth, height: candidateHeight, scale };
      bestDistance = distance;
    }
  }
  return best ?? { width: baseWidth, height: baseHeight, scale: targetScale };
}

function renderPlan(
  state: { width?: unknown; height?: unknown },
  resolution?: ExportResolution,
): SafeRenderPlan {
  const width = Math.max(2, Math.round(canvasDimension(state.width, 1920)));
  const height = Math.max(2, Math.round(canvasDimension(state.height, 1080)));
  if (!resolution) {
    const native = { width, height, scale: 1 };
    return { browser: native, server: { ...native, representable: true } };
  }
  // Clamp rather than reject: a tiny canvas asked for 4k gets the largest
  // render either renderer accepts instead of a "scale must be <= 16" throw.
  const targetScale = Math.min(MAX_RENDER_SCALE, EXPORT_RESOLUTIONS[resolution] / Math.min(width, height));
  return {
    browser: browserRenderPlan(width, height, targetScale),
    server: serverRenderPlan(width, height, targetScale),
  };
}

/** Resolution preset -> the local renderer's exact scale, based on the shorter canvas side. */
export function exportScale(
  state: { width?: unknown; height?: unknown },
  resolution?: ExportResolution,
): number {
  return renderPlan(state, resolution).server.scale;
}

/** The local renderer's output size, and whether that route can honour the preset at all. */
export function serverScaledExportDimensions(
  state: { width?: unknown; height?: unknown },
  resolution?: ExportResolution,
): ServerExportDimensions {
  return renderPlan(state, resolution).server;
}

export function scaledExportDimensions(
  state: { width?: unknown; height?: unknown },
  resolution?: ExportResolution,
): ExportDimensions {
  const { width, height, scale } = renderPlan(state, resolution).server;
  return { width, height, scale };
}

export function webScaledExportDimensions(
  state: { width?: unknown; height?: unknown },
  resolution?: ExportResolution,
): ExportDimensions {
  return renderPlan(state, resolution).browser;
}
