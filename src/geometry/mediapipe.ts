/**
 * MediaPipe vision runtime for visual geometry (person segmentation + face).
 *
 * Deliberately lazy: @mediapipe/tasks-vision is heavy, so it is only loaded on
 * first geometry analysis. CPU delegate first (XNNPACK): the WebGL GPU
 * delegate often initializes fine but returns empty/garbage masks; offline
 * 2fps×512px analysis does not need GPU.
 *
 * WASM and models are self-hosted under /mediapipe (scripts/sync-mediapipe.mjs)
 * so analysis works offline and same-origin. Any failure degrades to null —
 * geometry is an enhancement, never a blocker.
 */

export const GEOM_FPS = 2;
/** Long videos spread this many samples across the whole span (short clips use GEOM_FPS). */
export const GEOM_MAX_FRAMES = 420;
/** Person-confidence threshold on the segmenter mask. */
export const SEG_THRESHOLD = 0.4;
/** Long edge of the inference input (pixels). 512 keeps short-range face
 * detection reliable (512px downsamples talking-head faces below the
 * detector's working range); CPU inference at 2fps stays cheap. */
export const INFERENCE_EDGE = 512;

const WASM_PATH = '/mediapipe/wasm';
const SEG_MODEL = '/mediapipe/selfie_segmenter.tflite';
const FACE_MODEL = '/mediapipe/blaze_face_short_range.tflite';

import { GEOM_GRID_H, GEOM_GRID_W, type GeomRect } from './geometry-math';
import type { FrameGeom } from './geometry-math';
import type { FaceDetector, ImageSegmenter } from '@mediapipe/tasks-vision';

export interface MediaPipeRuntime {
  segment: (canvas: HTMLCanvasElement) => { face: GeomRect | null; occ: Uint8Array };
  delegate: 'CPU' | 'GPU';
  close: () => void;
}

type RuntimeLoader = (signal: AbortSignal) => Promise<MediaPipeRuntime | null>;

interface RuntimeLoadState {
  promise: Promise<MediaPipeRuntime | null>;
  controller: AbortController;
  runtime: MediaPipeRuntime | null;
  settled: boolean;
  waiters: number;
}

let runtimeState: RuntimeLoadState | null = null;
let runtimeLoader: RuntimeLoader = loadRuntime;

function closeTask(task: { close: () => void } | null): void {
  try {
    task?.close();
  } catch {
    // Best-effort release for an optional analysis runtime.
  }
}

function closeRuntime(runtime: MediaPipeRuntime | null): void {
  if (runtime) closeTask(runtime);
}

async function loadRuntime(signal: AbortSignal): Promise<MediaPipeRuntime | null> {
  // Dynamic import preserves the feature's required lazy-loading boundary.
  const { FaceDetector, FilesetResolver, ImageSegmenter } = await import('@mediapipe/tasks-vision');
  if (signal.aborted) return null;
  for (const delegate of ['CPU', 'GPU'] as const) {
    let segmenter: ImageSegmenter | null = null;
    let detector: FaceDetector | null = null;
    const closeResources = (): void => {
      const activeDetector = detector;
      const activeSegmenter = segmenter;
      detector = null;
      segmenter = null;
      closeTask(activeDetector);
      closeTask(activeSegmenter);
    };
    signal.addEventListener('abort', closeResources, { once: true });
    try {
      signal.throwIfAborted();
      const fileset = await FilesetResolver.forVisionTasks(WASM_PATH);
      signal.throwIfAborted();
      segmenter = await ImageSegmenter.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: SEG_MODEL, delegate },
        runningMode: 'IMAGE',
        outputConfidenceMasks: true,
        outputCategoryMask: false,
      });
      signal.throwIfAborted();
      detector = await FaceDetector.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: FACE_MODEL, delegate },
        runningMode: 'IMAGE',
      });
      signal.throwIfAborted();
      const activeSegmenter = segmenter;
      const activeDetector = detector;
      signal.removeEventListener('abort', closeResources);
      return {
        delegate,
        segment: (canvas) => inferFrame(activeSegmenter, activeDetector, canvas),
        close: () => {
          closeTask(activeDetector);
          closeTask(activeSegmenter);
        },
      };
    } catch (error) {
      signal.removeEventListener('abort', closeResources);
      closeResources();
      if (signal.aborted) return null;
      console.warn(`[geometry] MediaPipe ${delegate} delegate failed:`, error);
    }
  }
  return null;
}

function startRuntimeLoad(): RuntimeLoadState {
  const loader = runtimeLoader;
  const controller = new AbortController();
  const state: RuntimeLoadState = {
    promise: Promise.resolve(null),
    controller,
    runtime: null,
    settled: false,
    waiters: 0,
  };
  runtimeState = state;
  state.promise = Promise.resolve()
    .then(() => loader(controller.signal))
    .catch(() => null)
    .then((runtime) => {
      state.settled = true;
      if (runtimeState !== state) {
        closeRuntime(runtime);
        return null;
      }
      if (runtime) state.runtime = runtime;
      else runtimeState = null;
      return runtime;
    });
  return state;
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('The operation was aborted', 'AbortError');
}

function releaseWaiter(state: RuntimeLoadState): void {
  state.waiters = Math.max(0, state.waiters - 1);
  if (!state.settled && state.waiters === 0 && runtimeState === state) {
    runtimeState = null;
    state.controller.abort();
  }
}

function waitForRuntime(
  state: RuntimeLoadState,
  signal?: AbortSignal,
): Promise<MediaPipeRuntime | null> {
  state.waiters += 1;
  if (!signal) return state.promise.finally(() => releaseWaiter(state));
  return new Promise<MediaPipeRuntime | null>((resolve, reject) => {
    let done = false;
    const finish = (callback: () => void): void => {
      if (done) return;
      done = true;
      signal.removeEventListener('abort', onAbort);
      callback();
    };
    const onAbort = (): void => finish(() => reject(abortReason(signal)));
    signal.addEventListener('abort', onAbort, { once: true });
    state.promise.then(
      (runtime) => finish(() => resolve(runtime)),
      (error) => finish(() => reject(error)),
    );
  }).finally(() => releaseWaiter(state));
}

/** Load or reuse MediaPipe; an aborted in-flight load is retired and may be retried. */
export function getMediaPipeRuntime(signal?: AbortSignal): Promise<MediaPipeRuntime | null> {
  if (signal?.aborted) return Promise.reject(abortReason(signal));
  return waitForRuntime(runtimeState ?? startRuntimeLoad(), signal);
}

/** Debug hook for tests/QA; closes or retires the current runtime. */
export function __resetMediaPipeRuntime(): void {
  const state = runtimeState;
  runtimeState = null;
  if (state && !state.settled) state.controller.abort();
  closeRuntime(state?.runtime ?? null);
}

/** Deterministic verifier seam; null restores the production lazy loader. */
export function __setMediaPipeRuntimeLoaderForVerification(loader: RuntimeLoader | null): void {
  __resetMediaPipeRuntime();
  runtimeLoader = loader ?? loadRuntime;
}

function inferFrame(
  segmenter: ImageSegmenter,
  detector: FaceDetector,
  canvas: HTMLCanvasElement,
): { face: GeomRect | null; occ: Uint8Array } {
  const occ = new Uint8Array(GEOM_GRID_W * GEOM_GRID_H);
  try {
    const result = segmenter.segment(canvas);
    try {
      const conf = result.confidenceMasks?.[0];
      const cat = result.categoryMask;
      if (conf) {
        const arr = conf.getAsFloat32Array();
        const mw = conf.width;
        const mh = conf.height;
        for (let gy = 0; gy < GEOM_GRID_H; gy++) {
          const py = Math.min(mh - 1, Math.floor(((gy + 0.5) / GEOM_GRID_H) * mh));
          for (let gx = 0; gx < GEOM_GRID_W; gx++) {
            const px = Math.min(mw - 1, Math.floor(((gx + 0.5) / GEOM_GRID_W) * mw));
            if ((arr[py * mw + px] ?? 0) > SEG_THRESHOLD) occ[gy * GEOM_GRID_W + gx] = 1;
          }
        }
      } else if (cat) {
        const arr = cat.getAsUint8Array();
        const mw = cat.width;
        const mh = cat.height;
        for (let gy = 0; gy < GEOM_GRID_H; gy++) {
          const py = Math.min(mh - 1, Math.floor(((gy + 0.5) / GEOM_GRID_H) * mh));
          for (let gx = 0; gx < GEOM_GRID_W; gx++) {
            const px = Math.min(mw - 1, Math.floor(((gx + 0.5) / GEOM_GRID_W) * mw));
            if ((arr[py * mw + px] ?? 0) > 0) occ[gy * GEOM_GRID_W + gx] = 1;
          }
        }
      }
    } finally {
      result.confidenceMasks?.forEach((mask) => mask.close());
      result.categoryMask?.close();
      result.close();
    }
  } catch {
    // segmentation failed for this frame — treat as all-empty
  }
  let face: GeomRect | null = null;
  try {
    const box = detector.detect(canvas).detections?.[0]?.boundingBox;
    if (box) {
      face = {
        x: box.originX / canvas.width,
        y: box.originY / canvas.height,
        w: box.width / canvas.width,
        h: box.height / canvas.height,
      };
    }
  } catch {
    // no face detected
  }
  return { face, occ };
}

/** Run one frame of pixels through segmentation + face detection. */
export function inferFrameFromPixels(
  runtime: MediaPipeRuntime,
  pixels: { data: Uint8ClampedArray; width: number; height: number },
): { face: GeomRect | null; occ: Uint8Array } {
  const scale = Math.min(1, INFERENCE_EDGE / Math.max(pixels.width, pixels.height));
  const cw = Math.max(2, Math.round(pixels.width * scale));
  const ch = Math.max(2, Math.round(pixels.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = cw;
  canvas.height = ch;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return { face: null, occ: new Uint8Array(GEOM_GRID_W * GEOM_GRID_H) };
  const image = new ImageData(new Uint8ClampedArray(pixels.data), pixels.width, pixels.height);
  ctx.putImageData(image, 0, 0);
  return runtime.segment(canvas);
}

/** Convert FrameGeom to a JSON-serializable shape (cache-friendly). */
export function serializeFrameGeoms(frames: readonly FrameGeom[]): unknown[] {
  return frames.map((f) => ({ t: f.t, face: f.face, occ: Array.from(f.occ) }));
}

/** Restore serialized frames back to FrameGeom. */
export function deserializeFrameGeoms(raw: readonly { t: number; face: GeomRect | null; occ: number[] }[]): FrameGeom[] {
  return raw.map((f) => ({ t: f.t, face: f.face, occ: Uint8Array.from(f.occ) }));
}
