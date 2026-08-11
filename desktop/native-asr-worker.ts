import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { isAbsolute } from 'node:path';
import {
  env,
  pipeline,
  type AutomaticSpeechRecognitionPipeline,
} from '@huggingface/transformers';
import { ASR_INFERENCE_CONTRACT } from '../shared/asr-inference-contract.ts';
import type {
  DesktopAsrBackend,
  DesktopAsrChunk,
  DesktopAsrPreloadRequest,
  DesktopAsrRequest,
  DesktopAsrResponse,
  DesktopInferenceProgress,
  DesktopModelLoadResponse,
} from '../shared/desktop-inference.ts';
import {
  parseDesktopAsrPreloadRequest,
  parseDesktopAsrRequest,
} from '../shared/desktop-inference.ts';
import { NativeAsrWorkerLifecycle } from './native-asr-worker-lifecycle.ts';

const SAMPLE_RATE = ASR_INFERENCE_CONTRACT.sampleRate;
const MAX_AUDIO_SECONDS = ASR_INFERENCE_CONTRACT.maxAudioSeconds;
const MAX_PCM_BYTES = SAMPLE_RATE * MAX_AUDIO_SECONDS * Float32Array.BYTES_PER_ELEMENT;
const FFMPEG_TIMEOUT_MS = 30 * 60_000;
const ACCELERATOR_LOAD_TIMEOUT_MS = 90_000;
const CPU_LOAD_TIMEOUT_MS = 5 * 60_000;
const STDERR_LIMIT = 8_000;

interface NativeWorkerData {
  readonly cacheDir: string;
  readonly ffmpegPath: string;
  readonly platform: NodeJS.Platform;
}

interface WhisperWordOutput {
  readonly text?: string;
  readonly timestamp?: [number, number] | [null, null];
}

interface WhisperOutput {
  readonly text?: string;
  readonly chunks?: readonly WhisperWordOutput[];
}

interface LoadedPipeline {
  readonly modelId: string;
  readonly revision: string;
  readonly backend: DesktopAsrBackend;
  readonly pipeline: AutomaticSpeechRecognitionPipeline;
}

interface NativeAsrFatalWorkerResult {
  readonly type: 'fatal';
  readonly reason: 'model-load-timeout';
  readonly requestId: string;
  readonly message: string;
}

class NativeAsrModelLoadTimeoutError extends Error {
  constructor() {
    super('native ASR model load timed out');
    this.name = 'NativeAsrModelLoadTimeoutError';
  }
}

const port = process.parentPort;
if (!port) throw new Error('native ASR process requires a parent port');
let runtime: NativeWorkerData | null = null;
let loaded: LoadedPipeline | null = null;
const lifecycle = new NativeAsrWorkerLifecycle();

function initialize(value: unknown): void {
  if (typeof value !== 'object' || value === null) throw new Error('invalid native ASR configuration');
  const config = value as Partial<NativeWorkerData>;
  if (typeof config.ffmpegPath !== 'string' || config.ffmpegPath.length === 0
    || typeof config.cacheDir !== 'string' || config.cacheDir.length === 0
    || typeof config.platform !== 'string') {
    throw new Error('invalid native ASR configuration');
  }
  runtime = config as NativeWorkerData;
  env.localModelPath = config.cacheDir;
  env.cacheDir = config.cacheDir;
  env.useFSCache = true;
  env.allowLocalModels = true;
  env.allowRemoteModels = false;
}

function requireRuntime(): NativeWorkerData {
  if (!runtime) throw new Error('native ASR process is not initialized');
  return runtime;
}

function postProgress(progress: DesktopInferenceProgress): void {
  port.postMessage({ type: 'progress', progress });
}

function parseNativeTranscriptionRequest(value: unknown): DesktopAsrRequest {
  if (typeof value !== 'object' || value === null) throw new Error('invalid native ASR request');
  const sourcePath = Reflect.get(value, 'sourcePath');
  if (typeof sourcePath !== 'string' || !isAbsolute(sourcePath)) {
    throw new Error('invalid native ASR source');
  }
  const request = parseDesktopAsrRequest({ ...value, sourcePath: '/media/uploads/native-input' });
  return { ...request, sourcePath };
}

function decodePcm(chunks: readonly Buffer[], totalBytes: number): Float32Array {
  if (totalBytes === 0 || totalBytes % Float32Array.BYTES_PER_ELEMENT !== 0) {
    throw new Error('FFmpeg returned invalid PCM audio');
  }
  const copy = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    copy.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new Float32Array(copy.buffer);
}

function extractPcm(request: DesktopAsrRequest): Promise<Float32Array> {
  return new Promise((resolve, reject) => {
    const child = spawn(requireRuntime().ffmpegPath, [
      '-nostdin', '-hide_banner', '-loglevel', 'error',
      '-protocol_whitelist', 'pipe,data', '-i', 'pipe:0',
      '-map', '0:a:0', '-ac', '1', '-ar', String(SAMPLE_RATE), '-f', 'f32le', 'pipe:1',
    ], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const input = createReadStream(request.sourcePath);
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let stderr = '';
    let settled = false;
    const settle = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      input.destroy();
      if (error) reject(error);
      else resolve(decodePcm(chunks, totalBytes));
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      settle(new Error('native ASR audio extraction timed out'));
    }, FFMPEG_TIMEOUT_MS);
    child.stdout.on('data', (chunk: Buffer) => {
      totalBytes += chunk.byteLength;
      if (totalBytes > MAX_PCM_BYTES) {
        child.kill('SIGKILL');
        settle(new Error(`audio exceeds ${MAX_AUDIO_SECONDS}s native ASR limit`));
        return;
      }
      chunks.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = `${stderr}${String(chunk)}`.slice(-STDERR_LIMIT);
    });
    input.once('error', (error) => {
      child.kill('SIGKILL');
      settle(error);
    });
    child.once('error', (error) => settle(error));
    child.once('close', (code) => {
      if (code === 0) settle();
      else settle(new Error(stderr.trim() || `FFmpeg exited with code ${String(code)}`));
    });
    input.pipe(child.stdin);
  });
}

function progressInfo(value: unknown): { progress?: number; file?: string } {
  if (typeof value !== 'object' || value === null) return {};
  const progress = value as { progress?: unknown; file?: unknown };
  return {
    ...(typeof progress.progress === 'number' ? { progress: progress.progress } : {}),
    ...(typeof progress.file === 'string' ? { file: progress.file } : {}),
  };
}

async function withModelLoadTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new NativeAsrModelLoadTimeoutError()), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

type AsrLoadRequest = DesktopAsrRequest | DesktopAsrPreloadRequest;

async function createPipeline(
  request: AsrLoadRequest,
  backend: DesktopAsrBackend,
): Promise<AutomaticSpeechRecognitionPipeline> {
  const attempt = pipeline('automatic-speech-recognition', request.modelId, {
    revision: request.revision,
    device: backend === 'directml' ? 'dml' : 'cpu',
    dtype: ASR_INFERENCE_CONTRACT.dtype,
    progress_callback: (value: unknown) => {
      postProgress({ requestId: request.requestId, ...progressInfo(value) });
    },
  }) as Promise<unknown>;
  const timeoutMs = backend === 'directml'
    ? ACCELERATOR_LOAD_TIMEOUT_MS
    : CPU_LOAD_TIMEOUT_MS;
  return (await withModelLoadTimeout(attempt, timeoutMs)) as AutomaticSpeechRecognitionPipeline;
}

async function ensurePipeline(request: AsrLoadRequest): Promise<LoadedPipeline> {
  if (loaded?.modelId === request.modelId && loaded.revision === request.revision) return loaded;
  if (loaded) await loaded.pipeline.dispose();
  loaded = null;
  const preferred: DesktopAsrBackend = requireRuntime().platform === 'win32' ? 'directml' : 'native-cpu';
  try {
    const next = await createPipeline(request, preferred);
    loaded = { modelId: request.modelId, revision: request.revision, backend: preferred, pipeline: next };
  } catch (error) {
    if (preferred !== 'directml' || error instanceof NativeAsrModelLoadTimeoutError) throw error;
    const fallback = await createPipeline(request, 'native-cpu');
    loaded = { modelId: request.modelId, revision: request.revision, backend: 'native-cpu', pipeline: fallback };
  }
  return loaded;
}

function toChunks(output: WhisperOutput): DesktopAsrChunk[] {
  const chunks: DesktopAsrChunk[] = [];
  for (const chunk of output.chunks ?? []) {
    const text = (chunk.text ?? '').trim();
    const [start, end] = chunk.timestamp ?? [null, null];
    if (!text || typeof start !== 'number' || typeof end !== 'number') continue;
    chunks.push({ text, start: Math.round(start * 1000), end: Math.round(end * 1000) });
  }
  return chunks;
}

async function transcribe(request: DesktopAsrRequest): Promise<DesktopAsrResponse> {
  const active = await ensurePipeline(request);
  const samples = await extractPcm(request);
  const output = await active.pipeline(samples, {
    return_timestamps: 'word',
    chunk_length_s: ASR_INFERENCE_CONTRACT.chunkSeconds,
    stride_length_s: ASR_INFERENCE_CONTRACT.strideSeconds,
    language: request.language,
  }) as unknown as WhisperOutput;
  return {
    requestId: request.requestId,
    backend: active.backend,
    text: output.text ?? '',
    chunks: toChunks(output),
  };
}
async function preload(request: DesktopAsrPreloadRequest): Promise<DesktopModelLoadResponse> {
  const active = await ensurePipeline(request);
  return {
    requestId: request.requestId,
    backend: active.backend,
    result: { type: 'loaded' },
  };
}


async function handle(value: unknown): Promise<void> {
  const load = typeof value === 'object' && value !== null && Reflect.get(value, 'action') === 'load';
  const request = load ? parseDesktopAsrPreloadRequest(value) : parseNativeTranscriptionRequest(value);
  try {
    const response = load
      ? await preload(request as DesktopAsrPreloadRequest)
      : await transcribe(request as DesktopAsrRequest);
    port.postMessage({ type: 'result', response });
  } catch (error) {
    if (error instanceof NativeAsrModelLoadTimeoutError) {
      lifecycle.terminate();
      const result: NativeAsrFatalWorkerResult = {
        type: 'fatal',
        reason: 'model-load-timeout',
        requestId: request.requestId,
        message: error.message,
      };
      port.postMessage(result);
      setImmediate(() => process.exit(1));
      return;
    }
    const name = error instanceof Error ? error.name : 'Error';
    const message = error instanceof Error ? error.message : String(error);
    port.postMessage({ type: 'error', requestId: request.requestId, name, message });
  }
}

port.on('message', (event) => {
  if (lifecycle.isTerminal()) return;
  const value = event.data;
  if (typeof value === 'object' && value !== null && Reflect.get(value, 'type') === 'initialize') {
    initialize(Reflect.get(value, 'config'));
    return;
  }
  lifecycle.enqueue(() => handle(value));
});
