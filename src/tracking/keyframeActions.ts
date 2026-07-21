import type { AtomicAction } from '../editor/reduce';
import type { TimelineItem, TimelineState } from '../editor/types';
import type { TrackingPoint, TrackingResult } from './types';

export type TrackingApplyMode = 'follow' | 'stabilize';

interface BuildTrackingActionsOptions {
  state: TimelineState;
  source: TimelineItem;
  target: TimelineItem;
  result: TrackingResult;
  mode: TrackingApplyMode;
}

function visibleScale(state: TimelineState, source: TimelineItem, result: TrackingResult): number {
  const mediaWidth = source.width ?? result.videoWidth;
  const mediaHeight = source.height ?? result.videoHeight;
  const scale = (state.fit ?? 'contain') === 'cover'
    ? Math.max(state.width / mediaWidth, state.height / mediaHeight)
    : Math.min(state.width / mediaWidth, state.height / mediaHeight);
  return scale * (source.transform?.scale ?? 1);
}

function overlappingPoints(source: TimelineItem, target: TimelineItem, points: TrackingPoint[]): TrackingPoint[] {
  return points.filter((point) => {
    const timelineFrame = source.startFrame + point.frame;
    return timelineFrame >= target.startFrame && timelineFrame < target.startFrame + target.durationInFrames;
  });
}

function clampTransform(value: number): number {
  return Math.max(-400, Math.min(400, Number(value.toFixed(4))));
}

export function buildTrackingKeyframeActions(options: BuildTrackingActionsOptions): AtomicAction[] {
  const { state, source, target, result, mode } = options;
  const points = overlappingPoints(source, target, result.points);
  if (points.length < 2) return [];
  const reference = points[0];
  const scale = visibleScale(state, source, result);
  const direction = mode === 'stabilize' ? -1 : 1;
  const baseX = target.transform?.x ?? 0;
  const baseY = target.transform?.y ?? 0;
  const actions: AtomicAction[] = [
    { type: 'clearKeyframes', id: target.id, prop: 'x' },
    { type: 'clearKeyframes', id: target.id, prop: 'y' },
  ];
  for (const point of points) {
    const frame = source.startFrame + point.frame - target.startFrame;
    const dx = direction * (point.x - reference.x) * result.videoWidth * scale * 100 / state.width;
    const dy = direction * (point.y - reference.y) * result.videoHeight * scale * 100 / state.height;
    actions.push(
      { type: 'setKeyframe', id: target.id, prop: 'x', frame, value: clampTransform(baseX + dx), easing: 'linear' },
      { type: 'setKeyframe', id: target.id, prop: 'y', frame, value: clampTransform(baseY + dy), easing: 'linear' },
    );
  }
  return actions;
}

export function trackingTargets(state: TimelineState, source: TimelineItem): TimelineItem[] {
  const sourceEnd = source.startFrame + source.durationInFrames;
  return state.items.filter((item) => {
    if (item.id === source.id || item.kind === 'audio' || state.tracks?.[item.track]?.locked) return false;
    const itemEnd = item.startFrame + item.durationInFrames;
    return item.startFrame < sourceEnd && itemEnd > source.startFrame;
  });
}
