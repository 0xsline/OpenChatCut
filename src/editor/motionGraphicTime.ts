import type { TimelineItem } from './types';

/**
 * Play one piece of a split motion graphic as its window of the whole design. The template reads its
 * own time with useCurrentFrame() and useVideoConfig(), both of which come from the enclosing sequence,
 * so shift that sequence back by the piece's in-point and report the whole design's length: the right
 * piece continues mid-animation instead of replaying the intro, and no piece fades out at a cut.
 * Unsplit clips (no designDurationInFrames) pass straight through, exactly as before.
 */
export function motionGraphicTime(
  parent: { relativeFrom: number; durationInFrames: number },
  item: Pick<TimelineItem, 'srcInFrame' | 'durationInFrames' | 'designDurationInFrames'>,
): { relativeFrom: number; durationInFrames: number } | null {
  if (!item.designDurationInFrames) return null;
  const offset = item.srcInFrame ?? 0;
  // The parent may extend past the clip (transition handles); keep that extra, swap the clip for the design.
  const extension = Math.max(0, parent.durationInFrames - item.durationInFrames);
  return {
    relativeFrom: parent.relativeFrom - offset,
    durationInFrames: item.designDurationInFrames + extension,
  };
}

/**
 * A split motion-graphic piece plays a window of a longer design, so it trims like video: moving its start
 * cuts into (or back out of) the animation, and its end cannot run past the design's last frame.
 */
export function isWindowedMotionGraphic(item: Pick<TimelineItem, 'kind' | 'designDurationInFrames'>): boolean {
  return item.kind === 'motion-graphic' && Boolean(item.designDurationInFrames);
}
