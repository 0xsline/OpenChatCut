// A clip cannot be longer than its source asset.
//
// There is always a srcInFrame bottom when cropping on the left side (the entry point cannot be negative), but there is no upper bound at all on the right side: move the right handle
// Drag outward to pull out a clip that is longer than the asset, and the excess part will only be frozen in the last frame. The upper bound is given by reduce's
// Retime is executed uniformly - pointer drag and agent's cropping tools are all merged into that road.
import type { MediaAsset, TimelineItem } from './types.js';
import { hasOperationalTranscript } from '../transcript/types.js';

type SourceItem = Pick<TimelineItem, 'kind' | 'src' | 'playbackRate' | 'transcript' | 'transcriptStale'>;
export type SourceTimingItem = Pick<TimelineItem, 'srcInFrame' | 'playbackRate'>;
export interface SourceFrameWindow {
  startFrame: number;
  endFrame: number;
}

/** Convert a timeline-frame delta to its source-media-frame delta. Fractional source frames are preserved. */
export function timelineFramesToSourceFrames(item: SourceTimingItem, frames: number): number {
  return frames * Math.max(0.01, item.playbackRate ?? 1);
}

/** Convert a source-media-frame delta to its timeline-frame delta. Fractional timeline frames are preserved. */
export function sourceFramesToTimelineFrames(item: SourceTimingItem, frames: number): number {
  return frames / Math.max(0.01, item.playbackRate ?? 1);
}

/** Source-media frame at an item-local timeline frame (negative during transition pre-roll). */
export function sourceFrameAt(item: SourceTimingItem, localFrame: number): number {
  return Math.max(0, (item.srcInFrame ?? 0) + timelineFramesToSourceFrames(item, localFrame));
}

/** Clamped source-media window corresponding to an item-local timeline range. */
export function sourceWindowForTimelineRange(
  item: SourceTimingItem,
  localStartFrame: number,
  durationInFrames: number,
): SourceFrameWindow {
  const startFrame = sourceFrameAt(item, localStartFrame);
  const endFrame = sourceFrameAt(item, localStartFrame + Math.max(0, durationInFrames));
  return { startFrame, endFrame: Math.max(startFrame, endFrame) };
}

/**
 * How many timeline frames can be played starting from `srcInFrame`; if the length cannot be determined, null (no limit) is returned.
 *
 * Only effective for real file media (video/audio): pictures, MG, text, and solid colors can be stretched arbitrarily.
 * Word-driven audio (audio + transcript) is closed by retime itself according to the length of the word stream after editing. Do not go here.
 * Otherwise the two sets of upper bounds will fight. playbackRate conversion: timeline frame = source frame / rate.
 */
export function remainingSourceFrames(
  item: SourceItem,
  srcInFrame: number,
  assets: readonly MediaAsset[] | undefined,
): number | null {
  if (item.kind !== 'video' && item.kind !== 'audio') return null;
  if (item.kind === 'audio' && hasOperationalTranscript(item)) return null;
  if (!item.src || !assets?.length) return null;
  const total = assets.find((asset) => asset.src === item.src)?.durationInFrames ?? 0;
  if (!(total > 0)) return null;
  return Math.max(1, Math.floor(sourceFramesToTimelineFrames(item, total - Math.max(0, srcInFrame))));
}
