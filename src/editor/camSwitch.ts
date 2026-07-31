// Edit planner of change_cam: In the switching interval [fromFrame,toFrame), change the other camera's
// Occluded segments are translated into split/remove (rippleless) atomic actions - the rest of the timeline is completely motionless.
// Deliberately only reuse split (which handles word segmentation, key frame segmentation, and fade-in and fade-out semantics) and remove,
// No new reducer action; single batch = one step undo.
import type { Action } from './reduce';
import type { TimelineItem } from './types';

type Span = Pick<TimelineItem, 'id' | 'startFrame' | 'durationInFrames'>;

export interface CamSwitchPlan {
  actions: Action[];
  /** Other removed camera segments (timeline frame, right open) */
  removed: Array<{ itemId: string; fromFrame: number; toFrame: number }>;
  /** The number of frames that are not covered by the target camera in the interval (>0 = the lower layer or black field will be exposed here) */
  coverageGapFrames: number;
}

/** The total number of frames covered by each segment of the target camera within [fromFrame,toFrame) (no overlap between segments; the capping interval is longer when overlapping). */
export function coveredFrames(targets: readonly Span[], fromFrame: number, toFrame: number): number {
  let total = 0;
  for (const t of targets) {
    const a = Math.max(fromFrame, t.startFrame);
    const b = Math.min(toFrame, t.startFrame + t.durationInFrames);
    if (b > a) total += b - a;
  }
  return Math.min(total, Math.max(0, toFrame - fromFrame));
}

/**
 * Each clip where other camera positions intersect with the interval: cut one or two cuts at the boundary of the interval as needed, and delete the segments within the interval.
 * Split semantics: The left half retains the original id, and the right half gets newId (the source point is moved forward), so the left boundary is cut first and then the right boundary is cut.
 * The midsection id is always known. remove without ripple - camera switching must not move the timeline.
 */
export function planCamSwitch(
  targets: readonly Span[],
  others: readonly Span[],
  fromFrame: number,
  toFrame: number,
  makeId: () => string,
): CamSwitchPlan {
  const actions: Action[] = [];
  const removed: CamSwitchPlan['removed'] = [];
  for (const o of others) {
    const end = o.startFrame + o.durationInFrames;
    const a = Math.max(fromFrame, o.startFrame);
    const b = Math.min(toFrame, end);
    if (b <= a) continue; // Does not intersect with the switching interval
    let segId = o.id;
    if (a > o.startFrame) {
      const rightId = makeId();
      actions.push({ type: 'split', id: segId, atFrame: a, newId: rightId });
      segId = rightId; // Continue processing the right half [a,end)
    }
    if (b < end) {
      // Cut the right boundary again: segId is narrowed to just [a,b), and the new id is the reserved tail segment [b,end)
      actions.push({ type: 'split', id: segId, atFrame: b, newId: makeId() });
    }
    actions.push({ type: 'remove', id: segId });
    removed.push({ itemId: o.id, fromFrame: a, toFrame: b });
  }
  return {
    actions,
    removed,
    coverageGapFrames: Math.max(0, toFrame - fromFrame) - coveredFrames(targets, fromFrame, toFrame),
  };
}
