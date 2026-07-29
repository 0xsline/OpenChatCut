// A clip cannot be longer than its source asset.
//
// There is always a srcInFrame bottom when cropping on the left side (the entry point cannot be negative), but there is no upper bound at all on the right side: move the right handle
// Drag outward to pull out a clip that is longer than the asset, and the excess part will only be frozen in the last frame. The upper bound is given by reduce's
// Retime is executed uniformly - pointer drag and agent's cropping tools are all merged into that road.
import type { MediaAsset, TimelineItem } from './types';

type SourceItem = Pick<TimelineItem, 'kind' | 'src' | 'playbackRate' | 'transcript'>;

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
  if (item.kind === 'audio' && item.transcript?.length) return null;
  if (!item.src || !assets?.length) return null;
  const total = assets.find((asset) => asset.src === item.src)?.durationInFrames ?? 0;
  if (!(total > 0)) return null;
  const rate = Math.max(0.01, item.playbackRate ?? 1);
  return Math.max(1, Math.floor((total - Math.max(0, srcInFrame)) / rate));
}
