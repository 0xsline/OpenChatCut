/// <reference lib="webworker" />
import * as ort from 'onnxruntime-web/webgpu';
import ortJsepWasmUrl from '../../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.jsep.wasm?url';
import {
  BEAT_THIS_BORDER_FRAMES,
  BEAT_THIS_CHUNK_FRAMES,
  BEAT_THIS_EMPTY_LOGIT,
  BEAT_THIS_FFT_BINS,
  BEAT_THIS_MEL_BINS,
  BEAT_THIS_SAMPLE_RATE,
  beatThisFrameCount,
  beatThisWindowStarts,
  preprocessBeatThisWindow,
  type BeatThisLogits,
  type BeatThisWindow,
  type BeatThisWindowLogits,
} from './beatThisPreprocess';

const REVISION = '4e971bd43753023e1bf961c34a0cb74985cfcb88';
const PROXY_ROOT = `/api/hf-proxy/musetric/beat-this-onnx/resolve/${REVISION}`;
const MODEL_URL = `${PROXY_ROOT}/beat_this.onnx`;
const FILTERBANK_URL = `${PROXY_ROOT}/mel-filterbank.bin`;
const MODEL_BYTES = 83_143_431;
const FILTERBANK_BYTES = BEAT_THIS_FFT_BINS * BEAT_THIS_MEL_BINS * Float32Array.BYTES_PER_ELEMENT;
const MAX_SAMPLES = BEAT_THIS_SAMPLE_RATE * 60 * 60;
const scope = self as unknown as DedicatedWorkerGlobalScope;

ort.env.logLevel = 'error';
ort.env.wasm.wasmPaths = { wasm: ortJsepWasmUrl };

type Backend = 'webgpu' | 'wasm';
type AnalyzeRequest = { readonly id: number; readonly type: 'analyze'; readonly backend: Backend; readonly samples: Float32Array };
type WorkerResponse =
  | { readonly id: number; readonly type: 'progress'; readonly progress: number }
  | { readonly id: number; readonly type: 'result'; readonly beat: Float32Array; readonly downbeat: Float32Array }
  | { readonly id: number; readonly type: 'error'; readonly message: string };

let started = false;
let lockedBackend: Backend | null = null;

function post(message: WorkerResponse, transfer: Transferable[] = []): void {
  scope.postMessage(message, transfer);
}

function report(id: number, progress: number): void {
  post({ id, type: 'progress', progress: Math.max(0, Math.min(1, progress)) });
}

function validateRequest(value: unknown): AnalyzeRequest {
  if (!value || typeof value !== 'object') throw new Error('Invalid Beat This worker request');
  const request = value as Partial<AnalyzeRequest>;
  if (request.type !== 'analyze' || !Number.isSafeInteger(request.id) || (request.id ?? -1) < 0) {
    throw new Error('Invalid Beat This worker request envelope');
  }
  if (request.backend !== 'webgpu' && request.backend !== 'wasm') throw new Error('Invalid Beat This backend');
  if (!(request.samples instanceof Float32Array)) throw new Error('Invalid Beat This audio samples');
  if (request.samples.length <= 512 || request.samples.length > MAX_SAMPLES) {
    throw new Error(`Beat This audio length out of range (max ${MAX_SAMPLES / BEAT_THIS_SAMPLE_RATE}s)`);
  }
  return request as AnalyzeRequest;
}

async function fetchPinnedBinary(
  url: string,
  expectedBytes: number,
  onProgress: (progress: number) => void,
): Promise<ArrayBuffer> {
  if (!url.startsWith('/api/hf-proxy/')) throw new Error('Beat This model URL must use the local HF proxy');
  const response = await fetch(url, { cache: 'no-store' });
  if (!response.ok) throw new Error(`Unable to load ${url.split('/').pop()}: HTTP ${response.status}`);
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > 0 && declared !== expectedBytes) {
    throw new Error(`Unexpected ${url.split('/').pop()} size: ${declared}`);
  }
  if (!response.body) {
    const bytes = await response.arrayBuffer();
    if (bytes.byteLength !== expectedBytes) throw new Error(`Unexpected ${url.split('/').pop()} size: ${bytes.byteLength}`);
    onProgress(1);
    return bytes;
  }
  const output = new Uint8Array(expectedBytes);
  const reader = response.body.getReader();
  let offset = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (offset + value.length > expectedBytes) throw new Error(`${url.split('/').pop()} exceeds expected size`);
    output.set(value, offset);
    offset += value.length;
    onProgress(offset / expectedBytes);
  }
  if (offset !== expectedBytes) throw new Error(`Unexpected ${url.split('/').pop()} size: ${offset}`);
  return output.buffer;
}

async function loadSession(request: AnalyzeRequest): Promise<{ session: ort.InferenceSession; filterbank: Float32Array }> {
  const filterBytes = await fetchPinnedBinary(FILTERBANK_URL, FILTERBANK_BYTES, (value) => report(request.id, value * 0.03));
  report(request.id, 0.03);
  const modelBytes = await fetchPinnedBinary(MODEL_URL, MODEL_BYTES, (value) => report(request.id, 0.03 + value * 0.27));
  const session = await ort.InferenceSession.create(new Uint8Array(modelBytes), {
    executionProviders: [request.backend],
    graphOptimizationLevel: 'all',
  });
  report(request.id, 0.4);
  return { session, filterbank: new Float32Array(filterBytes) };
}

async function runWindow(session: ort.InferenceSession, window: BeatThisWindow): Promise<BeatThisWindowLogits> {
  const input = new ort.Tensor('float32', window.values, [1, window.frames, BEAT_THIS_MEL_BINS]);
  try {
    const result = await session.run({ spect: input });
    const beatTensor = result.beat;
    const downbeatTensor = result.downbeat;
    if (!beatTensor || !downbeatTensor) throw new Error('Beat This model did not return beat/downbeat tensors');
    try {
      const beatData = await beatTensor.getData();
      const downbeatData = await downbeatTensor.getData();
      const beat = Float32Array.from(beatData as Float32Array);
      const downbeat = Float32Array.from(downbeatData as Float32Array);
      if (beat.length !== window.frames || downbeat.length !== window.frames) {
        throw new Error(`Beat This output shape mismatch: expected ${window.frames}`);
      }
      return { beat, downbeat };
    } finally {
      beatTensor.dispose();
      downbeatTensor.dispose();
    }
  } finally {
    input.dispose();
  }
}

function writeWindowLogits(
  logits: BeatThisLogits,
  window: BeatThisWindow,
  prediction: BeatThisWindowLogits,
): void {
  if (prediction.beat.length !== window.frames || prediction.downbeat.length !== window.frames) {
    throw new Error(`Beat This output shape mismatch for window at ${window.start}`);
  }
  for (let frame = BEAT_THIS_BORDER_FRAMES; frame < window.frames - BEAT_THIS_BORDER_FRAMES; frame += 1) {
    const target = window.start + frame;
    if (target < 0 || target >= logits.beat.length) continue;
    logits.beat[target] = prediction.beat[frame]!;
    logits.downbeat[target] = prediction.downbeat[frame]!;
  }
}

async function analyze(request: AnalyzeRequest): Promise<void> {
  const { session, filterbank } = await loadSession(request);
  try {
    const fullFrames = beatThisFrameCount(request.samples);
    const starts = beatThisWindowStarts(fullFrames);
    const logits: BeatThisLogits = {
      beat: new Float32Array(fullFrames).fill(BEAT_THIS_EMPTY_LOGIT),
      downbeat: new Float32Array(fullFrames).fill(BEAT_THIS_EMPTY_LOGIT),
    };
    for (let index = starts.length - 1; index >= 0; index -= 1) {
      const completed = starts.length - index - 1;
      const window = preprocessBeatThisWindow(request.samples, filterbank, starts[index]!);
      if (window.frames > BEAT_THIS_CHUNK_FRAMES) throw new Error('Beat This chunk exceeds model limit');
      report(request.id, 0.4 + (completed * 0.59 + 0.25) / starts.length);
      writeWindowLogits(logits, window, await runWindow(session, window));
      report(request.id, 0.4 + ((completed + 1) / starts.length) * 0.59);
    }
    report(request.id, 1);
    post(
      { id: request.id, type: 'result', beat: logits.beat, downbeat: logits.downbeat },
      [logits.beat.buffer, logits.downbeat.buffer],
    );
  } finally {
    await session.release();
  }
}

scope.onmessage = (event: MessageEvent<unknown>) => {
  let request: AnalyzeRequest;
  try {
    request = validateRequest(event.data);
    if (started) throw new Error('Beat This worker accepts exactly one analysis job');
    if (lockedBackend && lockedBackend !== request.backend) throw new Error('Beat This worker backend cannot change');
    started = true;
    lockedBackend = request.backend;
  } catch (error) {
    const id = Number((event.data as { id?: unknown } | null)?.id ?? -1);
    post({ id, type: 'error', message: error instanceof Error ? error.message : String(error) });
    return;
  }
  void analyze(request).catch((error: unknown) => {
    post({ id: request.id, type: 'error', message: error instanceof Error ? error.message : String(error) });
  });
};
