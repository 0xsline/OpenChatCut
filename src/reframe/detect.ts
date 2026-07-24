// Automatic reframe detection core.
// Custom Design: Previously there was only "write/render" for reframe curves
// Infrastructure (builtin:zoom + reserved __openchatcutReframeCurve = ReframeCurveV1), and no
// Automatic detection tool that "samples video → detects subject → generates reframe keyframes". Heuristic detection of this document
// (Per-frame contrast/variance energy → salient area centroid) is a custom lightweight MVP with zero-heavy dependencies
// (Do not reference MediaPipe / TF.js / any npm package).
//
// Pure/browser division of labor:
//   Pure (no DOM, headless single test possible): focalFromEnergyGrid / magnificationForAspect /
//     energyGridFromImageData (accepts structured pixels, does not rely on window).
//   Browser only: detectFocalPoints will seek + draw when source is HTMLVideoElement
//     Get pixels from off-screen canvas (experimental FaceDetector can be used), this part can only be run in the browser.
//
// Coordinate convention (aligned with editor/types.ts ReframeKeyframe + zoom.ts reframeAt):
//   focalPointX/Y ∈ 0..1 composition-normalized (0=left/top, 1=right/bottom), the rendering end mapping is
//   transformOrigin `${x*100}% ${y*100}%`;magnification ∈ 0.05..16。

const clamp01 = (x: number): number => Math.max(0, Math.min(1, x));
const clampMag = (x: number): number => Math.max(0.05, Math.min(16, x));

// ——Default constant (no magic number scattering)——
const DEFAULT_INTERVAL = 15; // Acquire every 15 frames (~0.5s @30fps)
const DEFAULT_GRID_COLS = 16;
const DEFAULT_GRID_ROWS = 9;
const DEFAULT_MAX_SAMPLES = 60; // seek upper sampling limit to prevent long films from getting stuck (raise it slightly to follow the long-term broadcast)
const DEFAULT_SENSITIVITY = 0.5; // 0..1, the higher the focus, the closer it is to the strongest energy area
const DEFAULT_SMOOTH = 0.45; // EMA smoothing coefficient 0=not smooth, 1=extremely sticky
const SAMPLE_CANVAS_W = 96; // Small size sampling canvas (sufficient energy, fast speed)
const SAMPLE_CANVAS_H = 54;

/** structured pixels(HTMLImageData the smallest subset of;use number[] Convenient headless Create test data) */
export interface ImageDataLike {
  data: Uint8ClampedArray | number[];
  width: number;
  height: number;
}

/** Test results:one piece reframe keyframe(Field/The value range strictly matches ReframeKeyframe) */
export interface DetectedKeyframe {
  /** effect-local frame(clip The starting point is 0) */
  frame: number;
  /** 0..1 composition-normalized */
  focalPointX: number;
  focalPointY: number;
  /** 0.05..16 */
  magnification: number;
}

/** Externally injected sampler:give effect-local frame,Returns the pixels of this frame(No rules null)。headless Can be implemented falsely. */
export type FrameSampler = (frameLocal: number) => Promise<ImageDataLike | null>;

export interface DetectOptions {
  /** clip length(effect-local frame) */
  durationInFrames: number;
  /** Timeline frame rate(seek use) */
  fps: number;
  /** Target canvas aspect ratio = width/height(decide magnification) */
  dstAspect: number;
  /** source entry point(frame):seek time = (srcInFrame + f)/fps */
  srcInFrame?: number;
  intervalFrames?: number;
  gridCols?: number;
  gridRows?: number;
  sensitivity?: number;
  /** Source screen width and height(FrameSampler The path must be given;video The path is taken by default videoWidth/Height) */
  srcWidth?: number;
  srcHeight?: number;
  maxSamples?: number;
  /**
   * Temporal EMA smoothing of focal points (0..1). Higher = stickier crop
   * (less jitter when subject energy flickers). Default 0.45; 0 disables.
   */
  smooth?: number;
}

// ===================== Pure function (no DOM, headless single test) =====================

/**
 * energy grid → energy weighted center of mass,Return 0..1 Normalized focus.
 * cell Get its center coordinates ((c+0.5)/cols, (r+0.5)/rows);negative energy button 0 plan;
 * empty grid / All zeros → center of screen (0.5,0.5)。scale-invariant(Overall scaling does not affect results)。
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
 * put srcW×srcH of the screen fills the target aspect ratio dstAspect(=dstW/dstH)required zoom Multiples.
 * = cover/contain Compare = max(srcA/dstA, dstA/srcA). Example:16:9→9:16 ≈ 3.16;16:9→16:9 = 1。
 * clamp Arrive magnification legal domain 0.05..16. illegal entry → 1(No scaling)。
 */
export function magnificationForAspect(srcW: number, srcH: number, dstAspect: number): number {
  if (!(srcW > 0) || !(srcH > 0) || !(dstAspect > 0)) return 1;
  const srcA = srcW / srcH;
  const ratio = srcA / dstAspect;
  const fill = ratio >= 1 ? ratio : 1 / ratio;
  return clampMag(fill);
}

/**
 * frame-by-frame brightness variance = Contrast/edge energy(salience proxy)。DOM-free:Read only structured pixels.
 * The greater the variance = Details/The more edges ≈ The more likely it is that the subject is located.
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

/** sensitivity(0..1)sharpen:unified to 0..1 Exponentiate again,Let the focus be closer to the strongest energy area. */
function emphasize(grid: number[][], sensitivity: number): number[][] {
  let max = 0;
  for (const row of grid) for (const e of row) if (e > max) max = e;
  if (max <= 0) return grid;
  const p = 1 + 2 * clamp01(sensitivity);
  return grid.map((row) => row.map((e) => Math.pow(Math.max(0, e) / max, p)));
}

/** sample frame sequence:0..dur-1,step size interval,Including the beginning and the end,monotonically increasing,receive maxSamples constraints. */
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

// ===================== Browser: Sampling + Detection =====================

/** One frame capture result:Pixel + Optional FaceDetector focus(If you have a face, use your face first) */
type Capture = (frameLocal: number) => Promise<{ img: ImageDataLike; faceFocal: { x: number; y: number } | null } | null>;

interface FaceBox {
  boundingBox: { x: number; y: number; width: number; height: number };
}
interface FaceDetectorLike {
  detect(source: CanvasImageSource): Promise<FaceBox[]>;
}

/** If the browser supports experimental FaceDetector then returns an instance,Otherwise null(Graceful downgrade) */
function makeFaceDetector(): FaceDetectorLike | null {
  const ctor = (globalThis as { FaceDetector?: new (o?: unknown) => FaceDetectorLike }).FaceDetector;
  if (typeof ctor !== 'function') return null;
  try {
    return new ctor({ fastMode: true, maxDetectedFaces: 1 });
  } catch {
    return null;
  }
}

/** from HTMLVideoElement Build a crawler:seek → Draw to small canvas → getImageData(+Optional face) */
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
      // Cross-origin tainted canvas cannot read pixels → the frame is skipped
      return null;
    }
    const faceFocal = faceDetector ? await detectFace(faceDetector, canvas) : null;
    return { img, faceFocal };
  };
}

/** seek to the specified seconds and wait 'seeked'(With timeout cover,Don't throw or hang) */
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
    setTimeout(finish, 500); // Don’t get stuck if you fail: seek
  });
}

/** use FaceDetector Take the center of the largest face(normalization);Shameless/Error → null */
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
 * Sample video → Detect focus every sample frame → generate a string reframe Keyframes.
 * source for HTMLVideoElement Time browser sampling(Need DOM);for FrameSampler Inject pixels
 * (Yes headless). Yes FaceDetector And detect the face → Use the center of the face,Otherwise use the energy center of mass.
 * Detection failed frame skipping;All failed → Return []。magnification Consistent throughout = Target aspect ratio fill multiple.
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
      cap = null; // Failure of a single frame does not affect the overall
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
