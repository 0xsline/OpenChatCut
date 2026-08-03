/** Stable representative frame for a static motion-graphic thumbnail. */
export function motionGraphicPreviewFrame(durationInFrames: number): number {
  return Math.floor(Math.max(1, durationInFrames || 1) / 2);
}
