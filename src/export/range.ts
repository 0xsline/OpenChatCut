/**
 * Convert the public half-open range [startFrame, endFrameExclusive) to
 * Remotion's inclusive frameRange. A full-range export omits frameRange.
 */
export function normalizeFrameRange(
  durationInFrames: number,
  startFrame?: number,
  endFrameExclusive?: number,
): [number, number] | undefined {
  if (!Number.isInteger(durationInFrames) || durationInFrames < 1) {
    throw new RangeError('durationInFrames must be a positive integer');
  }
  const start = startFrame ?? 0;
  const end = endFrameExclusive ?? durationInFrames;
  if (!Number.isInteger(start) || !Number.isInteger(end)) {
    throw new RangeError('frame range boundaries must be integers');
  }
  if (start < 0 || end <= start || end > durationInFrames) {
    throw new RangeError(`frame range must satisfy 0 <= startFrame < endFrameExclusive <= ${durationInFrames}`);
  }
  return start === 0 && end === durationInFrames ? undefined : [start, end - 1];
}
