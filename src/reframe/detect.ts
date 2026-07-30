// 自动 reframe 检测核心。
// 自定设计:此前只有 reframe 曲线的“写入/渲染”
// 基础设施(builtin:zoom + reserved __openchatcutReframeCurve = ReframeCurveV1),并没有
// “采样视频 → 检测主体 → 生成 reframe 关键帧”的自动检测工具。本文件的启发式检测
// (逐格对比度/方差能量 → 显著区域质心)是自定的轻量 MVP,零重依赖
// (不引 MediaPipe / TF.js / 任何 npm 包)。
//
// 纯 / 浏览器分工:
//   纯(无 DOM,可 headless 单测):focalFromEnergyGrid / magnificationForAspect /
//     energyGridFromImageData(接受结构化像素,不依赖 window)。
//   仅浏览器:detectFocalPoints 在 source 为 HTMLVideoElement 时会 seek + 画到
//     离屏 canvas 取像素(可选用实验性 FaceDetector),这部分只能在浏览器跑。
//
// 坐标约定(与 editor/types.ts ReframeKeyframe + zoom.ts reframeAt 对齐):
//   focalPointX/Y ∈ 0..1 composition-normalized(0=左/上,1=右/下),渲染端映射为
//   transformOrigin `${x*100}% ${y*100}%`;magnification ∈ 0.05..16。

const clamp01 = (x: number): number => Math.max(0, Math.min(1, x));
const clampMag = (x: number): number => Math.max(0.05, Math.min(16, x));

// —— 默认常量(无魔数散落) ——
const DEFAULT_INTERVAL = 15; // 每 15 帧采一次(~0.5s @30fps)
const DEFAULT_GRID_COLS = 16;
const DEFAULT_GRID_ROWS = 9;
const DEFAULT_MAX_SAMPLES = 60; // seek 采样上限,防止长片卡死（略抬以跟长口播）
const DEFAULT_SENSITIVITY = 0.5; // 0..1,越高焦点越贴最强能量区
const DEFAULT_SMOOTH = 0.45; // EMA 平滑系数 0=不平滑,1=极粘
const SAMPLE_CANVAS_W = 96; // 小尺寸采样画布(能量足够,速度快)
const SAMPLE_CANVAS_H = 54;

/** 结构化像素(HTMLImageData 的最小子集;用 number[] 便于 headless 造测试数据) */
export interface ImageDataLike {
  data: Uint8ClampedArray | number[];
  width: number;
  height: number;
}

/** 检测结果:一条 reframe 关键帧(字段/取值域严格匹配 ReframeKeyframe) */
export interface DetectedKeyframe {
  /** effect-local 帧(clip 起点为 0) */
  frame: number;
  /** 0..1 composition-normalized */
  focalPointX: number;
  focalPointY: number;
  /** 0.05..16 */
  magnification: number;
}

/** 外部注入的采样器:给 effect-local 帧,返回该帧像素(无则 null)。headless 可用假实现。 */
export type FrameSampler = (frameLocal: number) => Promise<ImageDataLike | null>;

export interface DetectOptions {
  /** clip 长度(effect-local 帧) */
  durationInFrames: number;
  /** 时间线帧率(seek 用) */
  fps: number;
  /** 目标画布宽高比 = width/height(决定 magnification) */
  dstAspect: number;
  /** 源入点(帧):seek 时间 = (srcInFrame + f)/fps */
  srcInFrame?: number;
  intervalFrames?: number;
  gridCols?: number;
  gridRows?: number;
  sensitivity?: number;
  /** 源画面宽高(FrameSampler 路径必须给;video 路径默认取 videoWidth/Height) */
  srcWidth?: number;
  srcHeight?: number;
  maxSamples?: number;
  /**
   * Temporal EMA smoothing of focal points (0..1). Higher = stickier crop
   * (less jitter when subject energy flickers). Default 0.45; 0 disables.
   */
  smooth?: number;
}

// ===================== 纯函数(无 DOM,headless 单测) =====================

/**
 * 能量网格 → 能量加权质心,返回 0..1 归一化焦点。
 * cell 取其中心坐标 ((c+0.5)/cols, (r+0.5)/rows);负能量按 0 计;
 * 空网格 / 全零 → 画面中心 (0.5,0.5)。scale-invariant(整体缩放不影响结果)。
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
 * 把 srcW×srcH 的画面填满目标宽高比 dstAspect(=dstW/dstH)所需的 zoom 倍数。
 * = cover/contain 比 = max(srcA/dstA, dstA/srcA)。例:16:9→9:16 ≈ 3.16;16:9→16:9 = 1。
 * clamp 到 magnification 合法域 0.05..16。非法入参 → 1(不缩放)。
 */
export function magnificationForAspect(srcW: number, srcH: number, dstAspect: number): number {
  if (!(srcW > 0) || !(srcH > 0) || !(dstAspect > 0)) return 1;
  const srcA = srcW / srcH;
  const ratio = srcA / dstAspect;
  const fill = ratio >= 1 ? ratio : 1 / ratio;
  return clampMag(fill);
}

/**
 * 逐格亮度方差 = 对比度/边缘能量(显著度代理)。DOM-free:只读结构化像素。
 * 方差越大 = 细节/边缘越多 ≈ 越可能是主体所在。
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

/** sensitivity(0..1)锐化:归一到 0..1 再取幂,让焦点更贴最强能量区。 */
function emphasize(grid: number[][], sensitivity: number): number[][] {
  let max = 0;
  for (const row of grid) for (const e of row) if (e > max) max = e;
  if (max <= 0) return grid;
  const p = 1 + 2 * clamp01(sensitivity);
  return grid.map((row) => row.map((e) => Math.pow(Math.max(0, e) / max, p)));
}

/** 采样帧序列:0..dur-1,步长 interval,含首尾,单调递增,受 maxSamples 约束。 */
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

// ===================== 浏览器:采样 + 检测 =====================

/** 一帧的抓取结果:像素 + 可选的 FaceDetector 焦点(有脸则优先用脸) */
type Capture = (frameLocal: number) => Promise<{ img: ImageDataLike; faceFocal: { x: number; y: number } | null } | null>;

interface FaceBox {
  boundingBox: { x: number; y: number; width: number; height: number };
}
interface FaceDetectorLike {
  detect(source: CanvasImageSource): Promise<FaceBox[]>;
}

/** 若浏览器支持实验性 FaceDetector 则返回一个实例,否则 null(优雅降级) */
function makeFaceDetector(): FaceDetectorLike | null {
  const ctor = (globalThis as { FaceDetector?: new (o?: unknown) => FaceDetectorLike }).FaceDetector;
  if (typeof ctor !== 'function') return null;
  try {
    return new ctor({ fastMode: true, maxDetectedFaces: 1 });
  } catch {
    return null;
  }
}

/** 从 HTMLVideoElement 建抓取器:seek → 画到小 canvas → getImageData(+可选人脸) */
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
      // 跨源污染的 canvas 无法读像素 → 该帧跳过
      return null;
    }
    const faceFocal = faceDetector ? await detectFace(faceDetector, canvas) : null;
    return { img, faceFocal };
  };
}

/** seek 到指定秒并等待 'seeked'(带超时兜底,不抛不挂) */
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
    setTimeout(finish, 500); // 兜底:seek 失败也别卡住
  });
}

/** 用 FaceDetector 取最大人脸的中心(归一化);无脸/出错 → null */
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
 * 采样视频 → 每个采样帧检测焦点 → 生成一串 reframe 关键帧。
 * source 为 HTMLVideoElement 时走浏览器采样(需 DOM);为 FrameSampler 时用注入像素
 * (可 headless)。有 FaceDetector 且检到脸 → 用脸中心,否则用能量质心。
 * 检测失败的帧跳过;全部失败 → 返回 []。magnification 全程一致 = 目标宽高比填充倍数。
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
      cap = null; // 单帧失败不影响整体
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
