/**
 * Safe-zone placement for graphics: given the visual geometry of the video
 * underneath a graphic clip, pick the largest safe rect in the clip's time
 * window and map it to a timeline transform (x/y % of canvas, centered).
 *
 * Pure functions — the caller resolves the underlying video + geometry and
 * writes the transform through EditorCommands.
 */

import { flexCropRect } from '../editor/flexCrop';
import { resolveClipScaleAxes } from '../editor/clipTransformScale';
import { sampleKeyframes } from '../editor/keyframes';
import { sourceFramesToTimelineFrames } from '../editor/sourceLimit';
import type { KeyframeProp, TimelineItem, TimelineState } from '../editor/types';
import { renderedVisualFrameRect } from '../editor/visualFrameGeometry';
import { zoomAt } from '../editor/zoom';
import { intersects, type GeomRect, type SafeZone } from './geometry-math';
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

interface ProjectionPoint {
  x: number;
  y: number;
}

interface ProjectionTransform {
  x: number;
  y: number;
  scaleX: number;
  scaleY: number;
  rotation: number;
}

function intersectRects(left: GeomRect, right: GeomRect): GeomRect | null {
  const x = Math.max(left.x, right.x);
  const y = Math.max(left.y, right.y);
  const edgeX = Math.min(left.x + left.w, right.x + right.w);
  const edgeY = Math.min(left.y + left.h, right.y + right.h);
  return edgeX > x && edgeY > y ? { x, y, w: edgeX - x, h: edgeY - y } : null;
}

function boundsOf(points: readonly ProjectionPoint[]): GeomRect {
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

function itemTransformAt(item: TimelineItem, localFrame: number): ProjectionTransform {
  const value = (prop: KeyframeProp): number | undefined => {
    const keyframes = item.keyframes?.[prop];
    return keyframes?.length ? sampleKeyframes(keyframes, localFrame) : undefined;
  };
  const keyframed = {
    scale: value('scale'),
    scaleX: value('scaleX'),
    scaleY: value('scaleY'),
  };
  const { scaleX, scaleY } = resolveClipScaleAxes(item.transform, keyframed);
  return {
    x: value('x') ?? item.transform?.x ?? 0,
    y: value('y') ?? item.transform?.y ?? 0,
    scaleX,
    scaleY,
    rotation: value('rotation') ?? item.transform?.rotation ?? 0,
  };
}

function applyOuterTransform(
  point: ProjectionPoint,
  state: Pick<TimelineState, 'width' | 'height'>,
  transform: ProjectionTransform,
): ProjectionPoint {
  const centerX = state.width / 2;
  const centerY = state.height / 2;
  const scaledX = centerX + (point.x - centerX) * transform.scaleX;
  const scaledY = centerY + (point.y - centerY) * transform.scaleY;
  const radians = transform.rotation * Math.PI / 180;
  const dx = scaledX - centerX;
  const dy = scaledY - centerY;
  return {
    x: centerX + dx * Math.cos(radians) - dy * Math.sin(radians) + transform.x / 100 * state.width,
    y: centerY + dx * Math.sin(radians) + dy * Math.cos(radians) + transform.y / 100 * state.height,
  };
}

/** Project one source-normalized geometry rect through fit, crop, reframe and clip transforms. */
export function projectSourceRectThroughItem(
  rect: GeomRect,
  state: Pick<TimelineState, 'width' | 'height' | 'fit'>,
  item: TimelineItem,
  localFrame: number,
): GeomRect | null {
  if (!(state.width > 0) || !(state.height > 0)) return null;
  const rendered = renderedVisualFrameRect(
    { width: state.width, height: state.height },
    { width: item.width ?? state.width, height: item.height ?? state.height },
    state.fit ?? 'contain',
  );
  const corners = [
    { x: rendered.x + rect.x * rendered.width, y: rendered.y + rect.y * rendered.height },
    { x: rendered.x + (rect.x + rect.w) * rendered.width, y: rendered.y + rect.y * rendered.height },
    { x: rendered.x + (rect.x + rect.w) * rendered.width, y: rendered.y + (rect.y + rect.h) * rendered.height },
    { x: rendered.x + rect.x * rendered.width, y: rendered.y + (rect.y + rect.h) * rendered.height },
  ];
  const zoom = item.zoom ? zoomAt(item.zoom, localFrame, item.durationInFrames) : null;
  const zoomed = zoom ? corners.map((point) => ({
    x: zoom.focalX * state.width + (point.x - zoom.focalX * state.width) * zoom.magnification,
    y: zoom.focalY * state.height + (point.y - zoom.focalY * state.height) * zoom.magnification,
  })) : corners;
  const crop = item.transform?.crop;
  const snapped = flexCropRect(crop, state.width, state.height);
  const cropRect: GeomRect = {
    x: snapped.x,
    y: snapped.y,
    w: snapped.width,
    h: snapped.height,
  };
  const contentBounds = boundsOf(zoomed);
  const clipped = crop ? intersectRects(contentBounds, cropRect) : contentBounds;
  if (!clipped) return null;
  const clippedCorners = [
    { x: clipped.x, y: clipped.y },
    { x: clipped.x + clipped.w, y: clipped.y },
    { x: clipped.x + clipped.w, y: clipped.y + clipped.h },
    { x: clipped.x, y: clipped.y + clipped.h },
  ];
  const outerTransform = itemTransformAt(item, localFrame);
  if (!Number.isFinite(outerTransform.rotation) || !Number.isInteger(outerTransform.rotation / 90)) {
    return null;
  }
  const transformed = boundsOf(clippedCorners.map((point) => (
    applyOuterTransform(point, state, outerTransform)
  )));
  const visible = intersectRects(transformed, { x: 0, y: 0, w: state.width, h: state.height });
  return visible ? {
    x: visible.x / state.width,
    y: visible.y / state.height,
    w: visible.w / state.width,
    h: visible.h / state.height,
  } : null;
}

function projectSafeZone(
  zone: SafeZone,
  state: Pick<TimelineState, 'width' | 'height' | 'fit'>,
  item: TimelineItem,
  localFrame: number,
): SafeZone {
  const project = (rect: GeomRect | null): GeomRect | null => (
    rect ? projectSourceRectThroughItem(rect, state, item, localFrame) : null
  );
  return {
    rects: zone.rects
      .map((rect) => projectSourceRectThroughItem(rect, state, item, localFrame))
      .filter((rect): rect is GeomRect => rect !== null),
    face: project(zone.face),
    subject: project(zone.subject),
  };
}

/** Project every geometry segment at its source-time midpoint into composition coordinates. */
export function projectGeometryThroughItem(
  geometry: VisualGeometryAsset,
  state: Pick<TimelineState, 'width' | 'height' | 'fit' | 'fps'>,
  item: TimelineItem,
): VisualGeometryAsset {
  const fps = state.fps > 0 ? state.fps : 30;
  const srcInFrame = item.srcInFrame ?? 0;
  return {
    ...geometry,
    segments: geometry.segments.map((segment) => {
      const sourceMidFrame = (segment.startSec + segment.endSec) / 2 * fps;
      const localFrame = Math.max(0, Math.min(
        item.durationInFrames - 1,
        sourceFramesToTimelineFrames(item, sourceMidFrame - srcInFrame),
      ));
      return {
        ...segment,
        zone: projectSafeZone(segment.zone, state, item, localFrame),
      };
    }),
  };
}
