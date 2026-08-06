/**
 * MediaPipe vision runtime for visual geometry (person segmentation + face).
 *
 * Deliberately lazy: @mediapipe/tasks-vision is heavy, so it is only loaded on
 * first geometry analysis. CPU delegate first (XNNPACK): the WebGL GPU
 * delegate often initializes fine but returns empty/garbage masks (observed in
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

interface MediaPipeRuntime {
  segment: (canvas: HTMLCanvasElement) => { face: GeomRect | null; occ: Uint8Array };
  delegate: 'CPU' | 'GPU';
}

let runtimePromise: Promise<MediaPipeRuntime | null> | null = null;

async function loadRuntime(): Promise<MediaPipeRuntime | null> {
  const { FaceDetector, FilesetResolver, ImageSegmenter } = await import('@mediapipe/tasks-vision');
  for (const delegate of ['CPU', 'GPU'] as const) {
    try {
      const fileset = await FilesetResolver.forVisionTasks(WASM_PATH);
      const segmenter = await ImageSegmenter.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: SEG_MODEL, delegate },
        runningMode: 'IMAGE',
        outputConfidenceMasks: true,
        outputCategoryMask: false,
      });
      const detector = await FaceDetector.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: FACE_MODEL, delegate },
        runningMode: 'IMAGE',
      });
      return {
        delegate,
        segment: (canvas) => inferFrame(segmenter, detector, canvas),
      };
    } catch (error) {
      console.warn(`[geometry] MediaPipe ${delegate} delegate failed:`, error);
    }
  }
  return null;
}

/** Load (once) or reuse the MediaPipe runtime; a failed load is retried next call. */
export function getMediaPipeRuntime(): Promise<MediaPipeRuntime | null> {
  if (!runtimePromise) {
    runtimePromise = loadRuntime().then(
      (runtime) => runtime,
      () => null,
    );
    // Do not pin a permanent failure: reset so the next call retries.
    runtimePromise.then((runtime) => {
      if (!runtime && runtimePromise) runtimePromise = null;
    });
  }
  return runtimePromise;
}

/** Debug hook for tests/QA; forces a fresh load next time. */
export function __resetMediaPipeRuntime(): void {
  runtimePromise = null;
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
