import { sourceWindowForTimelineRange } from '../../editor/sourceLimit';
import { intersectFrameRange, type TimelineFrameWindow } from './timelineUtil';

export interface ClipMediaGeometry {
  leftPx: number;
  widthPx: number;
  durationInFrames: number;
  srcInFrame: number;
}

export function clipMediaGeometry(options: {
  clipStartFrame: number;
  durationInFrames: number;
  srcInFrame: number;
  playbackRate: number;
  px: number;
  visibleWindow: TimelineFrameWindow;
}): ClipMediaGeometry | null {
  const intersection = intersectFrameRange(
    options.clipStartFrame,
    options.durationInFrames,
    options.visibleWindow,
  );
  if (!intersection) return null;
  const offsetFrames = intersection.startFrame - options.clipStartFrame;
  return {
    leftPx: offsetFrames * options.px,
    widthPx: Math.max(1, (intersection.endFrame - intersection.startFrame) * options.px),
    durationInFrames: intersection.endFrame - intersection.startFrame,
    srcInFrame: sourceWindowForTimelineRange(
      options,
      offsetFrames,
      intersection.endFrame - intersection.startFrame,
    ).startFrame,
  };
}
