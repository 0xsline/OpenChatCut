import { readFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute } from 'node:path';
import * as ort from 'onnxruntime-node';
import {
  isDesktopInferenceRequestId,
  isDesktopRhythmResponse,
  parseDesktopRhythmRequest,
  type DesktopInferenceBackend,
  type DesktopInferenceProgress,
  type DesktopRhythmRequest,
  type DesktopRhythmResponse,
} from '../shared/desktop-inference.ts';
import { RHYTHM_INFERENCE_CONTRACT } from '../shared/vector-inference-contract.ts';
import {
  BEAT_THIS_BORDER_FRAMES,
  BEAT_THIS_CHUNK_FRAMES,
  BEAT_THIS_EMPTY_LOGIT,
  BEAT_THIS_MEL_BINS,
  beatThisFrameCount,
  beatThisWindowStarts,
  preprocessBeatThisWindow,
  type BeatThisLogits,
  type BeatThisWindow,
  type BeatThisWindowLogits,
} from '../src/audio/intelligence/beatThisPreprocess.ts';

interface NativeRhythmConfig {
  readonly platform: 'darwin' | 'win32' | 'linux';
  readonly preferredBackend: DesktopInferenceBackend;
  readonly modelPath: string;
  readonly filterbankPath: string;
}

interface LoadedRhythmModel {
  readonly backend: DesktopInferenceBackend;
  readonly session: ort.InferenceSession;
  readonly filterbank: Float32Array;
}

const port = process.parentPort;
if (!port) throw new Error('native rhythm process requires a parent port');
let runtime: NativeRhythmConfig | null = null;
let loaded: LoadedRhythmModel | null = null;
let loading: Promise<LoadedRhythmModel> | null = null;
let queue = Promise.resolve();
const canceled = new Set<string>();

function initialize(value: unknown): void {
  if (typeof value !== 'object' || value === null) throw new Error('invalid native rhythm configuration');
  const config = value as Partial<NativeRhythmConfig>;
  if ((config.platform !== 'darwin' && config.platform !== 'win32' && config.platform !== 'linux')
    || !isNativeRhythmBackend(config.preferredBackend)
    || typeof config.modelPath !== 'string' || !isAbsolute(config.modelPath)
    || typeof config.filterbankPath !== 'string' || !isAbsolute(config.filterbankPath)
    || basename(config.modelPath) !== RHYTHM_INFERENCE_CONTRACT.files.model.path
    || basename(config.filterbankPath) !== RHYTHM_INFERENCE_CONTRACT.files.filterbank.path
    || dirname(config.modelPath) !== dirname(config.filterbankPath)) {
    throw new Error('invalid native rhythm configuration');
  }
  runtime = config as NativeRhythmConfig;
}

function isNativeRhythmBackend(value: unknown): value is DesktopInferenceBackend {
  return value === 'coreml' || value === 'cuda' || value === 'directml' || value === 'native-cpu';
}

function executionProvider(backend: DesktopInferenceBackend): 'coreml' | 'cuda' | 'dml' | 'cpu' {
  if (backend === 'coreml' || backend === 'cuda') return backend;
  if (backend === 'directml') return 'dml';
  return 'cpu';
}

function requireRuntime(): NativeRhythmConfig {
  if (!runtime) throw new Error('native rhythm process is not initialized');
  return runtime;
}

function throwIfCanceled(requestId: string): void {
  if (canceled.has(requestId)) throw new DOMException('Native rhythm request canceled', 'AbortError');
}

function report(requestId: string, progress: number): void {
  const message: DesktopInferenceProgress = {
    requestId,
    progress: Math.max(0, Math.min(1, progress)),
  };
  port.postMessage({ type: 'progress', progress: message });
}

async function loadWithProvider(
  config: NativeRhythmConfig,
  provider: 'coreml' | 'cuda' | 'dml' | 'cpu',
  filterbank: Float32Array,
): Promise<LoadedRhythmModel> {
  const session = await ort.InferenceSession.create(config.modelPath, {
    executionProviders: [provider],
    graphOptimizationLevel: 'all',
    logSeverityLevel: 3,
  });
  const backend: DesktopInferenceBackend = provider === 'coreml'
    ? 'coreml'
    : provider === 'cuda' ? 'cuda'
      : provider === 'dml' ? 'directml' : 'native-cpu';
  return { backend, session, filterbank };
}

async function createLoaded(requestId: string): Promise<LoadedRhythmModel> {
  const config = requireRuntime();
  const bytes = await readFile(config.filterbankPath);
  if (bytes.byteLength !== RHYTHM_INFERENCE_CONTRACT.files.filterbank.sizeBytes) {
    throw new Error('native rhythm filterbank size changed after verification');
  }
  const copied = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const filterbank = new Float32Array(copied);
  throwIfCanceled(requestId);
  report(requestId, 0.1);
  const preferred = executionProvider(config.preferredBackend);
  if (preferred === 'cpu') return loadWithProvider(config, preferred, filterbank);
  try {
    return await loadWithProvider(config, preferred, filterbank);
  } catch {
    return loadWithProvider(config, 'cpu', filterbank);
  }
}

async function ensureLoaded(requestId: string): Promise<LoadedRhythmModel> {
  if (loaded) return loaded;
  if (!loading) {
    loading = createLoaded(requestId).then((result) => {
      loaded = result;
      return result;
    }).finally(() => {
      loading = null;
    });
  }
  const active = await loading;
  report(requestId, 0.4);
  return active;
}

function outputData(tensor: ort.Tensor, expected: number): Float32Array {
  if (!(tensor.data instanceof Float32Array) || tensor.data.length !== expected) {
    throw new Error(`native rhythm output shape mismatch: expected ${expected}`);
  }
  for (const value of tensor.data) {
    if (!Number.isFinite(value)) throw new Error('native rhythm model returned a non-finite logit');
  }
  return tensor.data;
}

async function runWindow(
  session: ort.InferenceSession,
  window: BeatThisWindow,
): Promise<BeatThisWindowLogits> {
  const input = new ort.Tensor('float32', window.values, [1, window.frames, BEAT_THIS_MEL_BINS]);
  const result = await session.run({ spect: input });
  if (!result.beat || !result.downbeat) {
    throw new Error('native rhythm model returned no beat/downbeat tensors');
  }
  return {
    beat: outputData(result.beat, window.frames),
    downbeat: outputData(result.downbeat, window.frames),
  };
}

async function runWindowWithFallback(
  active: LoadedRhythmModel,
  window: BeatThisWindow,
): Promise<{ active: LoadedRhythmModel; prediction: BeatThisWindowLogits }> {
  try {
    return { active, prediction: await runWindow(active.session, window) };
  } catch (error) {
    if (active.backend === 'native-cpu') throw error;
    await active.session.release().catch(() => undefined);
    const cpu = await loadWithProvider(requireRuntime(), 'cpu', active.filterbank);
    loaded = cpu;
    return { active: cpu, prediction: await runWindow(cpu.session, window) };
  }
}

function writeWindowLogits(
  logits: BeatThisLogits,
  window: BeatThisWindow,
  prediction: BeatThisWindowLogits,
): void {
  for (let frame = BEAT_THIS_BORDER_FRAMES; frame < window.frames - BEAT_THIS_BORDER_FRAMES; frame += 1) {
    const target = window.start + frame;
    if (target < 0 || target >= logits.beat.length) continue;
    logits.beat[target] = prediction.beat[frame]!;
    logits.downbeat[target] = prediction.downbeat[frame]!;
  }
}

async function analyze(
  request: Extract<DesktopRhythmRequest, { action: 'analyze' }>,
): Promise<DesktopRhythmResponse> {
  let active = await ensureLoaded(request.requestId);
  throwIfCanceled(request.requestId);
  const fullFrames = beatThisFrameCount(request.samples);
  const starts = beatThisWindowStarts(fullFrames);
  const logits: BeatThisLogits = {
    beat: new Float32Array(fullFrames).fill(BEAT_THIS_EMPTY_LOGIT),
    downbeat: new Float32Array(fullFrames).fill(BEAT_THIS_EMPTY_LOGIT),
  };
  for (let index = starts.length - 1; index >= 0; index -= 1) {
    throwIfCanceled(request.requestId);
    const completed = starts.length - index - 1;
    const window = preprocessBeatThisWindow(request.samples, active.filterbank, starts[index]!);
    if (window.frames > BEAT_THIS_CHUNK_FRAMES) throw new Error('native rhythm chunk exceeds model limit');
    report(request.requestId, 0.4 + (completed / starts.length) * 0.59);
    const result = await runWindowWithFallback(active, window);
    active = result.active;
    writeWindowLogits(logits, window, result.prediction);
    throwIfCanceled(request.requestId);
  }
  report(request.requestId, 1);
  return { requestId: request.requestId, backend: active.backend,
    result: { type: 'analysis', beat: logits.beat, downbeat: logits.downbeat } };
}

async function respond(request: DesktopRhythmRequest): Promise<DesktopRhythmResponse> {
  if (request.action === 'analyze') return analyze(request);
  const active = await ensureLoaded(request.requestId);
  throwIfCanceled(request.requestId);
  report(request.requestId, 1);
  return { requestId: request.requestId, backend: active.backend, result: { type: 'loaded' } };
}

async function handle(value: unknown): Promise<void> {
  const request = parseDesktopRhythmRequest(value);
  try {
    const response = await respond(request);
    if (!isDesktopRhythmResponse(response)) throw new Error('native rhythm response failed validation');
    port.postMessage({ type: 'result', response });
  } catch (error) {
    const name = error instanceof Error ? error.name : 'Error';
    const message = error instanceof Error ? error.message : String(error);
    port.postMessage({ type: 'error', requestId: request.requestId, name, message });
  } finally {
    canceled.delete(request.requestId);
  }
}

port.on('message', (event) => {
  const value = event.data;
  if (typeof value === 'object' && value !== null && Reflect.get(value, 'type') === 'initialize') {
    initialize(Reflect.get(value, 'config'));
    return;
  }
  if (typeof value === 'object' && value !== null && Reflect.get(value, 'type') === 'cancel') {
    const requestId = Reflect.get(value, 'requestId');
    if (!isDesktopInferenceRequestId(requestId)) throw new Error('invalid native rhythm cancellation');
    canceled.add(requestId);
    return;
  }
  queue = queue.then(() => handle(value), () => handle(value));
});
