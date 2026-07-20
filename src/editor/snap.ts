import type { KeyframeProp, TimelineState } from './types';

export type SnapPointType =
  | 'timeline-start'
  | 'playhead'
  | 'item-start'
  | 'item-end'
  | 'marker-start'
  | 'marker-end'
  | 'keyframe';

export interface SnapPoint {
  frame: number;
  type: SnapPointType;
  itemId?: string;
  markerId?: string;
  prop?: KeyframeProp | 'reframe';
}

interface SnapSourceOptions {
  playheadFrame: number;
  excludeItemIds?: Iterable<string>;
}

const addItemKeyframes = (points: SnapPoint[], state: TimelineState, excluded: Set<string>) => {
  for (const item of state.items) {
    if (excluded.has(item.id)) continue;
    for (const [prop, keyframes] of Object.entries(item.keyframes ?? {}) as [KeyframeProp, { frame: number }[]][]) {
      for (const keyframe of keyframes ?? []) {
        points.push({ frame: item.startFrame + keyframe.frame, type: 'keyframe', itemId: item.id, prop });
      }
    }
    for (const keyframe of item.zoom?.reframeCurve?.keyframes ?? []) {
      points.push({ frame: item.startFrame + keyframe.frame, type: 'keyframe', itemId: item.id, prop: 'reframe' });
    }
  }
};

export function collectTimelineSnapPoints(
  state: TimelineState,
  options: SnapSourceOptions,
): SnapPoint[] {
  const excluded = new Set(options.excludeItemIds ?? []);
  const points: SnapPoint[] = [
    { frame: 0, type: 'timeline-start' },
    { frame: options.playheadFrame, type: 'playhead' },
  ];
  for (const item of state.items) {
    if (excluded.has(item.id)) continue;
    points.push({ frame: item.startFrame, type: 'item-start', itemId: item.id });
    points.push({
      frame: item.startFrame + item.durationInFrames,
      type: 'item-end',
      itemId: item.id,
    });
  }
  for (const marker of state.markers ?? []) {
    points.push({ frame: marker.fromFrame, type: 'marker-start', markerId: marker.id });
    if (marker.durationFrames > 0) {
      points.push({
        frame: marker.fromFrame + marker.durationFrames,
        type: 'marker-end',
        markerId: marker.id,
      });
    }
  }
  addItemKeyframes(points, state, excluded);
  return points.filter((point) => Number.isFinite(point.frame));
}

export function findClosestSnapPoint(
  points: SnapPoint[],
  frame: number,
  thresholdFrames: number,
): SnapPoint | null {
  let best: SnapPoint | null = null;
  let distance = Math.max(0, thresholdFrames);
  for (const point of points) {
    const nextDistance = Math.abs(point.frame - frame);
    if (nextDistance > distance) continue;
    best = point;
    distance = nextDistance;
  }
  return best;
}

export interface SnapDraggedEdgesOptions {
  mode: 'move' | 'trim-left' | 'trim-right';
  baseStart: number;
  baseDuration: number;
  rawDelta: number;
  points: SnapPoint[];
  thresholdFrames: number;
}

export function snapDraggedEdges(options: SnapDraggedEdgesOptions): {
  deltaF: number;
  snapAt: number | null;
} {
  const { mode, baseStart, baseDuration, rawDelta, points, thresholdFrames } = options;
  const start = baseStart + rawDelta;
  const end = baseStart + baseDuration + rawDelta;
  if (mode === 'trim-left') {
    const point = findClosestSnapPoint(points, start, thresholdFrames);
    return point ? { deltaF: point.frame - baseStart, snapAt: point.frame } : { deltaF: rawDelta, snapAt: null };
  }
  if (mode === 'trim-right') {
    const point = findClosestSnapPoint(points, end, thresholdFrames);
    return point ? { deltaF: point.frame - baseStart - baseDuration, snapAt: point.frame } : { deltaF: rawDelta, snapAt: null };
  }
  const startPoint = findClosestSnapPoint(points, start, thresholdFrames);
  const endPoint = findClosestSnapPoint(points, end, thresholdFrames);
  const startDistance = startPoint ? Math.abs(start - startPoint.frame) : Infinity;
  const endDistance = endPoint ? Math.abs(end - endPoint.frame) : Infinity;
  if (startPoint && startDistance <= endDistance) {
    return { deltaF: startPoint.frame - baseStart, snapAt: startPoint.frame };
  }
  if (endPoint) return { deltaF: endPoint.frame - baseStart - baseDuration, snapAt: endPoint.frame };
  return { deltaF: rawDelta, snapAt: null };
}
