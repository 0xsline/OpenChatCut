export interface TimelineSeekGeometry {
  contentLeft: number;
  headerWidth: number;
  pixelsPerFrame: number;
  totalFrames: number;
}

/** Map a client coordinate to a real frame, excluding headers and empty tail space. */
export function timelineSeekFrameAtClientX(
  clientX: number,
  geometry: TimelineSeekGeometry,
): number | null {
  const { contentLeft, headerWidth, pixelsPerFrame, totalFrames } = geometry;
  if (totalFrames <= 0 || pixelsPerFrame <= 0) return null;
  const timelineX = clientX - contentLeft - headerWidth;
  if (timelineX < 0 || timelineX >= totalFrames * pixelsPerFrame) return null;
  return Math.min(totalFrames - 1, Math.max(0, Math.round(timelineX / pixelsPerFrame)));
}

export const TIMELINE_CLICK_SLOP_PX = 4;

export function timelineGestureHasDragged(
  startX: number,
  startY: number,
  clientX: number,
  clientY: number,
): boolean {
  return Math.max(Math.abs(clientX - startX), Math.abs(clientY - startY)) >= TIMELINE_CLICK_SLOP_PX;
}

export function timelinePointerShouldSeek(
  button: number,
  referencePickMode: boolean,
  hasDragged: boolean,
): boolean {
  return button === 0 && !referencePickMode && !hasDragged;
}
