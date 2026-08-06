/**
 * Safe-zone placement for graphics: given the visual geometry of the video
 * underneath a graphic clip, pick the largest safe rect in the clip's time
 * window and map it to a timeline transform (x/y % of canvas, centered).
 *
 * Pure functions — the caller resolves the underlying video + geometry and
 * writes the transform through EditorCommands.
 */

import { intersects, type GeomRect } from './geometry-math';
import type { VisualGeometryAsset } from './visual-geometry';

export interface PlacementTransform {
  /** Canvas-percent offset of the graphic center (0 = canvas center). */
  x: number;
  y: number;
  /** Conservative fit scale so the graphic stays inside the safe rect. */
  scale: number;
}

const SAFE_MIN_W = 0.34;
const SAFE_MIN_H = 0.2;
const FIT_MARGIN = 0.02;

/** Largest safe rect overlapping [startSec, endSec]; dominant segment wins. */
export function safeBoxForRange(
  geometry: VisualGeometryAsset,
  startSec: number,
  endSec: number,
): GeomRect | null {
  let best: GeomRect | null = null;
  let bestOverlap = 0;
  for (const segment of geometry.segments) {
    if (segment.endSec < startSec || segment.startSec > endSec) continue;
    const overlap = Math.min(segment.endSec, endSec) - Math.max(segment.startSec, startSec);
    for (const rect of segment.zone.rects) {
      if (rect.w < SAFE_MIN_W || rect.h < SAFE_MIN_H) continue;
      if (overlap > bestOverlap) {
        bestOverlap = overlap;
        best = rect;
      }
    }
  }
  return best;
}

/**
 * Transform for a graphic whose natural aspect is `graphicAspect` (w/h, e.g.
 * 16:9 → 1.78) so it sits centered in `box` without leaving it. Rendered
 * width = scale × canvas width, height = scale / graphicAspect.
 */
export function transformFromSafeBox(
  box: GeomRect,
  graphicAspect: number,
): PlacementTransform | null {
  if (!(graphicAspect > 0) || box.w <= 0 || box.h <= 0) return null;
  const scale = Math.max(0.05, Math.min(box.w, box.h * graphicAspect) - FIT_MARGIN);
  return {
    x: Math.round((box.x + box.w / 2 - 0.5) * 1000) / 10,
    y: Math.round((box.y + box.h / 2 - 0.5) * 1000) / 10,
    scale: Math.round(scale * 100) / 100,
  };
}

/** True when a graphic box (centered at transform, scaled) overlaps a face. */
export function graphicOverlapsFace(
  transform: PlacementTransform,
  graphicAspect: number,
  face: GeomRect,
): boolean {
  const w = Math.max(0.05, Math.min(1, transform.scale * graphicAspect));
  const h = Math.max(0.05, Math.min(1, transform.scale));
  const box: GeomRect = {
    x: 0.5 + transform.x / 100 - w / 2,
    y: 0.5 + transform.y / 100 - h / 2,
    w,
    h,
  };
  return intersects(box, face);
}
