// Silero VAD runner for the local silence-removal feature. The tiny ONNX
// model (onnx-community/silero-vad, MIT, bundled under public/models) runs
// through onnxruntime-web; the session loads lazily on first use so the
// chunk never enters the initial bundle. Absence or failure degrades the
import * as ort from 'onnxruntime-web/wasm';
import { registerVadRunner, type VadRunResult } from './vad';
import type { VadTimeSpan } from '../persist/vadEvidenceStore';
const MODEL_URL = '/models/silero-vad/silero_vad.onnx';
// The ort backend loader + wasm binary sit beside the model in public/ so no
// node_modules subpath (blocked by the package exports map) is ever imported.
const WASM_PATH = '/models/silero-vad/';
const VAD_SAMPLE_RATE = 16_000;
const WINDOW_SIZE = 512; // 32ms @16kHz — Silero VAD's native window
const MERGE_GAP_WINDOWS = 2;
const RUN_BATCH_WINDOWS = 64;

let sessionPromise: Promise<ort.InferenceSession> | null = null;
let installed = false;

function loadSession(): Promise<ort.InferenceSession> {
  if (!sessionPromise) {
    sessionPromise = (async () => {
      // Explicit non-jsep loader pair (the lighter wasm build); the mjs is a
      // prebuilt module served verbatim from public/ — see the dev-only
      // middleware in vite.config.ts.
      ort.env.wasm.numThreads = 1;
      ort.env.wasm.wasmPaths = {
        mjs: `${WASM_PATH}ort-wasm-simd-threaded.mjs`,
        wasm: `${WASM_PATH}ort-wasm-simd-threaded.wasm`,
      };
      return ort.InferenceSession.create(MODEL_URL, { executionProviders: ['wasm'] });
    })().catch((error) => {
      sessionPromise = null;
      throw error;
    });
  }
  return sessionPromise;
}

/** Linear-decimate any sample rate down to 16 kHz mono (VAD quality is
 * insensitive to the resampling method). Pure and exported for verifies. */
export function resampleMonoTo16k(samples: Float32Array, sampleRate: number): Float32Array {
  if (sampleRate === VAD_SAMPLE_RATE) return samples;
  if (sampleRate < VAD_SAMPLE_RATE) throw new Error(`unsupported sample rate ${sampleRate}`);
  const ratio = sampleRate / VAD_SAMPLE_RATE;
  const length = Math.floor(samples.length / ratio);
  const out = new Float32Array(length);
  for (let i = 0; i < length; i += 1) {
    const position = i * ratio;
    const base = Math.floor(position);
    const fraction = position - base;
    const next = Math.min(base + 1, samples.length - 1);
    out[i] = samples[base] + (samples[next] - samples[base]) * fraction;
  }
  return out;
}

/** Merge per-window speech probabilities into spans. Pure and exported for
 * verifies: gap tolerance and per-span confidence live entirely here. */
export function vadSpansFromProbabilities(
  probabilities: Float32Array,
  threshold: number,
  options: { windowMs?: number; mergeGapWindows?: number } = {},
): { spans: VadTimeSpan[]; confidence: number } {
  const windowMs = options.windowMs ?? (WINDOW_SIZE / VAD_SAMPLE_RATE) * 1000;
  const gap = Math.max(0, options.mergeGapWindows ?? MERGE_GAP_WINDOWS);
  const spans: VadTimeSpan[] = [];
  let start = -1;
  let lastSpeech = -1;
  let confidenceSum = 0;
  let confidenceCount = 0;
  const closeSpan = (endWindow: number): void => {
    if (start < 0) return;
    spans.push({
      startMs: Math.round(start * windowMs),
      endMs: Math.round((endWindow + 1) * windowMs),
      confidence: Math.round((confidenceSum / confidenceCount) * 1000) / 1000,
    });
    start = -1;
  };
  for (let i = 0; i < probabilities.length; i += 1) {
    if (probabilities[i] >= threshold) {
      if (start < 0) start = i;
      else if (i - lastSpeech > gap + 1) {
        closeSpan(lastSpeech);
        start = i;
      }
      lastSpeech = i;
      confidenceSum += probabilities[i];
      confidenceCount += 1;
    } else if (start >= 0 && i - lastSpeech > gap) {
      closeSpan(lastSpeech);
    }
  }
  closeSpan(probabilities.length - 1);
  const confidence = confidenceCount > 0 ? confidenceSum / confidenceCount : 0;
  return { spans, confidence };
}

async function runSileroVad(
  samples: Float32Array,
  sampleRate: number,
  threshold: number,
  signal?: AbortSignal,
): Promise<VadRunResult> {
  const session = await loadSession();
  const mono = resampleMonoTo16k(samples, sampleRate);
  const windowCount = Math.floor(mono.length / WINDOW_SIZE);
  if (windowCount === 0) return { speechSpans: [], confidence: 0 };
  const probabilities = new Float32Array(windowCount);
  const batchCount = Math.ceil(windowCount / RUN_BATCH_WINDOWS);
  for (let batch = 0; batch < batchCount; batch += 1) {
    if (signal?.aborted) throw new Error('VAD cancelled');
    const first = batch * RUN_BATCH_WINDOWS;
    const count = Math.min(RUN_BATCH_WINDOWS, windowCount - first);
    const input = new Float32Array(count * WINDOW_SIZE);
    for (let row = 0; row < count; row += 1) {
      const offset = (first + row) * WINDOW_SIZE;
      input.set(mono.subarray(offset, offset + WINDOW_SIZE), row * WINDOW_SIZE);
    }
    const feeds: Record<string, ort.Tensor> = {};
    for (const name of session.inputNames) {
      if (name === 'state') {
        // Zero LSTM state per batch (batch dim = window count): boundary
        // artifacts at 2s intervals are negligible for silence gating and
        // keep batches independent.
        feeds[name] = new ort.Tensor('float32', new Float32Array(2 * count * 128), [2, count, 128]);
      } else if (name === 'sr') {
        feeds[name] = new ort.Tensor('int64', BigInt64Array.from([BigInt(VAD_SAMPLE_RATE)]), [1]);
      } else {
        feeds[name] = new ort.Tensor('float32', input, [count, WINDOW_SIZE]);
      }
    }
    const output = await session.run(feeds);
    const probName = session.outputNames.find((n) => n !== 'state') ?? session.outputNames[0];
    const data = output[probName].data as Float32Array;
    for (let row = 0; row < count; row += 1) {
      probabilities[first + row] = Math.min(1, Math.max(0, data[row]));
    }
  }
  const { spans, confidence } = vadSpansFromProbabilities(probabilities, threshold);
  return { speechSpans: spans, confidence };
}

/** Idempotent registration; model loads on the first actual VAD run. */
export function installSileroVad(): void {
  if (installed) return;
  installed = true;
  registerVadRunner(runSileroVad);
}

export async function ensureSileroVad(): Promise<void> {
  installSileroVad();
  await loadSession().catch(() => undefined);
}
