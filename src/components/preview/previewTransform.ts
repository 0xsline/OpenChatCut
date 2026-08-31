import { isBackgroundFillActive } from '../../editor/backgroundFill';
import {
  flexCropVisibleRect,
  compactFlexCrop,
  normalizedFlexCrop,
  PREVIEW_CROP_MIN_SPAN,
} from '../../editor/flexCrop';
import { resolveClipScaleAxes } from '../../editor/clipTransformScale';
import { coerceKeyframeValue } from '../../editor/keyframeRegistry';
import { sampleKeyframes } from '../../editor/keyframes';
import {
  clampVisualBorderRadius,
  objectFitInsideVisualFrame,
  visibleVisualFrameRect,
} from '../../editor/visualFrameGeometry';
import {
  isVisualItemKind,
  timelineTrackIds,
  trackKind,
  type FlexCrop,
  type ClipTransform,
  type KeyframeProp,
  type TimelineItem,
  type TimelineState,
} from '../../editor/types';

export {
  flexCropEdgeMax,
  flexCropInsetPatch,
  compactFlexCrop,
  hasFlexCrop,
  normalizedFlexCrop,
  PREVIEW_CROP_MIN_SPAN,
  type FlexCropEdge,
} from '../../editor/flexCrop';

export interface PreviewPoint { x: number; y: number }
export interface PreviewSize { width: number; height: number }
export interface PreviewRect extends PreviewPoint, PreviewSize {}

/** Edge of the selection box (local axes after rotation). */
export type PreviewScaleEdge = 'n' | 's' | 'e' | 'w';

export interface EffectivePreviewTransform {
  x: number;
  y: number;
  /** Uniform fallback (legacy / linked axes). */
  scale: number;
  scaleX: number;
  scaleY: number;
  rotation: number;
}

export interface PreviewCandidate {
  item: TimelineItem;
  transform: EffectivePreviewTransform;
  localFrame: number;
}

export interface ClickCycleState {
  point: PreviewPoint;
  candidateIds: string[];
  index: number;
}

export interface PreviewCandidateGeometry {
  baseRect: PreviewRect;
  center: PreviewPoint;
  corners: readonly [PreviewPoint, PreviewPoint, PreviewPoint, PreviewPoint];
}

export { clampVisualBorderRadius, objectFitInsideVisualFrame, visibleVisualFrameRect };

export type PreviewNudgeDirection = 'left' | 'right' | 'up' | 'down';

export type KeyboardPreviewNudgePlan =
  | { itemId: string; transform: Pick<ClipTransform, 'x' | 'y'> }
  | { itemId: string; keyframe: { prop: 'x' | 'y'; localFrame: number; value: number } };

const valueAtFrame = (item: TimelineItem, prop: KeyframeProp, localFrame: number): number | undefined => {
  const keyframes = item.keyframes?.[prop];
  return keyframes?.length ? sampleKeyframes(keyframes, localFrame) : undefined;
};

export function effectivePreviewTransform(item: TimelineItem, absoluteFrame: number): EffectivePreviewTransform {
  const localFrame = Math.max(0, Math.round(absoluteFrame) - item.startFrame);
  const keyframed = {
    scale: valueAtFrame(item, 'scale', localFrame),
    scaleX: valueAtFrame(item, 'scaleX', localFrame),
    scaleY: valueAtFrame(item, 'scaleY', localFrame),
  };
  const { scaleX, scaleY } = resolveClipScaleAxes(item.transform, keyframed);
  const uniform = Math.abs(scaleX - scaleY) < 1e-6
    ? scaleX
    : (keyframed.scale ?? item.transform?.scale ?? scaleX);
  return {
    x: valueAtFrame(item, 'x', localFrame) ?? item.transform?.x ?? 0,
    y: valueAtFrame(item, 'y', localFrame) ?? item.transform?.y ?? 0,
    scale: uniform,
    scaleX,
    scaleY,
    rotation: valueAtFrame(item, 'rotation', localFrame) ?? item.transform?.rotation ?? 0,
  };
}

export function visiblePreviewCandidates(state: TimelineState, absoluteFrame: number): PreviewCandidate[] {
  const visualTracks = timelineTrackIds(state).filter((id) => trackKind(state, id) === 'video');
  const paintOrder = state.items
    .filter((item) => (
      isVisualItemKind(item.kind)
      && visualTracks.includes(item.track)
      && !state.tracks?.[item.track]?.hidden
      && !state.tracks?.[item.track]?.locked
      && absoluteFrame >= item.startFrame
      && absoluteFrame < item.startFrame + item.durationInFrames
    ))
    .sort((a, b) => (
      a.track === b.track
        ? a.startFrame - b.startFrame
        : visualTracks.indexOf(b.track) - visualTracks.indexOf(a.track)
    ));

  return paintOrder.reverse().map((item) => ({
    item,
    localFrame: Math.max(0, Math.round(absoluteFrame) - item.startFrame),
    transform: effectivePreviewTransform(item, absoluteFrame),
  }));
}

function previewBaseRect(state: TimelineState, item: TimelineItem): PreviewRect {
  if (state.width <= 0 || state.height <= 0) return { x: 0, y: 0, width: 0, height: 0 };
  const canvas = { x: 0, y: 0, width: state.width, height: state.height };
  let content = canvas;
  if (item.kind !== 'solid') {
    const sourceWidth = item.width && item.width > 0 ? item.width : state.width;
    const sourceHeight = item.height && item.height > 0 ? item.height : state.height;
    content = visibleVisualFrameRect(
      { width: state.width, height: state.height },
      { width: sourceWidth, height: sourceHeight },
      isBackgroundFillActive(state, item) ? 'contain' : (state.fit ?? 'contain'),
    );
  }

  const crop = item.transform?.crop;
  if (!crop) return content;
  return flexCropVisibleRect(crop, state.width, state.height, content);
}

const rotatePoint = (point: PreviewPoint, center: PreviewPoint, degrees: number): PreviewPoint => {
  const radians = degrees * Math.PI / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const x = point.x - center.x;
  const y = point.y - center.y;
  return { x: center.x + x * cos - y * sin, y: center.y + x * sin + y * cos };
};

const applyTransform = (
  state: Pick<TimelineState, 'width' | 'height'>,
  point: PreviewPoint,
  transform: EffectivePreviewTransform,
): PreviewPoint => {
  // Same origin as CSS `transform-origin: 50% 50%` on the full-canvas layer.
  const center = { x: state.width / 2, y: state.height / 2 };
  const scaled = {
    x: center.x + (point.x - center.x) * transform.scaleX,
    y: center.y + (point.y - center.y) * transform.scaleY,
  };
  const rotated = rotatePoint(scaled, center, transform.rotation);
  return {
    x: rotated.x + transform.x / 100 * state.width,
    y: rotated.y + transform.y / 100 * state.height,
  };
};

export function previewCandidateGeometry(state: TimelineState, candidate: PreviewCandidate): PreviewCandidateGeometry {
  const baseRect = previewBaseRect(state, candidate.item);
  const rawCorners = [
    { x: baseRect.x, y: baseRect.y },
    { x: baseRect.x + baseRect.width, y: baseRect.y },
    { x: baseRect.x + baseRect.width, y: baseRect.y + baseRect.height },
    { x: baseRect.x, y: baseRect.y + baseRect.height },
  ] as const;
  const corners = rawCorners.map((point) => applyTransform(state, point, candidate.transform)) as unknown as PreviewCandidateGeometry['corners'];
  const rawCenter = { x: baseRect.x + baseRect.width / 2, y: baseRect.y + baseRect.height / 2 };
  return { baseRect, center: applyTransform(state, rawCenter, candidate.transform), corners };
}

const inverseTransform = (
  state: Pick<TimelineState, 'width' | 'height'>,
  point: PreviewPoint,
  transform: EffectivePreviewTransform,
): PreviewPoint => {
  const center = { x: state.width / 2, y: state.height / 2 };
  const translated = {
    x: point.x - transform.x / 100 * state.width,
    y: point.y - transform.y / 100 * state.height,
  };
  const rotated = rotatePoint(translated, center, -transform.rotation);
  const safeX = Math.abs(transform.scaleX) < 1e-6 ? 1e-6 : transform.scaleX;
  const safeY = Math.abs(transform.scaleY) < 1e-6 ? 1e-6 : transform.scaleY;
  return {
    x: center.x + (rotated.x - center.x) / safeX,
    y: center.y + (rotated.y - center.y) / safeY,
  };
};

export function hitPreviewCandidates(state: TimelineState, absoluteFrame: number, point: PreviewPoint): PreviewCandidate[] {
  return visiblePreviewCandidates(state, absoluteFrame).filter((candidate) => {
    const rect = previewBaseRect(state, candidate.item);
    if (!rect.width || !rect.height) return false;
    const local = inverseTransform(state, point, candidate.transform);
    return local.x >= rect.x && local.x <= rect.x + rect.width
      && local.y >= rect.y && local.y <= rect.y + rect.height;
  });
}

const sameIds = (a: readonly string[], b: readonly string[]): boolean => (
  a.length === b.length && a.every((id, index) => id === b[index])
);

export function cyclePreviewCandidate(
  previous: ClickCycleState | null,
  point: PreviewPoint,
  candidates: readonly PreviewCandidate[],
  tolerance: number,
): { id: string; next: ClickCycleState } | null {
  if (!candidates.length) return null;
  const candidateIds = candidates.map(({ item }) => item.id);
  const repeated = !!previous
    && Math.hypot(point.x - previous.point.x, point.y - previous.point.y) <= tolerance
    && sameIds(previous.candidateIds, candidateIds);
  const index = repeated ? (previous.index + 1) % candidateIds.length : 0;
  return {
    id: candidateIds[index]!,
    next: { point, candidateIds, index },
  };
}

export function movePreviewTransform(
  start: EffectivePreviewTransform,
  deltaPreview: PreviewPoint,
  previewSize: PreviewSize,
): Pick<ClipTransform, 'x' | 'y'> {
  const dx = previewSize.width > 0 ? deltaPreview.x / previewSize.width * 100 : 0;
  const dy = previewSize.height > 0 ? deltaPreview.y / previewSize.height * 100 : 0;
  return {
    x: coerceKeyframeValue('x', start.x + dx),
    y: coerceKeyframeValue('y', start.y + dy),
  };
}

/**
 * Map a viewport client point onto the current preview canvas.
 * Always pass the live getBoundingClientRect() — a cached overlay origin
 * treats inspector open/close (canvas recenter) as a drag.
 */
export function previewPointerFromClient(
  client: PreviewPoint,
  canvas: Pick<DOMRect, 'left' | 'top' | 'width' | 'height'>,
  composition: Pick<TimelineState, 'width' | 'height'>,
): { ui: PreviewPoint; composition: PreviewPoint } {
  const ui = { x: client.x - canvas.left, y: client.y - canvas.top };
  return {
    ui,
    composition: {
      x: canvas.width > 0 ? ui.x / canvas.width * composition.width : 0,
      y: canvas.height > 0 ? ui.y / canvas.height * composition.height : 0,
    },
  };
}

/** Screen-space pointer delta. Overlay translation/resize must not count. */
export function previewClientDelta(startClient: PreviewPoint, currentClient: PreviewPoint): PreviewPoint {
  return { x: currentClient.x - startClient.x, y: currentClient.y - startClient.y };
}

/**
 * Build one keyboard nudge against the exact transform value currently shown by
 * the preview and Inspector. Existing x/y curves receive a keyframe at the
 * playhead; un-keyframed clips update their static transform instead.
 */
export function keyboardPreviewNudgePlan(
  item: TimelineItem,
  absoluteFrame: number,
  direction: PreviewNudgeDirection,
  step = 1,
): KeyboardPreviewNudgePlan | null {
  if (!isVisualItemKind(item.kind)) return null;
  const prop: 'x' | 'y' = direction === 'left' || direction === 'right' ? 'x' : 'y';
  const delta = direction === 'left' || direction === 'up' ? -step : step;
  const localFrame = Math.round(absoluteFrame) - item.startFrame;
  if (localFrame < 0 || localFrame >= item.durationInFrames) return null;
  const keyframes = item.keyframes?.[prop];
  const current = effectivePreviewTransform(item, absoluteFrame)[prop];
  const value = coerceKeyframeValue(prop, current + delta);
  if (keyframes?.length) return { itemId: item.id, keyframe: { prop, localFrame, value } };
  return { itemId: item.id, transform: { [prop]: value } };
}

export function scalePreviewTransform(
  startScale: number,
  center: PreviewPoint,
  startPoint: PreviewPoint,
  currentPoint: PreviewPoint,
): number {
  const startDistance = Math.hypot(startPoint.x - center.x, startPoint.y - center.y);
  if (startDistance < 1e-6) return Math.max(0.05, coerceKeyframeValue('scale', startScale));
  const distance = Math.hypot(currentPoint.x - center.x, currentPoint.y - center.y);
  return Math.max(0.05, coerceKeyframeValue('scale', startScale * distance / startDistance));
}

/** Corner drag: both axes grow by the same distance factor (keeps aspect). */
export function uniformScaleAxesPreviewTransform(
  start: Pick<EffectivePreviewTransform, 'scaleX' | 'scaleY'>,
  center: PreviewPoint,
  startPoint: PreviewPoint,
  currentPoint: PreviewPoint,
): Pick<ClipTransform, 'scale' | 'scaleX' | 'scaleY'> {
  const startDistance = Math.hypot(startPoint.x - center.x, startPoint.y - center.y);
  const factor = startDistance < 1e-6
    ? 1
    : Math.hypot(currentPoint.x - center.x, currentPoint.y - center.y) / startDistance;
  const scaleX = Math.max(0.05, coerceKeyframeValue('scaleX', start.scaleX * factor));
  const scaleY = Math.max(0.05, coerceKeyframeValue('scaleY', start.scaleY * factor));
  const linked = Math.abs(scaleX - scaleY) < 1e-6;
  return linked
    ? { scale: scaleX, scaleX, scaleY }
    : { scaleX, scaleY };
}

const projectOnAxis = (
  center: PreviewPoint,
  point: PreviewPoint,
  axis: PreviewPoint,
): number => {
  const dx = point.x - center.x;
  const dy = point.y - center.y;
  return dx * axis.x + dy * axis.y;
};

/**
 * Edge drag: crop (cover/hide) the dragged-over region — not stretch.
 * Pointer is inverse-transformed into layer space; that edge of the crop window
 * snaps to the pointer while the opposite inset stays fixed.
 * Example: drag right edge left → increase crop.right, right side is masked out.
 */
export function edgeCropPreviewTransform(
  state: Pick<TimelineState, 'width' | 'height'>,
  transform: EffectivePreviewTransform,
  startCrop: FlexCrop | undefined,
  currentPoint: PreviewPoint,
  edge: PreviewScaleEdge,
): { crop: FlexCrop | undefined } {
  if (state.width <= 0 || state.height <= 0) {
    return { crop: compactFlexCrop(normalizedFlexCrop(startCrop)) };
  }
  const start = normalizedFlexCrop(startCrop);
  const local = inverseTransform(state, currentPoint, transform);
  const min = PREVIEW_CROP_MIN_SPAN;
  let { left, top, right, bottom } = start;
  if (edge === 'e') {
    const xPx = Math.round(local.x);
    const minX = Math.round((left + min) * state.width);
    const fx = Math.min(state.width, Math.max(minX, xPx));
    right = (state.width - fx) / state.width;
  } else if (edge === 'w') {
    const xPx = Math.round(local.x);
    const maxX = Math.round((1 - right - min) * state.width);
    const fx = Math.min(maxX, Math.max(0, xPx));
    left = fx / state.width;
  } else if (edge === 's') {
    const yPx = Math.round(local.y);
    const minY = Math.round((top + min) * state.height);
    const fy = Math.min(state.height, Math.max(minY, yPx));
    bottom = (state.height - fy) / state.height;
  } else {
    const yPx = Math.round(local.y);
    const maxY = Math.round((1 - bottom - min) * state.height);
    const fy = Math.min(maxY, Math.max(0, yPx));
    top = fy / state.height;
  }
  return { crop: compactFlexCrop({ left, top, right, bottom }) };
}

/** @deprecated Prefer edgeCropPreviewTransform — edge handles crop, they do not stretch. */
export function edgeScalePreviewTransform(
  start: Pick<EffectivePreviewTransform, 'scaleX' | 'scaleY' | 'rotation'>,
  center: PreviewPoint,
  startPoint: PreviewPoint,
  currentPoint: PreviewPoint,
  edge: PreviewScaleEdge,
): Pick<ClipTransform, 'scaleX' | 'scaleY'> {
  const rad = start.rotation * Math.PI / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const axisX = { x: cos, y: sin };
  const axisY = { x: -sin, y: cos };
  const horizontal = edge === 'e' || edge === 'w';
  const axis = horizontal ? axisX : axisY;
  const startProj = Math.abs(projectOnAxis(center, startPoint, axis));
  if (startProj < 1e-6) {
    return horizontal
      ? { scaleX: Math.max(0.05, start.scaleX) }
      : { scaleY: Math.max(0.05, start.scaleY) };
  }
  const factor = Math.abs(projectOnAxis(center, currentPoint, axis)) / startProj;
  if (horizontal) {
    return { scaleX: Math.max(0.05, coerceKeyframeValue('scaleX', start.scaleX * factor)) };
  }
  return { scaleY: Math.max(0.05, coerceKeyframeValue('scaleY', start.scaleY * factor)) };
}

const angle = (center: PreviewPoint, point: PreviewPoint): number => (
  Math.atan2(point.y - center.y, point.x - center.x) * 180 / Math.PI
);

export function rotatePreviewTransform(
  startRotation: number,
  center: PreviewPoint,
  startPoint: PreviewPoint,
  currentPoint: PreviewPoint,
): number {
  const delta = ((angle(center, currentPoint) - angle(center, startPoint) + 540) % 360) - 180;
  return coerceKeyframeValue('rotation', startRotation + delta);
}

/** Midpoints of the four edges in composition space (after transform). */
export function previewEdgeMidpoints(
  corners: readonly [PreviewPoint, PreviewPoint, PreviewPoint, PreviewPoint],
): Record<PreviewScaleEdge, PreviewPoint> {
  const mid = (a: PreviewPoint, b: PreviewPoint): PreviewPoint => ({
    x: (a.x + b.x) / 2,
    y: (a.y + b.y) / 2,
  });
  return {
    n: mid(corners[0], corners[1]),
    e: mid(corners[1], corners[2]),
    s: mid(corners[2], corners[3]),
    w: mid(corners[3], corners[0]),
  };
}
