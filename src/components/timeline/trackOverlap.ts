export interface TimelineClipSpan {
  startFrame: number;
  durationInFrames: number;
}

export interface TimelineOverlapSpan {
  startFrame: number;
  endFrame: number;
}

/** Merge the portions of the top clip covered by clips painted before it. */
export function topClipOverlapSpans(
  topStartFrame: number,
  topDurationInFrames: number,
  coveredClips: readonly TimelineClipSpan[],
): TimelineOverlapSpan[] {
  const topEndFrame = topStartFrame + Math.max(1, topDurationInFrames);
  const intersections = coveredClips
    .map((clip) => ({
      startFrame: Math.max(topStartFrame, clip.startFrame),
      endFrame: Math.min(topEndFrame, clip.startFrame + Math.max(1, clip.durationInFrames)),
    }))
    .filter((span) => span.startFrame < span.endFrame)
    .sort((a, b) => a.startFrame - b.startFrame || a.endFrame - b.endFrame);

  const merged: TimelineOverlapSpan[] = [];
  for (const span of intersections) {
    const previous = merged[merged.length - 1];
    if (!previous || span.startFrame > previous.endFrame) {
      merged.push({ ...span });
      continue;
    }
    previous.endFrame = Math.max(previous.endFrame, span.endFrame);
  }
  return merged;
}
