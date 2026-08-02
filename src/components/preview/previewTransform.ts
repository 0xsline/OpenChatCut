import { coerceKeyframeValue } from '../../editor/keyframeRegistry';
import { sampleKeyframes } from '../../editor/keyframes';
import {
  clampVisualBorderRadius,
  visibleVisualFrameRect,
} from '../../editor/visualFrameGeometry';
import {
  isVisualItemKind,
  timelineTrackIds,
  trackKind,
  type ClipTransform,
  type KeyframeProp,
  type TimelineItem,
  type TimelineState,
} from '../../editor/types';

export interface PreviewPoint { x: number; y: number }
export interface PreviewSize { width: number; height: number }
export interface PreviewRect extends PreviewPoint, PreviewSize {}

export interface EffectivePreviewTransform {
  x: number;
  y: number;
  scale: number;
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

export { clampVisualBorderRadius, visibleVisualFrameRect };

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
  return {
    x: valueAtFrame(item, 'x', localFrame) ?? item.transform?.x ?? 0,
    y: valueAtFrame(item, 'y', localFrame) ?? item.transform?.y ?? 0,
    scale: valueAtFrame(item, 'scale', localFrame) ?? item.transform?.scale ?? 1,
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

const intersection = (a: PreviewRect, b: PreviewRect): PreviewRect => {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  return { x, y, width: Math.max(0, right - x), height: Math.max(0, bottom - y) };
};

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
      state.fit ?? 'contain',
    );
  }

  const crop = item.transform?.crop;
  if (!crop) return content;
  const cropRect = {
    x: (crop.left ?? 0) * state.width,
    y: (crop.top ?? 0) * state.height,
    width: Math.max(0, (1 - (crop.left ?? 0) - (crop.right ?? 0)) * state.width),
    height: Math.max(0, (1 - (crop.top ?? 0) - (crop.bottom ?? 0)) * state.height),
  };
  return intersection(content, cropRect);
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
  const center = { x: state.width / 2, y: state.height / 2 };
  const scaled = {
    x: center.x + (point.x - center.x) * transform.scale,
    y: center.y + (point.y - center.y) * transform.scale,
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
  const safeScale = Math.abs(transform.scale) < 1e-6 ? 1e-6 : transform.scale;
  return {
    x: center.x + (rotated.x - center.x) / safeScale,
    y: center.y + (rotated.y - center.y) / safeScale,
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
