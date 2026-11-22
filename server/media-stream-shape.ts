// Stream-shape helpers for import normalization: frame-rate interpretation
// and keyframe sampling (sizes, GOP length). Pure functions, no ffmpeg calls.
import { GOP_SAMPLE_SECONDS, parseLongGop } from './preview-proxy.ts';

interface FrameRateInfo {
  readonly avgFrameRate?: number;
  readonly nominalFrameRate?: number;
}

export interface VideoSize {
  readonly width: number;
  readonly height: number;
}

export interface KeyframeSample {
  readonly best_effort_timestamp_time?: string;
  readonly width?: number;
  readonly height?: number;
}

export interface KeyframeSummary {
  /** Distinct displayed sizes in first-seen order. */
  readonly sizes: readonly VideoSize[];
  /** Largest displayed size by area; undefined when no frame had dimensions. */
  readonly largest?: VideoSize;
  readonly longGop: boolean;
}

/**
 * Summarize sampled keyframes. Resolution can only change on a keyframe
 * (VP8/VP9 frame headers, H.264/HEVC parameter sets), so a keyframe-only scan
 * sees every size change.
 */
export function summarizeKeyframes(
  frames: readonly KeyframeSample[],
  rotation: number,
  durationSeconds: number,
  wholeFile: boolean,
): KeyframeSummary {
  const sizes: VideoSize[] = [];
  let largest: VideoSize | undefined;
  let lastTime = 0;
  for (const frame of frames) {
    const time = Number(frame.best_effort_timestamp_time);
    if (Number.isFinite(time)) lastTime = Math.max(lastTime, time);
    const codedWidth = Number(frame.width) || 0;
    const codedHeight = Number(frame.height) || 0;
    if (codedWidth <= 0 || codedHeight <= 0) continue;
    const size = displayDimensions(codedWidth, codedHeight, rotation);
    if (!sizes.some((seen) => seen.width === size.width && seen.height === size.height)) sizes.push(size);
    if (!largest || size.width * size.height > largest.width * largest.height) largest = size;
  }
  // Live-muxed WebM may carry no duration; the last keyframe bounds it.
  const durationMs = Math.max(durationSeconds, lastTime) * 1000;
  return {
    sizes,
    largest,
    longGop: parseLongGop(frames, durationMs, wholeFile ? Infinity : GOP_SAMPLE_SECONDS),
  };
}

export function isMatroskaFamily(formatName: string): boolean {
  return /\b(matroska|webm)\b/.test(formatName);
}

export function parseFrameRate(value: unknown): number | undefined {
  if (typeof value === 'number') {
    return Number.isFinite(value) && value > 0 ? value : undefined;
  }
  const raw = String(value ?? '').trim();
  if (!raw || raw === 'N/A') return undefined;
  const [numeratorRaw, denominatorRaw] = raw.split('/');
  const numerator = Number(numeratorRaw);
  const denominator = denominatorRaw === undefined ? 1 : Number(denominatorRaw);
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) return undefined;
  const rate = numerator / denominator;
  return Number.isFinite(rate) && rate > 0 ? rate : undefined;
}

// Above any real capture rate (240 fps slow motion stays below the bar):
// ffprobe reports the container timebase as r_frame_rate when frame
// timestamps follow no regular cadence, e.g. 1000/1 for millisecond WebM.
const TIMEBASE_LIKE_FRAME_RATE = 240;
// Target rate when a source only exposes its timebase (browser recordings).
const TIMEBASE_SOURCE_TARGET_FPS = 30;

/**
 * Browser MediaRecorder WebM (Meet, Zoom web, Loom, ...) carries no frame
 * duration: ffprobe reports avg_frame_rate "0/0" and the millisecond timebase
 * ("1000/1") as r_frame_rate. Timestamps are really variable.
 */
export function isTimebaseLikeFrameRate(avgFrameRate?: number, nominalFrameRate?: number): boolean {
  return !avgFrameRate && nominalFrameRate !== undefined && nominalFrameRate > TIMEBASE_LIKE_FRAME_RATE;
}

export function isVariableFrameRate(avgFrameRate?: number, nominalFrameRate?: number): boolean {
  if (isTimebaseLikeFrameRate(avgFrameRate, nominalFrameRate)) return true;
  if (!avgFrameRate || !nominalFrameRate) return false;
  const reference = Math.max(avgFrameRate, nominalFrameRate);
  // A 0.05% relative tolerance ignores rational rounding noise while still
  // catching the common 30-tbr / drifting-average pattern from phone and
  // screen recordings.
  return Math.abs(avgFrameRate - nominalFrameRate) > Math.max(0.005, reference * 0.0005);
}

export function resolveTargetFps(
  requested: unknown,
  avgFrameRate?: number,
  nominalFrameRate?: number,
  allowRequested = false,
): number {
  const explicit = Number(requested);
  if (allowRequested && Number.isFinite(explicit) && explicit >= 1 && explicit <= 120) return explicit;
  if (isTimebaseLikeFrameRate(avgFrameRate, nominalFrameRate)) return TIMEBASE_SOURCE_TARGET_FPS;
  const detected = avgFrameRate ?? nominalFrameRate;
  if (detected && Number.isFinite(detected)) return Math.max(1, Math.min(120, detected));
  return 30;
}

/** Source frame rate worth reporting, or undefined when only the timebase is known. */
export function sourceFrameRate(meta: FrameRateInfo): number | undefined {
  if (isTimebaseLikeFrameRate(meta.avgFrameRate, meta.nominalFrameRate)) return undefined;
  return meta.avgFrameRate ?? meta.nominalFrameRate;
}

export function playableDurationSeconds(meta: FrameRateInfo & { duration: number; frameCount?: number }): number {
  const fps = sourceFrameRate(meta);
  if (meta.frameCount && fps && Number.isFinite(fps) && fps > 0) {
    return meta.frameCount / fps;
  }
  return meta.duration;
}
/** Displayed dimensions for a rotation-coded stream. ±90/270 swap the
 * coded width/height; 0/180 keep them. */
export function displayDimensions(codedWidth: number, codedHeight: number, rotation: number): { width: number; height: number } {
  const swapped = rotation === 90 || rotation === 270;
  return swapped
    ? { width: codedHeight, height: codedWidth }
    : { width: codedWidth, height: codedHeight };
}

export function rotationOf(video: Record<string, unknown>): number {
  const raw = Number(video.rotation);
  if (Number.isFinite(raw) && raw !== 0) return ((raw % 360) + 360) % 360;
  const tags = video.tags as Record<string, unknown> | undefined;
  const tag = Number(tags?.rotate);
  if (Number.isFinite(tag) && tag !== 0) return ((tag % 360) + 360) % 360;
  const sideData = video.side_data_list as Array<Record<string, unknown>> | undefined;
  for (const entry of sideData ?? []) {
    const rotation = Number(entry.rotation);
    if (Number.isFinite(rotation) && rotation !== 0) return ((rotation % 360) + 360) % 360;
  }
  return 0;
}
