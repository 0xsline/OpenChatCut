/**
 * Caption-layout vs visual-geometry collision checks (pure functions).
 *
 * A caption layout (anchor + offsets) maps to a normalized band on the canvas;
 * if that band intersects the face union of the source material, the caption
 * likely covers the speaker. QA surfaces this as a warning before export —
 * the geometry cache is read asynchronously by the caller.
 */

import { headZoneOf, intersects, unionRect, type GeomRect } from './geometry-math';
import type { VisualGeometryAsset } from './visual-geometry';

export interface CaptionLayoutLike {
  anchor?: string;
  offsetXRatio?: number;
  offsetYRatio?: number;
}

/** Assumed caption footprint: 60% width centered horizontally, 14% height. */
export const CAPTION_BAND_W = 0.6;
export const CAPTION_BAND_H = 0.14;

/**
 * Normalized band covered by a caption layout. Vertical position derives from
 * the anchor (bottom ≈ 0.92 / middle ≈ 0.5 / top ≈ 0.08) plus offsetYRatio;
 * horizontal from left/center/right plus offsetXRatio. Null when the layout is
 * too far off-canvas to matter.
 */
export function captionBandFromLayout(layout: CaptionLayoutLike): GeomRect | null {
  const x = Number(layout.offsetXRatio ?? 0);
  const y = Number(layout.offsetYRatio ?? 0);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  const anchor = layout.anchor ?? 'bottom-center';
  const vertical = anchor.startsWith('top') ? 'top' : (anchor.startsWith('middle') || anchor === 'center') ? 'middle' : 'bottom';
  const horizontal = anchor.endsWith('left') ? 'left' : anchor.endsWith('right') ? 'right' : 'center';
  const cx = horizontal === 'left' ? 0.25 + x : horizontal === 'right' ? 0.75 - x : 0.5 + x;
  const cy = vertical === 'top' ? 0.08 + y : vertical === 'middle' ? 0.5 + y : 0.92 + y;
  return {
    x: cx - CAPTION_BAND_W / 2,
    y: cy - CAPTION_BAND_H / 2,
    w: CAPTION_BAND_W,
    h: CAPTION_BAND_H,
  };
}

/** Union of every effective head zone across all geometry segments. Falls
 * back to the subject's top band when a face is too small to detect. */
export function faceUnionOf(geometry: VisualGeometryAsset): GeomRect | null {
  let union: GeomRect | null = null;
  for (const segment of geometry.segments) {
    const head = headZoneOf(segment.zone);
    if (!head) continue;
    union = union ? unionRect(union, head) : { ...head };
  }
  return union;
}

export interface CaptionFaceConflict {
  layout: CaptionLayoutLike;
  band: GeomRect;
  faceUnion: GeomRect;
  /** Fraction of the caption band covered by the face union (0..1). */
  coverage: number;
}

/** Largest vertical overlap of two rects as a fraction of the caption band height. */
function verticalCoverage(band: GeomRect, face: GeomRect): number {
  const overlap = Math.max(0, Math.min(band.y + band.h, face.y + face.h) - Math.max(band.y, face.y));
  return band.h > 0 ? Math.min(1, overlap / band.h) : 0;
}

/**
 * Which caption layouts collide with the speaker's face. A layout is flagged
 * when its band intersects the face union with at least 20% vertical overlap —
 * enough to visually cover the face.
 */
export function captionFaceConflicts(
  geometry: VisualGeometryAsset,
  layouts: readonly CaptionLayoutLike[],
  threshold = 0.2,
): CaptionFaceConflict[] {
  const faceUnion = faceUnionOf(geometry);
  if (!faceUnion) return [];
  const conflicts: CaptionFaceConflict[] = [];
  for (const layout of layouts) {
    const band = captionBandFromLayout(layout);
    if (!band || !intersects(band, faceUnion)) continue;
    const coverage = verticalCoverage(band, faceUnion);
    if (coverage < threshold) continue;
    conflicts.push({ layout, band, faceUnion, coverage });
  }
  return conflicts;
}

export interface CaptionAvoidanceSuggestion {
  /** Original layout key (anchor|offsetX|offsetY). */
  layout: CaptionLayoutLike;
  /** New offsetYRatio that clears the face (same anchor/horizontal). */
  offsetYRatio: number;
  /** Placement choice: above or below the face union. */
  side: 'above' | 'below';
}

const ANCHOR_BASE_Y: Record<string, number> = {
  'top': 0.08,
  'middle': 0.5,
  'bottom': 0.92,
};

/**
 * Suggest an offsetYRatio that moves a conflicting caption band clear of the
 * face union. Tries above first, falls back to below; returns null when the
 * face spans the whole canvas (no room either side).
 */
export function suggestCaptionAvoidance(
  conflict: CaptionFaceConflict,
  margin = 0.03,
): CaptionAvoidanceSuggestion | null {
  const { faceUnion, layout } = conflict;
  const vertical = (layout.anchor ?? 'bottom-center').startsWith('top')
    ? 'top'
    : (layout.anchor ?? 'bottom-center').startsWith('middle')
      ? 'middle'
      : 'bottom';
  const baseY = ANCHOR_BASE_Y[vertical] ?? 0.92;
  const above = faceUnion.y - CAPTION_BAND_H / 2 - margin;
  const below = faceUnion.y + faceUnion.h + CAPTION_BAND_H / 2 + margin;
  const pick = (cy: number): number => Math.round((cy - baseY) * 100) / 100;
  if (above - CAPTION_BAND_H / 2 >= 0) {
    return { layout, offsetYRatio: pick(above), side: 'above' };
  }
  if (below + CAPTION_BAND_H / 2 <= 1) {
    return { layout, offsetYRatio: pick(below), side: 'below' };
  }
  return null;
}
