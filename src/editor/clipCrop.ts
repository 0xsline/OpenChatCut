import type { ClipCrop } from './clipTypes';

/** Minimum remaining visible span while edge-cropping (canvas fraction). */
export const PREVIEW_CROP_MIN_SPAN = 0.05;

export type ClipCropEdge = keyof Required<ClipCrop>;

const CROP_OPPOSITE: Record<ClipCropEdge, ClipCropEdge> = {
  left: 'right',
  right: 'left',
  top: 'bottom',
  bottom: 'top',
};

export function normalizedClipCrop(crop: ClipCrop | undefined): Required<ClipCrop> {
  return {
    left: crop?.left ?? 0,
    top: crop?.top ?? 0,
    right: crop?.right ?? 0,
    bottom: crop?.bottom ?? 0,
  };
}

/** Drop near-zero crops so the DOM stays free of no-op clip-path. */
export function compactClipCrop(crop: Required<ClipCrop>): ClipCrop | undefined {
  const round = (v: number) => Math.round(v * 1e6) / 1e6;
  const next = {
    left: round(Math.max(0, crop.left)),
    top: round(Math.max(0, crop.top)),
    right: round(Math.max(0, crop.right)),
    bottom: round(Math.max(0, crop.bottom)),
  };
  if (next.left < 1e-6 && next.top < 1e-6 && next.right < 1e-6 && next.bottom < 1e-6) return undefined;
  return next;
}

export function hasClipCrop(crop: ClipCrop | undefined): boolean {
  return compactClipCrop(normalizedClipCrop(crop)) !== undefined;
}

/** Max inset for one edge so the opposite inset plus this one still leave PREVIEW_CROP_MIN_SPAN. */
export function clipCropEdgeMax(crop: ClipCrop | undefined, edge: ClipCropEdge): number {
  const next = normalizedClipCrop(crop);
  return Math.max(0, 1 - next[CROP_OPPOSITE[edge]] - PREVIEW_CROP_MIN_SPAN);
}

export function clipCropAxisSize(edge: ClipCropEdge, width: number, height: number): number {
  return edge === 'left' || edge === 'right' ? width : height;
}

/** Integer composition pixels for one stored crop fraction. */
export function clipCropFractionToPx(fraction: number, axis: number): number {
  if (!(axis > 0) || !Number.isFinite(fraction)) return 0;
  return Math.round(Math.max(0, fraction) * axis);
}

/** Store a pixel inset as a canvas fraction (1px at 1920 → 1/1920). */
export function clipCropPxToFraction(px: number, axis: number): number {
  if (!(axis > 0) || !Number.isFinite(px)) return 0;
  return Math.max(0, px) / axis;
}

export const CLIP_CROP_EDGES: readonly ClipCropEdge[] = ['left', 'right', 'top', 'bottom'];

/** Inspector / per-edge crop: clamp one inset and compact the stored crop. */
export function clipCropInsetPatch(
  crop: ClipCrop | undefined,
  edge: ClipCropEdge,
  value: number,
): { crop: ClipCrop | undefined } {
  const next = normalizedClipCrop(crop);
  next[edge] = Math.min(clipCropEdgeMax(crop, edge), Math.max(0, value));
  return { crop: compactClipCrop(next) };
}

/** Apply one or more edge insets onto an existing crop (agent / multi-edge update). */
export function clipCropMergePatch(
  crop: ClipCrop | undefined,
  patch: ClipCrop,
): { crop: ClipCrop | undefined } {
  let next = crop;
  for (const edge of CLIP_CROP_EDGES) {
    const value = patch[edge];
    if (value === undefined) continue;
    next = clipCropInsetPatch(next, edge, value).crop;
  }
  return { crop: next };
}
