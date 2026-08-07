/**
 * Geometry-driven reframe focus: derive per-frame focal points from the
 * visual-geometry cache (segment subject/face centers) instead of energy-grid
 * sampling. Faster than pixel sampling and more accurate on complex
 * backgrounds; falls back to the caller's heuristic when geometry is absent.
 */

import { sourceFrameAt, type SourceTimingItem } from '../editor/sourceLimit';
import {
  DEFAULT_REFRAME_INTERVAL_FRAMES,
  DEFAULT_REFRAME_MAX_SAMPLES,
  DEFAULT_REFRAME_SMOOTH,
  sampleFrames,
  smoothFocalPath,
  type DetectedKeyframe,
} from './detect';
import type { VisualGeometryAsset } from '../geometry/visual-geometry';

export interface GeometryFocusOptions {
  /** Item-local timeline frame at which reframing starts. */
  srcInFrame?: number;
  playbackRate?: number;
  /** Sample every N frames (default 15 ≈ 0.5s at 30fps). */
  intervalFrames?: number;
  /** Hard cap for long clips. */
  maxSamples?: number;
  /** Temporal EMA on focal points (0 = raw, 1 = maximally sticky). */
  smooth?: number;
  /** Aspect-derived crop magnification applied to every keyframe. */
  magnification?: number;
}

const clamp01 = (x: number): number => Math.max(0, Math.min(1, x));

/** Subject center of one geometry segment, or face center, or frame center. */
function focalOf(geometry: VisualGeometryAsset, sourceSec: number): { x: number; y: number } {
  let best: VisualGeometryAsset['segments'][number] | null = null;
  for (const segment of geometry.segments) {
    // Left-closed, right-open (with left tolerance): a boundary time belongs to
    // the segment that starts there, never to both.
    if (sourceSec >= segment.startSec - 0.01 && sourceSec < segment.endSec) {
      best = segment;
      break;
    }
  }
  // Tail of the last segment (sourceSec == last endSec) belongs to it.
  if (!best && geometry.segments.length) {
    const lastSegment = geometry.segments[geometry.segments.length - 1]!;
    if (sourceSec >= lastSegment.endSec) best = lastSegment;
  }
  if (!best) return { x: 0.5, y: 0.5 };
  if (best.zone.subject) {
    return {
      x: clamp01(best.zone.subject.x + best.zone.subject.w / 2),
      y: clamp01(best.zone.subject.y + best.zone.subject.h / 2),
    };
  }
  if (best.zone.face) {
    return {
      x: clamp01(best.zone.face.x + best.zone.face.w / 2),
      y: clamp01(best.zone.face.y + best.zone.face.h / 2),
    };
  }
  return { x: 0.5, y: 0.5 };
}

/**
 * Build reframe keyframes from segment geometry. Each sampled timeline frame
 * maps to its source time (srcInFrame + playbackRate), picks the enclosing
 * segment, and uses the subject (or face) center as the focal point.
 * Magnification is left to the caller (aspect-driven), matching detect.ts.
 */
export function focalFramesFromGeometry(
  geometry: VisualGeometryAsset,
  durationInFrames: number,
  fps: number,
  options: GeometryFocusOptions = {},
): DetectedKeyframe[] {
  const interval = Math.max(1, Math.floor(options.intervalFrames ?? DEFAULT_REFRAME_INTERVAL_FRAMES));
  const maxSamples = Math.max(1, Math.floor(options.maxSamples ?? DEFAULT_REFRAME_MAX_SAMPLES));
  const frames = sampleFrames(durationInFrames, interval, maxSamples);
  if (!frames.length) return [];
  const item: SourceTimingItem = {
    srcInFrame: options.srcInFrame ?? 0,
    playbackRate: options.playbackRate ?? 1,
  };
  const raw = frames.map((frame) => {
    const sourceFrame = sourceFrameAt(item, frame);
    return focalOf(geometry, fps > 0 ? sourceFrame / fps : 0);
  });
  const points = smoothFocalPath(raw, options.smooth ?? DEFAULT_REFRAME_SMOOTH);
  const magnification = Math.max(0.05, Math.min(16, options.magnification ?? 1));
  return frames.map((frame, index) => ({
    frame,
    focalPointX: points[index]!.x,
    focalPointY: points[index]!.y,
    magnification,
  }));
}
