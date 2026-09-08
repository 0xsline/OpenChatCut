import type { KeptSegment } from './edit';

/** Preserve first-match semantics for reordered/overlapping source segments. */
export function wordSegmentLookup(segments: readonly KeptSegment[]): (start: number, end: number) => KeptSegment | undefined {
  const ordered = segments.every((segment, index) =>
    Number.isFinite(segment.srcStartFrame) && Number.isFinite(segment.srcEndFrame)
    && segment.srcEndFrame >= segment.srcStartFrame
    && (index === 0 || segment.srcStartFrame >= segments[index - 1].srcEndFrame));
  if (!ordered) {
    // ponytail: unusual overlap/reorder keeps the linear first-match rule; index intervals if profiling justifies it.
    return (start, end) => segments.find((segment) => start >= segment.srcStartFrame && start < segment.srcEndFrame)
      ?? segments.find((segment) => start <= segment.srcEndFrame && end >= segment.srcStartFrame);
  }
  const firstEndingAfter = (start: number, inclusive: boolean) => {
    let lo = 0;
    let hi = segments.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      const end = segments[mid].srcEndFrame;
      if (inclusive ? end >= start : end > start) hi = mid;
      else lo = mid + 1;
    }
    return segments[lo];
  };
  return (start, end) => {
    const covering = firstEndingAfter(start, false);
    if (covering && start >= covering.srcStartFrame) return covering;
    const overlapping = firstEndingAfter(start, true);
    return overlapping && end >= overlapping.srcStartFrame ? overlapping : undefined;
  };
}
