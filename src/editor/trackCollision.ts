import type { TimelineItem, TimelineState, TrackId } from './types';

interface MoveDeltaBounds {
  min?: number;
  max?: number;
}

interface DeltaInterval {
  min: number;
  max: number;
}

function overlaps(left: TimelineItem, right: TimelineItem): boolean {
  return left.track === right.track
    && left.startFrame < right.startFrame + right.durationInFrames
    && left.startFrame + left.durationInFrames > right.startFrame;
}

function mergeIntervals(intervals: DeltaInterval[]): DeltaInterval[] {
  const ordered = intervals.toSorted((left, right) => left.min - right.min || left.max - right.max);
  const merged: DeltaInterval[] = [];
  for (const interval of ordered) {
    const previous = merged[merged.length - 1];
    if (!previous || interval.min > previous.max + 1) merged.push({ ...interval });
    else previous.max = Math.max(previous.max, interval.max);
  }
  return merged;
}

function projectMoveDelta(
  intervals: readonly DeltaInterval[],
  requested: number,
  min: number,
  max: number,
): number | null {
  if (min > max) return null;
  const target = Math.min(max, Math.max(min, Math.round(requested)));
  const blocked = intervals.find((interval) => target >= interval.min && target <= interval.max);
  if (!blocked) return target;
  const before = blocked.min - 1;
  const after = blocked.max + 1;
  const candidates = [before, after].filter((value) => value >= min && value <= max);
  if (!candidates.length) return null;
  if (target > 0) return candidates.includes(before) ? before : after;
  if (target < 0) return candidates.includes(after) ? after : before;
  return candidates.toSorted((left, right) => Math.abs(left) - Math.abs(right) || right - left)[0]!;
}

/** Clamp one shared move delta to frame zero and every stationary same-track clip. */
export function clampMoveDeltaToTrackGaps(
  state: TimelineState,
  moving: readonly TimelineItem[],
  movingIds: ReadonlySet<string>,
  requestedDelta: number,
  bounds: MoveDeltaBounds = {},
): number | null {
  if (!moving.length) return null;
  const originals = new Map(state.items.map((item) => [item.id, item]));
  for (let left = 0; left < moving.length; left += 1) {
    for (let right = left + 1; right < moving.length; right += 1) {
      if (!overlaps(moving[left]!, moving[right]!)) continue;
      const originalLeft = originals.get(moving[left]!.id);
      const originalRight = originals.get(moving[right]!.id);
      if (!originalLeft || !originalRight || !overlaps(originalLeft, originalRight)) return null;
    }
  }
  const min = Math.max(bounds.min ?? Number.NEGATIVE_INFINITY, ...moving.map((item) => -item.startFrame));
  const max = bounds.max ?? Number.POSITIVE_INFINITY;
  const intervals: DeltaInterval[] = [];
  for (const item of moving) {
    for (const obstacle of state.items) {
      if (movingIds.has(obstacle.id) || obstacle.track !== item.track) continue;
      const interval = {
        min: obstacle.startFrame - item.startFrame - item.durationInFrames + 1,
        max: obstacle.startFrame + obstacle.durationInFrames - item.startFrame - 1,
      };
      if (interval.min <= interval.max) intervals.push(interval);
    }
  }
  return projectMoveDelta(mergeIntervals(intervals), requestedDelta, min, max);
}

function trackOverlapPairs(items: readonly TimelineItem[]): Set<string> {
  const byTrack = new Map<TrackId, TimelineItem[]>();
  for (const item of items) {
    const lane = byTrack.get(item.track) ?? [];
    lane.push(item);
    byTrack.set(item.track, lane);
  }
  const pairs = new Set<string>();
  for (const [track, lane] of byTrack) {
    const ordered = lane.toSorted((left, right) => left.startFrame - right.startFrame);
    for (let left = 0; left < ordered.length; left += 1) {
      const leftItem = ordered[left]!;
      const leftEnd = leftItem.startFrame + leftItem.durationInFrames;
      for (let right = left + 1; right < ordered.length; right += 1) {
        const rightItem = ordered[right]!;
        if (rightItem.startFrame >= leftEnd) break;
        const ids = [leftItem.id, rightItem.id].toSorted();
        pairs.add(`${track}\u0000${ids[0]}\u0000${ids[1]}`);
      }
    }
  }
  return pairs;
}

/** Reject only overlap pairs newly created by an edit; legacy pairs remain loadable. */
export function introducesTrackOverlap(before: TimelineState, after: TimelineState): boolean {
  if (before.items === after.items) return false;
  const existing = trackOverlapPairs(before.items);
  return [...trackOverlapPairs(after.items)].some((pair) => !existing.has(pair));
}
