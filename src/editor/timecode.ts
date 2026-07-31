import type { RationalFrameRate, SourceClockMetadata, TimelineItem } from './types.js';
import { sourceFrameAt } from './sourceLimit.js';

export type TimelineFrameRate = RationalFrameRate | number;

function rateParts(rate: TimelineFrameRate): RationalFrameRate {
  return typeof rate === 'number' ? { numerator: rate, denominator: 1 } : rate;
}

export function isRationalFrameRate(value: unknown): value is RationalFrameRate {
  if (!value || typeof value !== 'object') return false;
  const rate = value as Partial<RationalFrameRate>;
  return typeof rate.numerator === 'number' && Number.isInteger(rate.numerator) && rate.numerator > 0
    && typeof rate.denominator === 'number' && Number.isInteger(rate.denominator) && rate.denominator > 0;
}

export function isSourceClockMetadata(value: unknown): value is SourceClockMetadata {
  if (!value || typeof value !== 'object') return false;
  const clock = value as Partial<SourceClockMetadata>;
  return typeof clock.frameCount === 'number' && Number.isInteger(clock.frameCount) && clock.frameCount >= 0
    && isRationalFrameRate(clock.frameRate)
    && typeof clock.dropFrame === 'boolean';
}

/**
 * Convert a normalized source-clock frame count to the nearest frame in another
 * frame rate. `dropFrame` needs no arithmetic adjustment: `frameCount` is the
 * exact count after parsing the display timecode, not its colon-delimited label.
 */
export function sourceClockToTimelineFrame(
  clock: SourceClockMetadata,
  timelineRate: TimelineFrameRate,
): number {
  const target = rateParts(timelineRate);
  return Math.round(
    (clock.frameCount * clock.frameRate.denominator * target.numerator)
      / (clock.frameRate.numerator * target.denominator),
  );
}

/** Signed target-frame distance between two normalized source clocks. */
export function sourceClockOffsetInTimelineFrames(
  reference: SourceClockMetadata,
  follower: SourceClockMetadata,
  timelineRate: TimelineFrameRate,
): number {
  const target = rateParts(timelineRate);
  const referenceScaled = reference.frameCount * reference.frameRate.denominator
    / reference.frameRate.numerator;
  const followerScaled = follower.frameCount * follower.frameRate.denominator
    / follower.frameRate.numerator;
  const offset = Math.round((followerScaled - referenceScaled) * target.numerator / target.denominator);
  return offset === 0 ? 0 : offset;
}

/**
 * Native clock-frame coordinate at a clip's visible source in-point.
 * `srcInFrame` is stored in the project/timeline frame domain, so it must be
 * rescaled to the source clock's rational rate before adding it to frameCount.
 * Drop-frame labels need no adjustment because frameCount is already physical.
 */
export function sourceClockFrameAtItemIn(
  clock: SourceClockMetadata,
  item: Pick<TimelineItem, 'srcInFrame' | 'playbackRate'>,
  timelineRate: TimelineFrameRate,
): number {
  const timeline = rateParts(timelineRate);
  const itemInClockFrames = Math.round(
    (sourceFrameAt(item, 0) * clock.frameRate.numerator * timeline.denominator)
      / (clock.frameRate.denominator * timeline.numerator),
  );
  return clock.frameCount + itemInClockFrames;
}
