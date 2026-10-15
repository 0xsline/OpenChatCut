// Nested sequences, flattened: where every timeline instance reachable through
// sequence items lands on the root timeline. An exporter that cannot nest (the
// JianYing / CapCut draft) maps each leaf clip or caption through these
// placements. The mapping is NestedSequenceLayer's: a sequence item shows its
// child from srcInFrame onward at playbackRate (sourceFrameAt), and only for the
// item's own window. Its freeze on the child's last frame when the item outlasts
// the child has no leaf to map, so a flattened timeline leaves a gap there.
import type { ProjectDoc, Timeline } from './types.js';
import { isSequenceItem, resolveTimelineRenderPlan, type SequenceGraphLimits } from './sequenceGraph.js';
import { sourceWindowForTimelineRange, timelineFramesToSourceFrames } from './sourceLimit.js';

/** One timeline instance and where its frames land on the root timeline. */
export interface TimelinePlacement {
  timeline: Timeline;
  /** Visible window, in this timeline's own frames. */
  fromFrame: number;
  toFrame: number;
  /** Root frame that `fromFrame` lands on. */
  rootFrame: number;
  /** This timeline's frames per root frame: the product of the nesting playback rates. */
  rate: number;
}

/** A range clipped to a placement's window and mapped onto the root timeline. */
export interface PlacedRange {
  /** The clipped range, in the placed timeline's own time. */
  localStart: number;
  localEnd: number;
  /** Where the clipped range lands on the root timeline. */
  rootStart: number;
  rootDuration: number;
}

/** Clip [start, end) to the placement's window and map it onto the root; null
 * when none of it is visible. The mapping is linear, so it works in any time
 * unit as long as the placement is expressed in the same one. */
export function placeRange(placement: TimelinePlacement, start: number, end: number): PlacedRange | null {
  const localStart = Math.max(start, placement.fromFrame);
  const localEnd = Math.min(end, placement.toFrame);
  if (!(localEnd > localStart)) return null;
  return {
    localStart,
    localEnd,
    rootStart: placement.rootFrame + (localStart - placement.fromFrame) / placement.rate,
    rootDuration: (localEnd - localStart) / placement.rate,
  };
}

/**
 * Every timeline instance reachable from `timelineId` through sequence items,
 * root first, then depth-first in item order. A timeline referenced twice is
 * placed twice; an instance entirely outside its parent's window is dropped.
 * The graph is validated first by resolveTimelineRenderPlan — the render path's
 * own check — so a cycle, a missing timeline, an fps mismatch or a limit breach
 * throws the same SequenceGraphError a render would.
 */
export function timelinePlacements(
  project: Pick<ProjectDoc, 'timelines' | 'assets'>,
  timelineId: string,
  limits: SequenceGraphLimits = {},
): TimelinePlacement[] {
  resolveTimelineRenderPlan(project, timelineId, limits);
  const timelines = new Map(project.timelines.map((timeline) => [timeline.id, timeline]));
  const placements: TimelinePlacement[] = [];
  const visit = (placement: TimelinePlacement): void => {
    placements.push(placement);
    for (const item of placement.timeline.items) {
      if (!isSequenceItem(item)) continue;
      const child = timelines.get(item.timelineId);
      const shown = child ? placeRange(placement, item.startFrame, item.startFrame + item.durationInFrames) : null;
      if (!child || !shown) continue;
      // The child frames the visible part of the item shows.
      const window = sourceWindowForTimelineRange(item, shown.localStart - item.startFrame, shown.localEnd - shown.localStart);
      visit({
        timeline: child,
        fromFrame: window.startFrame,
        toFrame: window.endFrame,
        rootFrame: shown.rootStart,
        rate: placement.rate * timelineFramesToSourceFrames(item, 1),
      });
    }
  };
  const root = timelines.get(timelineId);
  if (root) visit({ timeline: root, fromFrame: 0, toFrame: Number.POSITIVE_INFINITY, rootFrame: 0, rate: 1 });
  return placements;
}
