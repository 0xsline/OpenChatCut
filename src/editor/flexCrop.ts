import type { FlexCrop } from './clipTypes';

/** Minimum remaining visible span while edge-cropping (canvas fraction). */
export const PREVIEW_CROP_MIN_SPAN = 0.05;

export type FlexCropEdge = keyof Required<FlexCrop>;

const CROP_OPPOSITE: Record<FlexCropEdge, FlexCropEdge> = {
  left: 'right',
  right: 'left',
  top: 'bottom',
  bottom: 'top',
};

export function normalizedFlexCrop(crop: FlexCrop | undefined): Required<FlexCrop> {
  return {
    left: crop?.left ?? 0,
    top: crop?.top ?? 0,
    right: crop?.right ?? 0,
    bottom: crop?.bottom ?? 0,
  };
}

/** Drop a no-op crop. Do not 1e-6-round: that added/subtracted decimals so
 *  Crop Top N px and N+1 px could store the same value or skip a pixel. */
export function compactFlexCrop(crop: Required<FlexCrop>): FlexCrop | undefined {
  const next = {
    left: Math.max(0, crop.left),
    top: Math.max(0, crop.top),
    right: Math.max(0, crop.right),
    bottom: Math.max(0, crop.bottom),
  };
  if (next.left <= 0 && next.top <= 0 && next.right <= 0 && next.bottom <= 0) return undefined;
  return next;
}

export function hasFlexCrop(crop: FlexCrop | undefined): boolean {
  return compactFlexCrop(normalizedFlexCrop(crop)) !== undefined;
}

/** Max inset for one edge so the opposite inset plus this one still leave PREVIEW_CROP_MIN_SPAN. */
export function flexCropEdgeMax(crop: FlexCrop | undefined, edge: FlexCropEdge): number {
  const next = normalizedFlexCrop(crop);
  return Math.max(0, 1 - next[CROP_OPPOSITE[edge]] - PREVIEW_CROP_MIN_SPAN);
}

export function flexCropAxisSize(edge: FlexCropEdge, width: number, height: number): number {
  return edge === 'left' || edge === 'right' ? width : height;
}

/** Integer composition pixels for one stored crop fraction. */
export function flexCropFractionToPx(fraction: number, axis: number): number {
  if (!(axis > 0) || !Number.isFinite(fraction)) return 0;
  return Math.round(Math.max(0, fraction) * axis);
}

/**
 * Render inset in composition pixels. Same rounding as the inspector so a
 * stored N px does not grow into N+1 px of empty padding (compactFlexCrop's
 * 1e-6 snap can sit just above N, and ceil would then eat an extra pixel on
 * Crop Top / Crop Bottom).
 */
export function flexCropRenderPx(fraction: number, axis: number): number {
  return flexCropFractionToPx(fraction, axis);
}

export interface FlexCropRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function flexCropRect(
  crop: FlexCrop | undefined,
  width: number,
  height: number,
): FlexCropRect {
  const next = normalizedFlexCrop(crop);
  const left = flexCropRenderPx(next.left, width);
  const top = flexCropRenderPx(next.top, height);
  const right = flexCropRenderPx(next.right, width);
  const bottom = flexCropRenderPx(next.bottom, height);
  return {
    x: left,
    y: top,
    width: Math.max(0, width - left - right),
    height: Math.max(0, height - top - bottom),
  };
}

export function intersectRects(a: FlexCropRect, b: FlexCropRect): FlexCropRect {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  return { x, y, width: Math.max(0, right - x), height: Math.max(0, bottom - y) };
}

/** Orange outline and clip-path share this: letterboxed picture ∩ canvas crop. */
export function flexCropVisibleRect(
  crop: FlexCrop | undefined,
  canvasWidth: number,
  canvasHeight: number,
  content: FlexCropRect,
): FlexCropRect {
  if (!hasFlexCrop(crop)) return content;
  return intersectRects(content, flexCropRect(crop, canvasWidth, canvasHeight));
}

/**
 * CSS clip-path on the **full canvas** layer, in composition pixels — the same
 * integers as {@link flexCropRect} / the orange outline's crop window.
 *
 * Crop Left/Right already looked flush on a 16:9-in-9:16 contain because the
 * picture fills the canvas width, so a % of the letterboxed box equaled a
 * canvas pixel. Crop Top/Bottom do not: the picture is only a slice of the
 * canvas height, so clipping that slice with canvas fractions (or % of the
 * picture box) drifts from the orange line. Always clip the canvas box.
 */
export function flexCropClipPath(
  crop: FlexCrop | undefined,
  width: number,
  height: number,
): string | undefined {
  if (!hasFlexCrop(crop) || !(width > 0) || !(height > 0)) return undefined;
  const rect = flexCropRect(crop, width, height);
  const top = rect.y;
  const left = rect.x;
  const right = Math.max(0, width - rect.x - rect.width);
  const bottom = Math.max(0, height - rect.y - rect.height);
  if (top + right + bottom + left <= 0) return undefined;
  return `inset(${top}px ${right}px ${bottom}px ${left}px)`;
}

/** Store a pixel inset as an exact canvas fraction (1px at 1920 → 1/1920). */
export function flexCropPxToFraction(px: number, axis: number): number {
  if (!(axis > 0) || !Number.isFinite(px)) return 0;
  return Math.round(Math.max(0, px)) / axis;
}

/** Snap a stored 0–1 inset to a whole composition pixel on that axis. */
export function flexCropSnapFraction(fraction: number, axis: number): number {
  return flexCropPxToFraction(flexCropFractionToPx(fraction, axis), axis);
}

export const FLEX_CROP_EDGES: readonly FlexCropEdge[] = ['left', 'right', 'top', 'bottom'];

/** Inspector / per-edge crop: clamp one inset and compact the stored crop. */
export function flexCropInsetPatch(
  crop: FlexCrop | undefined,
  edge: FlexCropEdge,
  value: number,
): { crop: FlexCrop | undefined } {
  const next = normalizedFlexCrop(crop);
  next[edge] = Math.min(flexCropEdgeMax(crop, edge), Math.max(0, value));
  return { crop: compactFlexCrop(next) };
}

/** Apply one or more edge insets onto an existing crop (agent / multi-edge update). */
export function flexCropMergePatch(
  crop: FlexCrop | undefined,
  patch: FlexCrop,
): { crop: FlexCrop | undefined } {
  let next = crop;
  for (const edge of FLEX_CROP_EDGES) {
    const value = patch[edge];
    if (value === undefined) continue;
    next = flexCropInsetPatch(next, edge, value).crop;
  }
  return { crop: next };
}
