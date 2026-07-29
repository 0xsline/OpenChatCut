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

/** Weighting of snap radius by type: the playhead is "thicker" than the clip edge, it wins when isometric. */
const SNAP_WEIGHT: Partial<Record<SnapPointType, number>> = {
  playhead: 1.5,
  'timeline-start': 1.5,
};

/** How far away you have to go before releasing after sucking (a multiple of the threshold). >1 will cause hysteresis, otherwise it will jitter repeatedly on the boundary. */
export const STICKY_RELEASE = 1.5;

const radiusFor = (type: SnapPointType, thresholdFrames: number): number =>
  Math.max(0, thresholdFrames) * (SNAP_WEIGHT[type] ?? 1);

export function findClosestSnapPoint(
  points: SnapPoint[],
  frame: number,
  thresholdFrames: number,
): SnapPoint | null {
  let best: SnapPoint | null = null;
  // Use "distance / radius of this type" to score, so that weighting will not only relax the scope but also affect the priority. 1 = exactly on the boundary.
  let bestScore = 1;
  for (const point of points) {
    const radius = radiusFor(point.type, thresholdFrames);
    if (radius <= 0) continue;
    const score = Math.abs(point.frame - frame) / radius;
    if (score > bestScore) continue;
    best = point;
    bestScore = score;
  }
  return best;
}

type SnapEdge = 'start' | 'end';

/** The currently sucked target. The caller passes it back intact within a drag and drops it when letting go. */
export interface SnapHold {
  frame: number;
  edge: SnapEdge;
  type: SnapPointType;
}

export interface SnapDraggedEdgesOptions {
  mode: 'move' | 'trim-left' | 'trim-right';
  baseStart: number;
  baseDuration: number;
  rawDelta: number;
  points: SnapPoint[];
  thresholdFrames: number;
  /** The result of the last move. There is lag only if it is passed; if it is not passed, it is the old behavior of recalculating every time. */
  hold?: SnapHold | null;
}

export function snapDraggedEdges(options: SnapDraggedEdgesOptions): {
  deltaF: number;
  snapAt: number | null;
  hold: SnapHold | null;
} {
  const { mode, baseStart, baseDuration, rawDelta, points, thresholdFrames, hold } = options;
  const probe = (edge: SnapEdge): number => baseStart + rawDelta + (edge === 'end' ? baseDuration : 0);
  const deltaFor = (edge: SnapEdge, frame: number): number => frame - baseStart - (edge === 'end' ? baseDuration : 0);
  const edges: SnapEdge[] = mode === 'trim-left' ? ['start'] : mode === 'trim-right' ? ['end'] : ['start', 'end'];

  // If it has been sucked, try to continue holding it first: release it after walking out of 1.5 times the radius, and release it when the target disappears (for example, the clip is deleted).
  if (hold && edges.includes(hold.edge) && points.some((point) => point.frame === hold.frame)) {
    if (Math.abs(probe(hold.edge) - hold.frame) <= radiusFor(hold.type, thresholdFrames) * STICKY_RELEASE) {
      return { deltaF: deltaFor(hold.edge, hold.frame), snapAt: hold.frame, hold };
    }
  }

  // Find again: The move gesture simultaneously explores the head and tail of the fragment, and takes the one with a smaller normalized distance (a tie returns to the head).
  let best: { edge: SnapEdge; point: SnapPoint; score: number } | null = null;
  for (const edge of edges) {
    const point = findClosestSnapPoint(points, probe(edge), thresholdFrames);
    if (!point) continue;
    const score = Math.abs(probe(edge) - point.frame) / Math.max(1e-6, radiusFor(point.type, thresholdFrames));
    if (!best || score < best.score) best = { edge, point, score };
  }
  if (!best) return { deltaF: rawDelta, snapAt: null, hold: null };
  return {
    deltaF: deltaFor(best.edge, best.point.frame),
    snapAt: best.point.frame,
    hold: { frame: best.point.frame, edge: best.edge, type: best.point.type },
  };
}
