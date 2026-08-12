// Desktop native-ASR worker: whisper.cpp (ggml) via whisper-cli with Metal
// acceleration, CPU fallback. Replaces the transformers.js ONNX pipeline on
// the desktop path; the browser path keeps transformers.js.
import { spawn, type ChildProcess } from 'node:child_process';
import { createReadStream, existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import type {
  DesktopAsrBackend,
  DesktopAsrRequest,
  DesktopAsrResponse,
  DesktopModelLoadResponse,
  DesktopAsrPreloadRequest,
} from '../shared/desktop-inference.ts';
import {
  parseDesktopAsrPreloadRequest,
  parseDesktopAsrRequest,
} from '../shared/desktop-inference.ts';
import { ASR_INFERENCE_CONTRACT } from '../shared/asr-inference-contract.ts';
import { NativeAsrWorkerLifecycle } from './native-asr-worker-lifecycle.ts';
import {
  whisperLanguage,
  whisperTokensToChunks,
  writeWav,
  type WhisperJson,
} from './native-asr-utils.ts';

const SAMPLE_RATE = ASR_INFERENCE_CONTRACT.sampleRate;
const STDERR_LIMIT = 8_000;
const WHISPER_CLI_TIMEOUT_MS = 45 * 60 * 1000;

interface NativeWorkerData {
  readonly cacheDir: string;
  readonly ffmpegPath: string;
  readonly whisperCliPath: string;
  readonly platform: NodeJS.Platform;
}

// ONNX modelId (browser catalog) -> GGML model file for the desktop engine.
const GGML_MODELS: Record<string, { fileName: string }> = {
  'Xenova/whisper-tiny': { fileName: 'ggml-tiny-q5_1.bin' },
  'onnx-community/whisper-base_timestamped': { fileName: 'ggml-base-q5_1.bin' },
  'Xenova/whisper-small': { fileName: 'ggml-small-q5_1.bin' },
  'Xenova/whisper-medium': { fileName: 'ggml-medium-q5_1.bin' },
};

interface LoadedEngine {
  readonly modelId: string;
  readonly revision: string;
  readonly ggmlPath: string;
  readonly backend: DesktopAsrBackend;
}

const port = process.parentPort;
if (!port) throw new Error('native ASR process requires a parent port');
let runtime: NativeWorkerData | null = null;
let loaded: LoadedEngine | null = null;
const lifecycle = new NativeAsrWorkerLifecycle();

function initialize(value: unknown): void {
  if (typeof value !== 'object' || value === null) throw new Error('invalid native ASR configuration');
  const config = value as Partial<NativeWorkerData>;
  if (typeof config.ffmpegPath !== 'string' || config.ffmpegPath.length === 0
    || typeof config.cacheDir !== 'string' || config.cacheDir.length === 0
    || typeof config.whisperCliPath !== 'string' || config.whisperCliPath.length === 0
    || typeof config.platform !== 'string') {
    throw new Error('invalid native ASR configuration');
  }
  runtime = config as NativeWorkerData;
}

function requireRuntime(): NativeWorkerData {
  if (!runtime) throw new Error('native ASR process is not initialized');
  return runtime;
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
    const onData = (chunk: Buffer): void => {
      chunks.push(chunk);
      totalBytes += chunk.length;
    };
    child.stdout.on('data', onData);
    child.stderr.resume();
    child.once('error', (error) => reject(error));
    child.once('close', (code) => {
      if (code === 0) {
        resolve(decodePcm(chunks, totalBytes));
      } else {
        reject(new Error(`FFmpeg PCM extraction failed (${code})`));
      }
    });
    input.on('error', (error) => {
      child.kill();
      reject(error);
    });
    input.pipe(child.stdin);
  });
}

function runWhisperCli(
  ggmlPath: string,
  wavPath: string,
  language: string,
  useGpu: boolean,
  signal?: AbortSignal,
): Promise<{ jsonPath: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const args = [
      '-m', ggmlPath,
      '-f', wavPath,
      '-t', '8',
      '-l', language,
      '-ml', '20',
      '-sow',
      '-ojf',
      '-nt',
      '-of', wavPath,
    ];
    if (!useGpu) args.push('-ng');
    const child: ChildProcess = spawn(requireRuntime().whisperCliPath, args, {
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
    });
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      reject(new Error('whisper-cli timed out.'));
    }, WHISPER_CLI_TIMEOUT_MS);
    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      reject(new Error('native ASR request aborted.'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-STDERR_LIMIT);
    });
    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(error);
    });
    child.once('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (code !== 0) {
        reject(new Error(`whisper-cli failed (${code}): ${stderr.slice(-600)}`));
        return;
      }
      resolve({ jsonPath: `${wavPath}.json`, stderr });
    });
  });
}

async function transcribeWithEngine(
  request: DesktopAsrRequest,
  engine: LoadedEngine,
  signal?: AbortSignal,
): Promise<DesktopAsrResponse> {
  const samples = await extractPcm(request);
  const dir = await mkdtemp(join(tmpdir(), 'occ-asr-'));
  const wavPath = join(dir, 'input.wav');
  try {
    await writeWav(samples, wavPath);
    let json: WhisperJson;
    let backend: DesktopAsrBackend = engine.backend;
    try {
      const { jsonPath } = await runWhisperCli(
        engine.ggmlPath, wavPath, whisperLanguage(request.language), true, signal,
      );
      json = JSON.parse(await readFile(jsonPath, 'utf8')) as WhisperJson;
    } catch (gpuError) {
      if (engine.backend === 'native-cpu') throw gpuError;
      const { jsonPath } = await runWhisperCli(
        engine.ggmlPath, wavPath, whisperLanguage(request.language), false, signal,
      );
      json = JSON.parse(await readFile(jsonPath, 'utf8')) as WhisperJson;
      backend = 'native-cpu';
    }
    const { text, chunks } = whisperTokensToChunks(json.transcription);
    return {
      requestId: request.requestId,
      backend,
      text,
      chunks,
    };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

function ggmlPathFor(modelId: string): string | null {
  const spec = GGML_MODELS[modelId];
  if (!spec) return null;
  const path = join(requireRuntime().cacheDir, 'ggml', spec.fileName);
  return existsSync(path) ? path : null;
}

async function ensureEngine(request: DesktopAsrRequest | DesktopAsrPreloadRequest): Promise<LoadedEngine> {
  if (loaded?.modelId === request.modelId && loaded.revision === request.revision) return loaded;
  loaded = null;
  const cliPath = requireRuntime().whisperCliPath;
  if (!existsSync(cliPath)) {
    throw new Error('whisper-cli is unavailable; reinstall the desktop app or run npm run sync:whisper-cli.');
  }
  const ggmlPath = ggmlPathFor(request.modelId);
  if (!ggmlPath) {
    throw new Error(`Desktop ASR requires the GGML model for ${request.modelId}; download the model first.`);
  }
  const preferred: DesktopAsrBackend = requireRuntime().platform === 'darwin' ? 'native-metal' : 'native-cpu';
  loaded = { modelId: request.modelId, revision: request.revision, ggmlPath, backend: preferred };
  return loaded;
}

async function preload(request: DesktopAsrPreloadRequest): Promise<DesktopModelLoadResponse> {
  const engine = await ensureEngine(request);
  return {
    requestId: request.requestId,
    backend: engine.backend,
    result: { type: 'loaded' },
  };
}

async function handle(value: unknown): Promise<void> {
  const load = typeof value === 'object' && value !== null && Reflect.get(value, 'action') === 'load';
  const request = load ? parseDesktopAsrPreloadRequest(value) : parseNativeTranscriptionRequest(value);
  try {
    const response = load
      ? await preload(request as DesktopAsrPreloadRequest)
      : await transcribeWithEngine(
        request as DesktopAsrRequest,
        await ensureEngine(request as DesktopAsrRequest),
      );
    port.postMessage({ type: 'result', response });
  } catch (error) {
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
