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

/** 吸附半径的按类型加权:播放头比片段边缘更"粗",等距时它赢。 */
const SNAP_WEIGHT: Partial<Record<SnapPointType, number>> = {
  playhead: 1.5,
  'timeline-start': 1.5,
};

/** 吸住之后要离开多远才松开(阈值的倍数)。>1 才有迟滞,否则会在边界上反复抖。 */
export const STICKY_RELEASE = 1.5;

const radiusFor = (type: SnapPointType, thresholdFrames: number): number =>
  Math.max(0, thresholdFrames) * (SNAP_WEIGHT[type] ?? 1);

export function findClosestSnapPoint(
  points: SnapPoint[],
  frame: number,
  thresholdFrames: number,
): SnapPoint | null {
  let best: SnapPoint | null = null;
  // 用「距离 / 该类型的半径」打分,这样加权才既放宽范围又影响优先级。1 = 正好在边界上。
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

/** 当前吸住的目标。由调用方在一次拖拽内原样传回来,松手时丢掉。 */
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
  /** 上一次 move 的结果。传了才有迟滞;不传就是每次重算的老行为。 */
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

  // 已经吸住的先尝试续住:走出 1.5 倍半径才松开,目标消失(比如那个片段被删了)也松开。
  if (hold && edges.includes(hold.edge) && points.some((point) => point.frame === hold.frame)) {
    if (Math.abs(probe(hold.edge) - hold.frame) <= radiusFor(hold.type, thresholdFrames) * STICKY_RELEASE) {
      return { deltaF: deltaFor(hold.edge, hold.frame), snapAt: hold.frame, hold };
    }
  }

  // 重新找:move 手势同时探片段的头和尾,取归一化距离更小的那个(平局归头)。
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
