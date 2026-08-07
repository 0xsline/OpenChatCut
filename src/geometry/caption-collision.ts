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
  scale?: number;
  rotation?: number;
  opacity?: number;
  /** Number of vertically stacked rendered lanes sharing this placement. */
  stackCount?: number;
}

export interface SourceTimeRange {
  startSec: number;
  endSec: number;
}

export function captionLayoutKey(layout: CaptionLayoutLike): string {
  return [
    layout.anchor ?? 'bottom-center',
    layout.offsetXRatio ?? 0,
    layout.offsetYRatio ?? 0,
    layout.scale ?? 1,
    layout.rotation ?? 0,
    layout.opacity ?? 1,
    layout.stackCount ?? 1,
  ].join('|');
}

/** Assumed caption footprint: 60% width centered horizontally, 14% height. */
export const CAPTION_BAND_W = 0.6;
export const CAPTION_BAND_H = 0.14;

/**
 * Normalized axis-aligned band covered by the rendered caption group. Offsets
 * follow containerStyle exactly: bottom anchors invert Y, while X never does.
 * Scale and rotation use a conservative transformed AABB.
 */
export function captionBandFromLayout(layout: CaptionLayoutLike): GeomRect | null {
  const x = Number(layout.offsetXRatio ?? 0);
  const y = Number(layout.offsetYRatio ?? 0);
  const scale = Number(layout.scale ?? 1);
  const rotation = Number(layout.rotation ?? 0);
  const opacity = Number(layout.opacity ?? 1);
  const stackCount = Math.max(1, Math.floor(Number(layout.stackCount ?? 1)));
  if (![x, y, scale, rotation, opacity, stackCount].every(Number.isFinite) || scale <= 0 || opacity <= 0) return null;
  const anchor = layout.anchor ?? 'bottom-center';
  const vertical = anchor.startsWith('top') ? 'top' : (anchor.startsWith('middle') || anchor === 'center') ? 'middle' : 'bottom';
  const horizontal = anchor.endsWith('left') ? 'left' : anchor.endsWith('right') ? 'right' : 'center';
  const baseX = horizontal === 'left' ? 0.25 : horizontal === 'right' ? 0.75 : 0.5;
  const height = CAPTION_BAND_H * stackCount;
  const stackShift = (height - CAPTION_BAND_H) / 2;
  const baseY = vertical === 'top'
    ? 0.08 + stackShift
    : vertical === 'middle'
      ? 0.5
      : 0.92 - stackShift;
  const translateY = vertical === 'bottom' ? -y : y;
  const cx = baseX + x;
  const cy = baseY + translateY;
  const originX = 0.5 + x;
  const originY = 0.5 + translateY;
  const radians = rotation * Math.PI / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const corners = [
    [cx - CAPTION_BAND_W / 2, cy - height / 2],
    [cx + CAPTION_BAND_W / 2, cy - height / 2],
    [cx + CAPTION_BAND_W / 2, cy + height / 2],
    [cx - CAPTION_BAND_W / 2, cy + height / 2],
  ].map(([px, py]) => {
    const dx = (px - originX) * scale;
    const dy = (py - originY) * scale;
    return {
      x: originX + dx * cos - dy * sin,
      y: originY + dx * sin + dy * cos,
    };
  });
  const xs = corners.map((point) => point.x);
  const ys = corners.map((point) => point.y);
  const left = Math.min(...xs);
  const top = Math.min(...ys);
  return { x: left, y: top, w: Math.max(...xs) - left, h: Math.max(...ys) - top };
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

/** Keep only geometry that is actually displayed through the clip source windows. */
export function geometryWithinSourceRanges(
  geometry: VisualGeometryAsset,
  ranges: readonly SourceTimeRange[],
): VisualGeometryAsset {
  const ordered = ranges
    .filter((range) => Number.isFinite(range.startSec) && Number.isFinite(range.endSec) && range.endSec > range.startSec)
    .map((range) => ({ startSec: Math.max(0, range.startSec), endSec: Math.min(geometry.durationSec, range.endSec) }))
    .filter((range) => range.endSec > range.startSec)
    .sort((a, b) => a.startSec - b.startSec);
  const merged: SourceTimeRange[] = [];
  for (const range of ordered) {
    const previous = merged.at(-1);
    if (previous && range.startSec <= previous.endSec) previous.endSec = Math.max(previous.endSec, range.endSec);
    else merged.push({ ...range });
  }
  return {
    ...geometry,
    segments: geometry.segments.flatMap((segment) => merged.flatMap((range) => {
      const startSec = Math.max(segment.startSec, range.startSec);
      const endSec = Math.min(segment.endSec, range.endSec);
      return endSec > startSec ? [{ ...segment, startSec, endSec }] : [];
    })),
  };
}

const SAFE_LAYOUT_CANDIDATES: readonly CaptionLayoutLike[] = [
  { anchor: 'bottom-center' },
  { anchor: 'top-center' },
  { anchor: 'bottom-left' },
  { anchor: 'bottom-right' },
  { anchor: 'top-left' },
  { anchor: 'top-right' },
  { anchor: 'middle-left' },
  { anchor: 'middle-right' },
];

function layoutCollisionScore(
  geometries: readonly VisualGeometryAsset[],
  layout: CaptionLayoutLike,
): number {
  const band = captionBandFromLayout(layout);
  if (!band) return Number.POSITIVE_INFINITY;
  let score = 0;
  for (const geometry of geometries) {
    for (const segment of geometry.segments) {
      const head = headZoneOf(segment.zone);
      if (!head || !intersects(band, head)) continue;
      const overlapWidth = Math.max(0, Math.min(band.x + band.w, head.x + head.w) - Math.max(band.x, head.x));
      const overlapHeight = Math.max(0, Math.min(band.y + band.h, head.y + head.h) - Math.max(band.y, head.y));
      const duration = Math.max(0.001, segment.endSec - segment.startSec);
      score += overlapWidth * overlapHeight * duration / (band.w * band.h);
    }
  }
  return score;
}

/** Pick the least-obstructive stable layout across every source scene. */
export function bestCaptionLayoutForGeometries(
  geometries: readonly VisualGeometryAsset[],
  current?: CaptionLayoutLike,
): CaptionLayoutLike {
  const inherited = current
    ? SAFE_LAYOUT_CANDIDATES.map((candidate) => ({
        ...current,
        anchor: candidate.anchor,
        offsetXRatio: 0,
        offsetYRatio: 0,
      }))
    : SAFE_LAYOUT_CANDIDATES;
  const seen = new Set<string>();
  const candidates = [...(current ? [current] : []), ...inherited].filter((candidate) => {
    const key = captionLayoutKey(candidate);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  let best = candidates[0] ?? { anchor: 'bottom-center' };
  let bestScore = layoutCollisionScore(geometries, best);
  for (const candidate of candidates.slice(1)) {
    const score = layoutCollisionScore(geometries, candidate);
    if (score < bestScore) {
      best = candidate;
      bestScore = score;
    }
  }
  return { ...best };
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



/**
 * Suggest an offsetYRatio that moves a conflicting caption band clear of the
 * face union. Tries above first, falls back to below; returns null when the
 * face spans the whole canvas (no room either side).
 */
export function suggestCaptionAvoidance(
  conflict: CaptionFaceConflict,
  margin = 0.03,
): CaptionAvoidanceSuggestion | null {
  const { band, faceUnion, layout } = conflict;
  const vertical = (layout.anchor ?? 'bottom-center').startsWith('top')
    ? 'top'
    : (layout.anchor ?? 'bottom-center').startsWith('middle')
      ? 'middle'
      : 'bottom';
  const currentCenter = band.y + band.h / 2;
  const aboveCenter = faceUnion.y - band.h / 2 - margin;
  const belowCenter = faceUnion.y + faceUnion.h + band.h / 2 + margin;
  const currentOffset = Number(layout.offsetYRatio ?? 0);
  const direction = vertical === 'bottom' ? -1 : 1;
  const pick = (center: number): number =>
    Math.round((currentOffset + (center - currentCenter) / direction) * 100) / 100;
  if (aboveCenter - band.h / 2 >= 0) {
    return { layout, offsetYRatio: pick(aboveCenter), side: 'above' };
  }
  if (belowCenter + band.h / 2 <= 1) {
    return { layout, offsetYRatio: pick(belowCenter), side: 'below' };
  }
  return null;
}
