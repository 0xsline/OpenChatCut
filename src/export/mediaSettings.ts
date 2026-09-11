export const EXPORT_RESOLUTIONS = { '480p': 480, '720p': 720, '1080p': 1080, '4k': 2160 } as const;
export type ExportResolution = keyof typeof EXPORT_RESOLUTIONS;

export const EXPORT_FPS_OPTIONS = [24, 25, 30, 50, 60] as const;

interface ExportDimensions {
  width: number;
  height: number;
  scale: number;
}

interface SafeRenderPlan {
  width: number;
  height: number;
  browserScale: number;
  serverScale: number;
  distance: number;
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

/**
 * Pick output dimensions and the scale that produces them.
 *
 * Two hard constraints, and they interact:
 *
 * 1. Remotion multiplies the composition size by `scale` and REJECTS a
 *    fractional product — `stitchFramesToVideo()` throws "must be an integer".
 *    The composition cannot simply be resized instead: TimelineComposition
 *    lays every layer out in state.width/state.height coordinates, so `scale`
 *    is the only knob that upscales without moving content.
 * 2. H.264 with yuv420p requires both dimensions to be even; an odd one fails
 *    with "width not divisible by 2" and writes a zero-byte file.
 *
 * A scale of m/n in lowest terms lands BOTH axes on integers only when n
 * divides gcd(width, height), so the achievable scales are exactly k/g for
 * integer k. Enumerating those directly is what makes the result
 * representable; the previous implementation searched pixel offsets and
 * accepted any candidate that merely ROUNDED to an even number, which is why a
 * 1920x714 scope timeline asked for 5808.403361344537 pixels and could not be
 * rendered at all.
 *
 * Ties prefer the larger scale, so an exportable size is never smaller than
 * the one requested.
 */
function safeRenderPlan(width: number, height: number, targetScale: number): SafeRenderPlan {
  const sourceWidth = Math.max(2, Math.round(width));
  const sourceHeight = Math.max(2, Math.round(height));
  const divisor = greatestCommonDivisor(sourceWidth, sourceHeight);
  const unitWidth = sourceWidth / divisor;
  const unitHeight = sourceHeight / divisor;
  const ideal = targetScale * divisor;
  // Both axes are even at every second achievable step at worst, so a window
  // around the ideal always contains one when the aspect ratio permits any.
  const lowest = Math.max(1, Math.floor(ideal) - 24);
  let best: SafeRenderPlan | null = null;
  for (let step = lowest; step <= Math.ceil(ideal) + 24; step += 1) {
    const candidateWidth = unitWidth * step;
    const candidateHeight = unitHeight * step;
    if (candidateWidth % 2 !== 0 || candidateHeight % 2 !== 0) continue;
    if (candidateWidth < 2 || candidateHeight < 2) continue;
    const scale = step / divisor;
    // Exact in arithmetic is not enough: Remotion validates the product as
    // JavaScript computes it, and 25 * 86.4 is 2160.0000000000005. Only keep a
    // scale whose float product lands exactly on the candidate.
    if (sourceWidth * scale !== candidateWidth || sourceHeight * scale !== candidateHeight) continue;
    const distance = Math.abs(scale - targetScale);
    if (best && (distance > best.distance || (distance === best.distance && scale < best.browserScale))) continue;
    best = {
      width: candidateWidth,
      height: candidateHeight,
      browserScale: scale,
      serverScale: scale,
      distance,
    };
  }
  if (best) return best;
  // No even-by-even multiple exists for this aspect ratio (an odd unit ratio
  // whose window held nothing). Fall back to the nearest even raster; the
  // renderer still receives integers, which is the constraint that matters.
  const fallbackWidth = Math.max(2, Math.round(sourceWidth * targetScale / 2) * 2);
  const fallbackHeight = Math.max(2, Math.round(sourceHeight * targetScale / 2) * 2);
  return {
    width: fallbackWidth,
    height: fallbackHeight,
    browserScale: fallbackWidth / sourceWidth,
    serverScale: fallbackWidth / sourceWidth,
    distance: Math.abs(fallbackWidth / sourceWidth - targetScale),
  };
}

function renderPlan(
  state: { width?: unknown; height?: unknown },
  resolution?: ExportResolution,
): SafeRenderPlan {
  const width = canvasDimension(state.width, 1920);
  const height = canvasDimension(state.height, 1080);
  if (!resolution) return { width: Math.round(width), height: Math.round(height), browserScale: 1, serverScale: 1, distance: 0 };
  return safeRenderPlan(width, height, EXPORT_RESOLUTIONS[resolution] / Math.min(width, height));
}

/** Resolution preset -> codec-safe server render scale, based on the shorter canvas side. */
export function exportScale(
  state: { width?: unknown; height?: unknown },
  resolution?: ExportResolution,
): number {
  return renderPlan(state, resolution).serverScale;
}

export function scaledExportDimensions(
  state: { width?: unknown; height?: unknown },
  resolution?: ExportResolution,
): ExportDimensions {
  const plan = renderPlan(state, resolution);
  return { width: plan.width, height: plan.height, scale: plan.serverScale };
}

export function webScaledExportDimensions(
  state: { width?: unknown; height?: unknown },
  resolution?: ExportResolution,
): ExportDimensions {
  const plan = renderPlan(state, resolution);
  return { width: plan.width, height: plan.height, scale: plan.browserScale };
}
