// Automatic reframe detection core.
// The existing infrastructure only wrote and rendered reframe curves through builtin:zoom and
// reserved __openchatcutReframeCurve = ReframeCurveV1. This module adds the missing
// sample video → detect subject → generate keyframes path. Its lightweight heuristic maps
// per-frame contrast/variance energy to a salient-region centroid without MediaPipe, TF.js, or other dependencies.
//
// Pure/browser split:
//   Pure and headless-testable: focalFromEnergyGrid, magnificationForAspect, and
//   energyGridFromImageData, which accepts structured pixels without relying on window.
//   Browser-only: detectFocalPoints seeks an HTMLVideoElement, draws it to an offscreen canvas,
//   and optionally uses the experimental FaceDetector API.
//
// Coordinate convention, aligned with editor/types.ts ReframeKeyframe and zoom.ts reframeAt:
// focalPointX/Y are composition-normalized to 0..1 (left/top to right/bottom) and render as
// transformOrigin `${x*100}% ${y*100}%`; magnification is constrained to 0.05..16.

const clamp01 = (x: number): number => Math.max(0, Math.min(1, x));
const clampMag = (x: number): number => Math.max(0.05, Math.min(16, x));

// Default constants.
const DEFAULT_INTERVAL = 15; // Sample every 15 frames, about 0.5 seconds at 30 fps.
const DEFAULT_GRID_COLS = 16;
const DEFAULT_GRID_ROWS = 9;
const DEFAULT_MAX_SAMPLES = 60; // Bound seeks while allowing longer talking-head footage.
const DEFAULT_SENSITIVITY = 0.5; // 0..1; higher values pull focus toward the strongest energy region.
const DEFAULT_SMOOTH = 0.45; // EMA smoothing: 0 disables smoothing and 1 is maximally sticky.
const SAMPLE_CANVAS_W = 96; // Small samples retain enough energy detail while remaining fast.
const SAMPLE_CANVAS_H = 54;

/** Minimal HTMLImageData-compatible shape; number[] keeps headless fixtures simple. */
export interface ImageDataLike {
  data: Uint8ClampedArray | number[];
  width: number;
  height: number;
}

/** Detected reframe keyframe whose fields and ranges match ReframeKeyframe. */
export interface DetectedKeyframe {
  /** Effect-local frame, where the clip starts at 0. */
  frame: number;
  /** 0..1 composition-normalized */
  focalPointX: number;
  focalPointY: number;
  /** 0.05..16 */
  magnification: number;
}

/** Injected sampler that returns pixels for an effect-local frame, or null; tests may supply a synthetic implementation. */
export type FrameSampler = (frameLocal: number) => Promise<ImageDataLike | null>;

export interface DetectOptions {
  /** Clip length in effect-local frames. */
  durationInFrames: number;
  /** Timeline frame rate used for seeking. */
  fps: number;
  /** Target canvas aspect ratio, width/height, used to calculate magnification. */
  dstAspect: number;
  /** Source in-point in frames; seek time is (srcInFrame + f) / fps. */
  srcInFrame?: number;
  intervalFrames?: number;
  gridCols?: number;
  gridRows?: number;
  sensitivity?: number;
  /** Source dimensions; required for FrameSampler and inferred from videoWidth/videoHeight for video. */
  srcWidth?: number;
  srcHeight?: number;
  maxSamples?: number;
  /**
   * Temporal EMA smoothing of focal points (0..1). Higher = stickier crop
   * (less jitter when subject energy flickers). Default 0.45; 0 disables.
   */
  smooth?: number;
}

// ===================== Pure functions (DOM-free and headless-testable) =====================

/**
 * Convert an energy grid to an energy-weighted centroid normalized to 0..1.
 * Each cell uses its center coordinate ((c+0.5)/cols, (r+0.5)/rows), and negative energy is clamped to 0.
 * Empty or all-zero grids return (0.5, 0.5). Uniformly scaling all values does not change the result.
 */
export function focalFromEnergyGrid(grid: number[][]): { x: number; y: number } {
  const rows = grid.length;
  const cols = rows > 0 ? grid[0].length : 0;
  if (rows === 0 || cols === 0) return { x: 0.5, y: 0.5 };
  let sum = 0;
  let sx = 0;
  let sy = 0;
  for (let r = 0; r < rows; r++) {
    const row = grid[r];
    for (let c = 0; c < cols; c++) {
      const e = row[c] > 0 && Number.isFinite(row[c]) ? row[c] : 0;
      if (e === 0) continue;
      sx += e * ((c + 0.5) / cols);
      sy += e * ((r + 0.5) / rows);
      sum += e;
    }
  }
  if (sum <= 0) return { x: 0.5, y: 0.5 };
  return { x: clamp01(sx / sum), y: clamp01(sy / sum) };
}

/**
 * Calculate the zoom required to fill dstAspect (= dstW/dstH) with a srcW×srcH frame.
 * The cover/contain ratio is max(srcA/dstA, dstA/srcA); for example, 16:9→9:16 ≈ 3.16.
 * Clamp to the valid 0.05..16 range and return 1 for invalid input.
 */
export function magnificationForAspect(srcW: number, srcH: number, dstAspect: number): number {
  if (!(srcW > 0) || !(srcH > 0) || !(dstAspect > 0)) return 1;
  const srcA = srcW / srcH;
  const ratio = srcA / dstAspect;
  const fill = ratio >= 1 ? ratio : 1 / ratio;
  return clampMag(fill);
}

/**
 * Estimate saliency from per-cell luminance variance, a proxy for contrast and edge energy.
 * Higher variance suggests more detail and a greater likelihood of containing the subject.
 */
export function energyGridFromImageData(img: ImageDataLike, cols: number, rows: number): number[][] {
  const { data, width, height } = img;
  const grid: number[][] = [];
  for (let r = 0; r < rows; r++) {
    const row: number[] = [];
    const y0 = Math.floor((r * height) / rows);
    const y1 = Math.max(y0 + 1, Math.floor(((r + 1) * height) / rows));
    for (let c = 0; c < cols; c++) {
      const x0 = Math.floor((c * width) / cols);
      const x1 = Math.max(x0 + 1, Math.floor(((c + 1) * width) / cols));
      let sum = 0;
      let sq = 0;
      let n = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const i = (y * width + x) * 4;
          const lum = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
          sum += lum;
          sq += lum * lum;
          n++;
        }
      }
      const mean = n ? sum / n : 0;
      row.push(n ? Math.max(0, sq / n - mean * mean) : 0);
    }
    grid.push(row);
  }
  return grid;
}

/** Normalize and exponentiate by sensitivity so higher values favor the strongest energy region. */
function emphasize(grid: number[][], sensitivity: number): number[][] {
  let max = 0;
  for (const row of grid) for (const e of row) if (e > max) max = e;
  if (max <= 0) return grid;
  const p = 1 + 2 * clamp01(sensitivity);
  return grid.map((row) => row.map((e) => Math.pow(Math.max(0, e) / max, p)));
}

/** Build a monotonic frame sequence from 0 to dur-1, including both ends and respecting maxSamples. */
export function sampleFrames(durationInFrames: number, interval: number, maxSamples: number): number[] {
  const last = Math.max(0, Math.floor(durationInFrames) - 1);
  if (durationInFrames <= 0) return [];
  let step = Math.max(1, Math.floor(interval));
  const count = Math.floor(last / step) + 1;
  if (count > maxSamples && maxSamples > 1) step = Math.max(1, Math.ceil(last / (maxSamples - 1)));
  const frames: number[] = [];
  for (let f = 0; f <= last; f += step) frames.push(f);
  if (frames.length === 0 || frames[frames.length - 1] !== last) frames.push(last);
  return frames;
}

// ===================== Browser sampling and detection =====================

/** Captured frame pixels and an optional FaceDetector focal point, which takes precedence when present. */
type Capture = (frameLocal: number) => Promise<{ img: ImageDataLike; faceFocal: { x: number; y: number } | null } | null>;

interface FaceBox {
  boundingBox: { x: number; y: number; width: number; height: number };
}
interface FaceDetectorLike {
  detect(source: CanvasImageSource): Promise<FaceBox[]>;
}

/** Create the experimental FaceDetector when supported, otherwise degrade gracefully to null. */
function makeFaceDetector(): FaceDetectorLike | null {
  const ctor = (globalThis as { FaceDetector?: new (o?: unknown) => FaceDetectorLike }).FaceDetector;
  if (typeof ctor !== 'function') return null;
  try {
    return new ctor({ fastMode: true, maxDetectedFaces: 1 });
  } catch {
    return null;
  }
}

/** Build an HTMLVideoElement capture path: seek → draw to a small canvas → read pixels and optionally detect a face. */
function buildVideoCapture(video: HTMLVideoElement, opts: DetectOptions): Capture {
  if (typeof document === 'undefined') throw new Error('auto reframe: no DOM (video sampling is browser-only)');
  const canvas = document.createElement('canvas');
  canvas.width = SAMPLE_CANVAS_W;
  canvas.height = SAMPLE_CANVAS_H;
  const c2d = canvas.getContext('2d', { willReadFrequently: true });
  if (!c2d) throw new Error('auto reframe: 2d canvas context unavailable');
  const faceDetector = makeFaceDetector();
  const srcInFrame = opts.srcInFrame ?? 0;

  return async (frameLocal) => {
    const timeSec = (srcInFrame + frameLocal) / Math.max(1, opts.fps);
    await seekVideo(video, timeSec);
    c2d.drawImage(video, 0, 0, canvas.width, canvas.height);
    let img: ImageDataLike;
    try {
      img = c2d.getImageData(0, 0, canvas.width, canvas.height);
    } catch {
      // Cross-origin-tainted canvases cannot expose pixels, so skip this frame.
      return null;
    }
    const faceFocal = faceDetector ? await detectFace(faceDetector, canvas) : null;
    return { img, faceFocal };
  };
}

/** Seek to a timestamp and wait for seeked, with a timeout that neither throws nor hangs. */
function seekVideo(video: HTMLVideoElement, timeSec: number): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      video.removeEventListener('seeked', finish);
      resolve();
    };
    video.addEventListener('seeked', finish, { once: true });
    try {
      video.currentTime = Math.max(0, timeSec);
    } catch {
      finish();
    }
    setTimeout(finish, 500); // Keep a failed seek from blocking detection.
  });
}

/** Return the normalized center of the largest detected face, or null when absent or on error. */
async function detectFace(detector: FaceDetectorLike, canvas: HTMLCanvasElement): Promise<{ x: number; y: number } | null> {
  try {
    const faces = await detector.detect(canvas);
    if (!faces.length) return null;
    const biggest = faces.reduce((a, b) => (a.boundingBox.width * a.boundingBox.height >= b.boundingBox.width * b.boundingBox.height ? a : b));
    const b = biggest.boundingBox;
    return { x: clamp01((b.x + b.width / 2) / canvas.width), y: clamp01((b.y + b.height / 2) / canvas.height) };
  } catch {
    return null;
  }
}

/**
 * Sample video → detect focus per sampled frame → generate reframe keyframes.
 * HTMLVideoElement uses the browser path, while FrameSampler injects pixels for headless use.
 * Prefer a detected face center and fall back to the energy centroid. Skip failed frames and return []
 * when all fail. Magnification remains constant at the target-aspect fill ratio.
 */
export async function detectFocalPoints(source: HTMLVideoElement | FrameSampler, opts: DetectOptions): Promise<DetectedKeyframe[]> {
  if (!opts || !(opts.durationInFrames > 0)) return [];
  const cols = Math.max(2, Math.floor(opts.gridCols ?? DEFAULT_GRID_COLS));
  const rows = Math.max(2, Math.floor(opts.gridRows ?? DEFAULT_GRID_ROWS));
  const sensitivity = clamp01(opts.sensitivity ?? DEFAULT_SENSITIVITY);
  const interval = Math.max(1, Math.floor(opts.intervalFrames ?? DEFAULT_INTERVAL));
  const maxSamples = Math.max(1, Math.floor(opts.maxSamples ?? DEFAULT_MAX_SAMPLES));

  const isVideo = typeof HTMLVideoElement !== 'undefined' && source instanceof HTMLVideoElement;
  const srcW = opts.srcWidth ?? (isVideo ? (source as HTMLVideoElement).videoWidth : 0) ?? 0;
  const srcH = opts.srcHeight ?? (isVideo ? (source as HTMLVideoElement).videoHeight : 0) ?? 0;
  const magnification = magnificationForAspect(srcW, srcH, opts.dstAspect);

  const capture: Capture = isVideo
    ? buildVideoCapture(source as HTMLVideoElement, opts)
    : async (f) => {
        const img = await (source as FrameSampler)(f);
        return img ? { img, faceFocal: null } : null;
      };

  const frames = sampleFrames(opts.durationInFrames, interval, maxSamples);
  const smooth = clamp01(opts.smooth ?? DEFAULT_SMOOTH);
  const out: DetectedKeyframe[] = [];
  let prevX: number | null = null;
  let prevY: number | null = null;
  for (const frame of frames) {
    let cap: Awaited<ReturnType<Capture>> = null;
    try {
      cap = await capture(frame);
    } catch {
      cap = null; // A single failed frame does not invalidate the full detection run.
    }
    if (!cap) continue;
    const raw = cap.faceFocal ?? focalFromEnergyGrid(emphasize(energyGridFromImageData(cap.img, cols, rows), sensitivity));
    // Face hits snap harder (less EMA) so talking-head reframe stays locked.
    const alpha = cap.faceFocal ? Math.min(smooth, 0.25) : smooth;
    let x = clamp01(raw.x);
    let y = clamp01(raw.y);
    if (prevX != null && prevY != null && alpha > 0) {
      x = clamp01(prevX * alpha + x * (1 - alpha));
      y = clamp01(prevY * alpha + y * (1 - alpha));
    }
    prevX = x;
    prevY = y;
    out.push({ frame, focalPointX: x, focalPointY: y, magnification });
  }
  // Always ensure a keyframe at 0 when we have samples (crop start stable).
  if (out.length && out[0].frame !== 0) {
    out.unshift({ ...out[0], frame: 0 });
  }
  return out;
}

/** Pure temporal EMA helper (exported for headless checks). */
export function smoothFocalPath(
  points: Array<{ x: number; y: number }>,
  smooth: number,
): Array<{ x: number; y: number }> {
  const a = clamp01(smooth);
  if (a <= 0 || points.length === 0) return points.map((p) => ({ x: clamp01(p.x), y: clamp01(p.y) }));
  const out: Array<{ x: number; y: number }> = [];
  let px = clamp01(points[0].x);
  let py = clamp01(points[0].y);
  out.push({ x: px, y: py });
  for (let i = 1; i < points.length; i++) {
    px = clamp01(px * a + clamp01(points[i].x) * (1 - a));
    py = clamp01(py * a + clamp01(points[i].y) * (1 - a));
    out.push({ x: px, y: py });
  }
  return out;
}
