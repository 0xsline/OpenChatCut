// Self-healing of duration-derived data: once the segment length changes, the data attached to the length must return to the legal range.
//
// Two invariants:
// 1. Fade on both sides cannot overlap - fadeIn + fadeOut ≤ durationInFrames. Clamp each individually to full length
// It is not enough: a 100-frame clip can get 90-frame fade-in and 90-frame fade-out at the same time, fadeFactor takes both
// Smaller value, the entire segment will always be dark.
// 2. Keyframes cannot fall after the last frame - those frames will never be rendered.
//
// retime / setSpeed / split / deleting words and muting will change durationInFrames but ignore these two,
// So the repair is done at the exit of reduce instead of adding a guard in each case:
// One less branch means one less place to miss. By the way, the illegal values ​​that have been saved in the historical project will be self-healed.
import { splitKeyframes } from './keyframes';
import type { ItemKeyframes, Keyframe, KeyframeProp, TimelineItem } from './types';

/** Fade clamp: Return the negative number to zero, and then give `room` to the opposite side. undefined means "not set", keep it unset. */
export function capFade(value: number | undefined, room: number): number | undefined {
  if (value === undefined) return undefined;
  return Math.max(0, Math.min(value, Math.max(0, room)));
}

/**
 * Cut to 0..last: Reuse the left half of splitKeyframes, which will put an exact border anchor on `last`
 * (Bezier segments are subdivided by de Casteljau), so each still rendered frame sample value is completely unchanged - directly
 * Losing the tail keyframe will cause the curve to stop at the value of the previous keyframe early. If it is already within the range, it will be returned unchanged.
 */
export function truncateKeyframes(kfs: readonly Keyframe[], last: number): Keyframe[] {
  const tail = kfs[kfs.length - 1];
  if (!tail || tail.frame <= last) return kfs as Keyframe[];
  return splitKeyframes(kfs, Math.max(0, last))[0];
}

/** Truncate by attribute; return the original object when all are in range (keep reference equality). */
export function fitKeyframes(ik: ItemKeyframes | undefined, last: number): ItemKeyframes | undefined {
  if (!ik) return ik;
  let changed = false;
  const out: ItemKeyframes = {};
  for (const [prop, kfs] of Object.entries(ik) as [KeyframeProp, Keyframe[]][]) {
    if (!kfs?.length) continue;
    const next = truncateKeyframes(kfs, last);
    if (next !== kfs) changed = true;
    out[prop] = next;
  }
  if (!changed) return ik;
  return Object.keys(out).length ? out : undefined;
}

type FitTarget = Pick<TimelineItem, 'durationInFrames' | 'fadeInFrames' | 'fadeOutFrames' | 'keyframes'>;

/**
 * Push fades and keyframes of a single clip back to the current duration. Returns the original fragment itself when nothing is out of bounds,
 * Let the full scan of the reduce export not generate new objects or trigger redundant re-rendering under common circumstances.
 */
export function fitItemToDuration<T extends FitTarget>(item: T): T {
  const duration = Math.max(1, item.durationInFrames);
  // fadeIn first clamps to the full length, fadeOut and then eats the remaining space: this is the "repair" path, no side is
  // The user is currently editing, so the priority can be fixed (there is also a rule for "the edited side gives way" in setFade).
  const fadeInFrames = capFade(item.fadeInFrames, duration);
  const fadeOutFrames = capFade(item.fadeOutFrames, duration - (fadeInFrames ?? 0));
  const keyframes = fitKeyframes(item.keyframes, duration - 1);
  if (
    fadeInFrames === item.fadeInFrames
    && fadeOutFrames === item.fadeOutFrames
    && keyframes === item.keyframes
  ) {
    return item;
  }
  return { ...item, fadeInFrames, fadeOutFrames, keyframes };
}

/**
 * Press all clips in a timeline back to their respective durations. Return the original object when all are valid (reference equality),
 * So placing it at the reduce exit and running it action by action will not cause unnecessary re-rendering.
 *
 * Also run it when loading the project: reduce is only executed when there is an action, and the illegal desalination that has been saved in the historical project is
 * It can't be fixed by itself - the user has to move the segment before it becomes normal.
 */
export function fitTimelineItems<T extends { items: TimelineItem[] }>(timeline: T): T {
  let changed = false;
  const items = timeline.items.map((it) => {
    const next = fitItemToDuration(it);
    if (next !== it) changed = true;
    return next;
  });
  return changed ? { ...timeline, items } : timeline;
}
