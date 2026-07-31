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
  playheadFrame?: number;
  excludeItemIds?: Iterable<string>;
}

const snapPointOrder = new WeakMap<SnapPoint, number>();
const sortedSnapCollections = new WeakSet<readonly SnapPoint[]>();

const addItemKeyframes = (
  points: SnapPoint[],
  state: TimelineState,
  excluded: Set<string>,
  firstOrder: number,
): number => {
  let order = firstOrder;
  for (const item of state.items) {
    if (excluded.has(item.id)) continue;
    for (const [prop, keyframes] of Object.entries(item.keyframes ?? {}) as [KeyframeProp, { frame: number }[]][]) {
      for (const keyframe of keyframes ?? []) {
        const point = { frame: item.startFrame + keyframe.frame, type: 'keyframe' as const, itemId: item.id, prop };
        snapPointOrder.set(point, order++);
        points.push(point);
      }
    }
    for (const keyframe of item.zoom?.reframeCurve?.keyframes ?? []) {
      const point = {
        frame: item.startFrame + keyframe.frame,
        type: 'keyframe' as const,
        itemId: item.id,
        prop: 'reframe' as const,
      };
      snapPointOrder.set(point, order++);
      points.push(point);
    }
  }
  return order;
};

export function collectTimelineSnapPoints(
  state: TimelineState,
  options: SnapSourceOptions,
): SnapPoint[] {
  const excluded = new Set(options.excludeItemIds ?? []);
  const points: SnapPoint[] = [];
  let order = 0;
  const add = (point: SnapPoint) => {
    snapPointOrder.set(point, order);
    points.push(point);
    order += 1;
  };
  add({ frame: 0, type: 'timeline-start' });
  if (Number.isFinite(options.playheadFrame)) add({ frame: options.playheadFrame!, type: 'playhead' });
  else order += 1;
  for (const item of state.items) {
    if (excluded.has(item.id)) continue;
    add({ frame: item.startFrame, type: 'item-start', itemId: item.id });
    add({ frame: item.startFrame + item.durationInFrames, type: 'item-end', itemId: item.id });
  }
  for (const marker of state.markers ?? []) {
    add({ frame: marker.fromFrame, type: 'marker-start', markerId: marker.id });
    if (marker.durationFrames > 0) {
      add({ frame: marker.fromFrame + marker.durationFrames, type: 'marker-end', markerId: marker.id });
    }
  }
  addItemKeyframes(points, state, excluded, order);
  return points.filter((point) => Number.isFinite(point.frame));
}

/** Weighting of snap radius by type: the playhead is "thicker" than the clip edge, it wins when isometric. */
const SNAP_WEIGHT: Partial<Record<SnapPointType, number>> = {
  playhead: 1.5,
  'timeline-start': 1.5,
};
const MAX_SNAP_WEIGHT = Math.max(...Object.values(SNAP_WEIGHT), 1);

/** How far away you have to go before releasing after sucking (a multiple of the threshold). >1 will cause hysteresis, otherwise it will jitter repeatedly on the boundary. */
export const STICKY_RELEASE = 1.5;

const radiusFor = (type: SnapPointType, thresholdFrames: number): number =>
  Math.max(0, thresholdFrames) * (SNAP_WEIGHT[type] ?? 1);

export function sortTimelineSnapPoints(points: readonly SnapPoint[]): SnapPoint[] {
  let nextOrder = points.reduce((max, point) => Math.max(max, snapPointOrder.get(point) ?? -1), -1) + 1;
  points.forEach((point) => {
    if (!snapPointOrder.has(point)) snapPointOrder.set(point, nextOrder++);
  });
  const sorted = [...points].sort((a, b) => a.frame - b.frame);
  sortedSnapCollections.add(sorted);
  return sorted;
}

function firstSnapAtOrAfter(points: readonly SnapPoint[], frame: number): number {
  let lo = 0;
  let hi = points.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (points[mid]!.frame < frame) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export function findClosestSnapPoint(
  points: SnapPoint[],
  frame: number,
  thresholdFrames: number,
  dynamicPlayheadFrame?: number,
): SnapPoint | null {
  let best: SnapPoint | null = null;
  let bestScore = 1;
  let bestOrder = -1;
  const consider = (point: SnapPoint, fallbackOrder: number) => {
    const radius = radiusFor(point.type, thresholdFrames);
    if (radius <= 0) return;
    const score = Math.abs(point.frame - frame) / radius;
    const order = snapPointOrder.get(point) ?? fallbackOrder;
    if (score > bestScore || score === bestScore && order < bestOrder) return;
    best = point;
    bestScore = score;
    bestOrder = order;
  };
  if (sortedSnapCollections.has(points)) {
    const span = Math.max(0, thresholdFrames) * MAX_SNAP_WEIGHT;
    const first = firstSnapAtOrAfter(points, frame - span);
    for (let i = first; i < points.length && points[i]!.frame <= frame + span; i += 1) {
      consider(points[i]!, i);
    }
  } else {
    points.forEach(consider);
  }
  if (Number.isFinite(dynamicPlayheadFrame)) {
    const playhead = { frame: dynamicPlayheadFrame!, type: 'playhead' as const };
    snapPointOrder.set(playhead, 1);
    consider(playhead, 1);
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
  dynamicPlayheadFrame?: number;
}

function hasSnapFrame(points: SnapPoint[], frame: number, dynamicPlayheadFrame?: number): boolean {
  if (dynamicPlayheadFrame === frame) return true;
  if (!sortedSnapCollections.has(points)) return points.some((point) => point.frame === frame);
  return points[firstSnapAtOrAfter(points, frame)]?.frame === frame;
}

export function snapDraggedEdges(options: SnapDraggedEdgesOptions): {
  deltaF: number;
  snapAt: number | null;
  hold: SnapHold | null;
} {
  const {
    mode, baseStart, baseDuration, rawDelta, points, thresholdFrames, hold, dynamicPlayheadFrame,
  } = options;
  const probe = (edge: SnapEdge): number => baseStart + rawDelta + (edge === 'end' ? baseDuration : 0);
  const deltaFor = (edge: SnapEdge, frame: number): number => frame - baseStart - (edge === 'end' ? baseDuration : 0);
  const edges: SnapEdge[] = mode === 'trim-left' ? ['start'] : mode === 'trim-right' ? ['end'] : ['start', 'end'];

  // If it has been sucked, try to continue holding it first: release it after walking out of 1.5 times the radius, and release it when the target disappears (for example, the clip is deleted).
  if (hold && edges.includes(hold.edge) && hasSnapFrame(points, hold.frame, dynamicPlayheadFrame)) {
    if (Math.abs(probe(hold.edge) - hold.frame) <= radiusFor(hold.type, thresholdFrames) * STICKY_RELEASE) {
      return { deltaF: deltaFor(hold.edge, hold.frame), snapAt: hold.frame, hold };
    }
  }

  // Find again: The move gesture simultaneously explores the head and tail of the fragment, and takes the one with a smaller normalized distance (a tie returns to the head).
  let best: { edge: SnapEdge; point: SnapPoint; score: number } | null = null;
  for (const edge of edges) {
    const point = findClosestSnapPoint(points, probe(edge), thresholdFrames, dynamicPlayheadFrame);
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
