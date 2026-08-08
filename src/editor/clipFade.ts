import { sampleKeyframes } from './keyframes';
import type { TimelineItem } from './types';

/** Fade multiplier at a Sequence-relative frame. */
export function clipFadeFactor(
  frame: number,
  durationInFrames: number,
  fadeInFrames = 0,
  fadeOutFrames = 0,
): number {
  let factor = 1;
  if (fadeInFrames > 0) factor = Math.min(factor, frame / fadeInFrames);
  if (fadeOutFrames > 0) factor = Math.min(factor, (durationInFrames - frame) / fadeOutFrames);
  return Math.max(0, Math.min(1, factor));
}

/** Visual opacity shared by the foreground and any full-canvas companion layer. */
export function clipOpacityAt(item: TimelineItem, frame: number, hidden = false): number {
  const opacityKeyframes = item.keyframes?.opacity;
  const opacity = opacityKeyframes?.length
    ? sampleKeyframes(opacityKeyframes, frame)
    : item.transform?.opacity ?? 1;
  const visibleOpacity = hidden ? 0 : Math.max(0, Math.min(1, opacity));
  return clipFadeFactor(frame, item.durationInFrames, item.fadeInFrames, item.fadeOutFrames) * visibleOpacity;
}
