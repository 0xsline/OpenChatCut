// Desktop native-ASR worker: whisper.cpp (ggml) via a persistent
// whisper-server (model loaded once) with whisper-cli spawn as fallback.
// Replaces the transformers.js ONNX pipeline on the desktop path; the
// browser path keeps transformers.js.
import { spawn, type ChildProcess } from 'node:child_process';
import { createReadStream, existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { createServer } from 'node:net';
import type {
  DesktopAsrBackend,
  DesktopAsrChunk,
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
  nativeGgmlFileName,
  whisperLanguage,
  whisperTokensToChunks,
  whisperWordsToChunks,
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

const SERVER_READY_TIMEOUT_MS = 20_000;

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
let whisperServer: { child: ChildProcess; port: number; ggmlPath: string } | null = null;
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

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const address = srv.address() as { port: number };
      srv.close(() => resolve(address.port));
    });
  });
}

function serverBinaryPath(): string {
  const cli = requireRuntime().whisperCliPath;
  const suffix = process.platform === 'win32' ? '.exe' : '';
  return join(cli.slice(0, Math.max(cli.lastIndexOf('/'), cli.lastIndexOf('\\')) + 1), `whisper-server${suffix}`);
}

async function stopWhisperServer(): Promise<void> {
  if (whisperServer) {
    whisperServer.child.kill();
    whisperServer = null;
  }
}

async function ensureWhisperServer(ggmlPath: string): Promise<{ child: ChildProcess; port: number; ggmlPath: string }> {
  if (whisperServer && !whisperServer.child.killed && whisperServer.ggmlPath === ggmlPath) {
    return whisperServer;
  }
  await stopWhisperServer();
  const bin = serverBinaryPath();
  if (!existsSync(bin)) throw new Error('whisper-server is unavailable; falling back to whisper-cli.');
  const serverPort = await freePort();
  const child = spawn(bin, [
    '-m', ggmlPath,
    '--host', '127.0.0.1',
    '--port', String(serverPort),
    '-t', '8',
  ], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
  child.stderr?.resume();
  const deadline = Date.now() + SERVER_READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${serverPort}/health`);
      if (response.ok) {
        whisperServer = { child, port: serverPort, ggmlPath };
        return whisperServer;
      }
    } catch {
      // not ready yet
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  child.kill();
  throw new Error('whisper-server failed to become ready.');
}

async function transcribeViaServer(
  ggmlPath: string,
  wavPath: string,
  language: string,
  signal?: AbortSignal,
): Promise<{ text: string; chunks: DesktopAsrChunk[] }> {
  const srv = await ensureWhisperServer(ggmlPath);
  const form = new FormData();
  form.append('file', new Blob([await readFile(wavPath)], { type: 'audio/wav' }), 'input.wav');
  form.append('response_format', 'verbose_json');
  if (language !== 'auto') form.append('language', language);
  const response = await fetch(`http://127.0.0.1:${srv.port}/inference`, {
    method: 'POST',
    body: form,
    signal,
  });
  if (!response.ok) throw new Error(`whisper-server inference failed (${response.status})`);
  const json = await response.json() as {
    segments?: readonly {
      text?: string;
      words?: readonly { word?: string; start?: number; end?: number }[];
    }[];
  };
  const text = (json.segments ?? [])
    .map((segment) => (segment.text ?? '').trim())
    .filter(Boolean)
    .join('\n');
  const chunks = whisperWordsToChunks(json.segments?.flatMap((segment) => segment.words ?? []));
  return { text, chunks };
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
    // 1. Persistent whisper-server: model loaded once, Metal by default.
    try {
      const { text, chunks } = await transcribeViaServer(
        engine.ggmlPath, wavPath, whisperLanguage(request.language), signal,
      );
      return {
        requestId: request.requestId,
        backend: engine.backend,
        text,
        chunks,
      };
    } catch {
      // 2. whisper-cli spawn fallback (Metal, then CPU).
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
    }
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

function ggmlPathFor(modelId: string): string | null {
  const fileName = nativeGgmlFileName(modelId);
  if (!fileName) return null;
  const path = join(requireRuntime().cacheDir, 'ggml', fileName);
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
  // Warm the persistent server so the first transcription does not pay the
  // cold model-load cost; failure is non-fatal (transcribe falls back to
  // whisper-cli spawn).
  await ensureWhisperServer(engine.ggmlPath).catch(() => undefined);
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

process.once('exit', () => {
  whisperServer?.child.kill();
});
