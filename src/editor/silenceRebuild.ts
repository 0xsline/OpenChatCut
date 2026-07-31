// remove_silence's edit planner: translate "source audio silent interval" into a sequence of split/remove operations
// Action (single batch = one step undo). Deliberately only reuse split (transcript word segmentation, key frame segmentation, fade in and out)
// The semantics are all handled by it) and remove (same track ripple closure), no new reducer action is added.
import type { Action } from './reduce';
import type { TimelineItem } from './types';
import { sourceFramesToTimelineFrames, sourceWindowForTimelineRange } from './sourceLimit';
import type { SilenceSpan } from '../audio/silence';
import { hasOperationalTranscript } from '../transcript/types';

/** The cut segments are too fragmented and meaningless: if the reserved segments between static segments are shorter than this number of frames, they will be merged and deleted. */
const MIN_KEEP_FRAMES = 6;
/** No action is taken when the silent segment is shorter than this number of frames (lower limit of the frame domain, minSilenceMs of the overlay detection layer). */
const MIN_CUT_FRAMES = 2;

export interface PlannedRemoval {
  actions: Action[];
  /** Total number of frames deleted (timeline frames) */
  removedFrames: number;
  /** Actual knife segment (clip visible partial frame) */
  cuts: Array<{ fromFrame: number; toFrame: number }>;
}

/** Source millisecond dead air segment → clip visible local frame segment (clamp to clip source window; clip to edge and small segment). */
export function spansToLocalCuts(
  item: Pick<TimelineItem, 'durationInFrames' | 'srcInFrame' | 'playbackRate'>,
  spans: readonly SilenceSpan[],
  fps: number,
): Array<{ fromFrame: number; toFrame: number }> {
  const window = sourceWindowForTimelineRange(item, 0, item.durationInFrames);
  const clamped = spans
    .map((span) => ({
      fromFrame: Math.max(0, Math.round(sourceFramesToTimelineFrames(
        item,
        (span.startMs / 1000) * fps - window.startFrame,
      ))),
      toFrame: Math.min(item.durationInFrames, Math.round(sourceFramesToTimelineFrames(
        item,
        (span.endMs / 1000) * fps - window.startFrame,
      ))),
    }))
    .filter((c) => c.toFrame - c.fromFrame >= MIN_CUT_FRAMES)
    .sort((a, b) => a.fromFrame - b.fromFrame);
  // The reserved segments between adjacent static segments are too fragmented → delete them together with the reserved segments (merge intervals)
  const merged: Array<{ fromFrame: number; toFrame: number }> = [];
  for (const cut of clamped) {
    const prev = merged[merged.length - 1];
    if (prev && cut.fromFrame - prev.toFrame < MIN_KEEP_FRAMES) prev.toFrame = Math.max(prev.toFrame, cut.toFrame);
    else merged.push({ ...cut });
  }
  // The fragmented reserved sections at the beginning and end are also merged into
  if (merged.length) {
    if (merged[0]!.fromFrame < MIN_KEEP_FRAMES) merged[0]!.fromFrame = 0;
    const last = merged[merged.length - 1]!;
    if (item.durationInFrames - last.toFrame < MIN_KEEP_FRAMES) last.toFrame = item.durationInFrames;
  }
  // Swallowed whole = The detection layer said "it's all dead energy" but passed the voice reference gate - it shouldn't happen, give up conservatively
  if (merged.length === 1 && merged[0]!.fromFrame === 0 && merged[0]!.toFrame === item.durationInFrames) return [];
  return merged;
}

/**
 * Turn the dead breath segment into a split/remove action sequence. Actions are applied sequentially (batch semantics):
 * The atFrame of split uses the timeline coordinates of "after the previous step", and the co-orbital ripple of remove is shifted to the left by this function.
 * Compensation on a segment-by-segment basis. newId is injected by the caller (deterministic in browser crypto.randomUUID;verify).
 */
export function planSilenceRemoval(
  item: Pick<TimelineItem, 'id' | 'startFrame' | 'durationInFrames'>,
  cuts: ReadonlyArray<{ fromFrame: number; toFrame: number }>,
  makeId: () => string,
): PlannedRemoval {
  const actions: Action[] = [];
  const planned: Array<{ fromFrame: number; toFrame: number }> = [];
  let tailId = item.id; // The id of the current "unprocessed right remaining segment"
  let tailStart = item.startFrame; // The current starting point of the timeline for this remaining segment (updated with the ripple moving left)
  let tailLocal = 0; // The visible local frame of the clip corresponding to the starting point of the remaining segment
  let removed = 0;

  for (const cut of cuts) {
    if (!tailId) break;
    const from = Math.max(cut.fromFrame, tailLocal);
    const to = Math.min(cut.toFrame, item.durationInFrames);
    if (to - from < MIN_CUT_FRAMES) continue;
    const cutsTail = to >= item.durationInFrames; // Quiet to the end of clip

    if (from <= tailLocal) {
      // The static section is next to the beginning of the rest section: cut the static section out and delete it
      if (cutsTail) {
        // The entire remaining paragraph is silent: delete it directly
        actions.push({ type: 'remove', ripple: true, id: tailId });
        planned.push({ fromFrame: from, toFrame: to });
        removed += to - from;
        tailId = '';
        break;
      }
      const restId = makeId();
      actions.push({ type: 'split', id: tailId, atFrame: tailStart + (to - tailLocal), newId: restId });
      actions.push({ type: 'remove', ripple: true, id: tailId });
      planned.push({ fromFrame: from, toFrame: to });
      removed += to - from;
      tailId = restId; // remove ripple pulls rest back to tailStart
      tailLocal = to;
      continue;
    }

    // The quiet section is in the middle/end of the remaining section: cut out the left reserved section first
    const silentId = makeId();
    actions.push({ type: 'split', id: tailId, atFrame: tailStart + (from - tailLocal), newId: silentId });
    if (cutsTail) {
      actions.push({ type: 'remove', ripple: true, id: silentId });
      planned.push({ fromFrame: from, toFrame: to });
      removed += to - from;
      tailId = '';
      break;
    }
    const restId = makeId();
    actions.push({ type: 'split', id: silentId, atFrame: tailStart + (from - tailLocal) + (to - from), newId: restId });
    actions.push({ type: 'remove', ripple: true, id: silentId });
    planned.push({ fromFrame: from, toFrame: to });
    removed += to - from;
    tailId = restId;
    tailStart = tailStart + (from - tailLocal); // rest is pulled by the ripple to the original starting point of the static segment
    tailLocal = to;
  }

  return { actions, removedFrames: removed, cuts: planned };
}

/** remove_silence clip that should not be touched: give a readable reason, and the tool layer reports it as it is. */
export function silenceRemovalBlocker(item: TimelineItem): string | null {
  if (item.kind !== 'video' && item.kind !== 'audio') return `kind=${item.kind} 无音频`;
  if (!item.src) return '无媒体源';
  if ((item.playbackRate ?? 1) !== 1) return '已变速(playbackRate≠1) — 先删静音再变速,或用 clean_script';
  if (item.zoom) return '带动画缩放(zoom) — 分段会打断缩放曲线,先移除 zoom';
  if (hasOperationalTranscript(item) && (item.deletedWordIdx?.length || item.silenceFrames !== undefined || item.gapCapsMs)) {
    return '已有词级编辑/静音压缩 — 转写 clip 请用 clean_script 的静音上限(它按词间隙精确处理)';
  }
  return null;
}
