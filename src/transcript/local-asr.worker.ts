/// <reference lib="webworker" />
// On-device whisper ASR worker (transformers.js). WebGPU backend where available
// (Metal/D3D12/Vulkan), wasm fallback. Word-level timestamps via return_timestamps.
// Model source: official Hugging Face first, auto-fallback to hf-mirror.com when
// the LFS CDN is unreachable (common on CN networks).
import { env, pipeline, type AutomaticSpeechRecognitionPipeline } from '@huggingface/transformers';
import type {
  AsrChunk, AsrResult, LocalAsrWorkerRequest, LocalAsrWorkerResponse,
} from './local-asr-types';

const MAX_AUDIO_SAMPLES = 60 * 60 * 16_000; // 60 min of 16 kHz mono
const CHUNK_SECONDS = 30;
const STRIDE_SECONDS = 5;
const DEFAULT_DTYPE = 'q8'; // P0: verify q4 on webgpu; q8 is the stable baseline
/**
 * Model sources, tried in order. The local server proxy (/api/hf-proxy) is a
 * same-origin curl download with a disk cache: no CORS restrictions (hf-mirror
 * redirects are unusable in browsers) and reliable reachability where Node's
 * fetch stack fails. The official host is the last-resort direct fallback.
 */
const OFFICIAL_HOST = 'https://huggingface.co';
/** One model-load attempt may hang (webgpu on software renderers, dead peers);
 *  failing here lets the next host/device attempt proceed instead of stalling
 *  the whole transcription forever. Long enough for a first-time model download
 *  (parallel chunks at ~1.3 MB/s → ~2 min for whisper-small); progress events
 *  keep firing while downloading, only a silent hang hits this bound. */
const LOAD_ATTEMPT_TIMEOUT_MS = 15 * 60_000;

type ProgressInfo = { progress?: number; file?: string };

let asr: AutomaticSpeechRecognitionPipeline | null = null;
let loading: Promise<void> | null = null;
const workerScope = self as unknown as DedicatedWorkerGlobalScope;

const post = (message: LocalAsrWorkerResponse) => workerScope.postMessage(message);

function progressInfo(value: unknown): ProgressInfo {
  if (!value || typeof value !== 'object') return {};
  const record = value as Record<string, unknown>;
  return {
    progress: typeof record.progress === 'number' ? record.progress : undefined,
    file: typeof record.file === 'string' ? record.file : undefined,
  };
}

async function loadModel(request: Extract<LocalAsrWorkerRequest, { type: 'load' }>): Promise<void> {
  if (asr) return;
  if (loading) return loading;
  const progress = (value: unknown) => {
    post({ id: request.id, type: 'progress', ...progressInfo(value) });
  };
  loading = (async () => {
    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      // attempt 0: local proxy; attempt 1: official host directly.
      // transformers.js 3.x path template starts with "/" — no trailing slash.
      env.remoteHost = attempt === 0 ? `${workerScope.location.origin}/api/hf-proxy` : OFFICIAL_HOST;
      try {
        const attemptPromise = (pipeline('automatic-speech-recognition', request.modelId, {
          device: request.device,
          dtype: DEFAULT_DTYPE,
          progress_callback: progress,
        }) as Promise<unknown>);
        const next = await Promise.race([
          attemptPromise,
          new Promise<never>((_, reject) => {
            setTimeout(() => reject(new Error(`model load timed out after ${Math.round(LOAD_ATTEMPT_TIMEOUT_MS / 1000)}s`)), LOAD_ATTEMPT_TIMEOUT_MS);
          }),
        ]);
        asr = next as AutomaticSpeechRecognitionPipeline;
        return;
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError;
  })().finally(() => { loading = null; });
  return loading;
}

interface WhisperWordOutput {
  text: string;
  timestamp?: [number, number] | [null, null];
}

interface WhisperOutput {
  text?: string;
  chunks?: WhisperWordOutput[];
}

function toChunks(output: WhisperOutput): AsrChunk[] {
  const chunks: AsrChunk[] = [];
  for (const chunk of output.chunks ?? []) {
    const text = (chunk.text ?? '').trim();
    if (!text) continue;
    const [start, end] = chunk.timestamp ?? [0, 0];
    if (typeof start !== 'number' || typeof end !== 'number') continue;
    chunks.push({
      text,
      start: Math.round(start * 1000),
      end: Math.round(end * 1000),
    });
  }
  return chunks;
}

async function transcribe(
  request: Extract<LocalAsrWorkerRequest, { type: 'transcribe' }>,
): Promise<AsrResult> {
  if (!asr) throw new Error('Local ASR model is not loaded');
  if (!(request.samples instanceof Float32Array)) throw new Error('Invalid audio samples');
  const n = request.samples.length;
  if (n === 0 || n > MAX_AUDIO_SAMPLES) {
    throw new Error(`Audio length out of range (${Math.round(n / 16_000)}s; max 3600s)`);
  }
  const output = await asr(request.samples, {
    return_timestamps: 'word',
    chunk_length_s: CHUNK_SECONDS,
    stride_length_s: STRIDE_SECONDS,
    language: request.language,
  }) as unknown as WhisperOutput;
  return { text: output.text ?? '', chunks: toChunks(output) };
}

function validateRequest(value: unknown): LocalAsrWorkerRequest {
  if (!value || typeof value !== 'object') throw new Error('Invalid local ASR worker request');
  const request = value as Record<string, unknown>;
  if (!Number.isSafeInteger(request.id) || (request.id as number) < 0) {
    throw new Error('Invalid local ASR worker request id');
  }
  if (request.type === 'load'
    && (request.device === 'webgpu' || request.device === 'wasm')
    && typeof request.modelId === 'string' && request.modelId.length > 0) {
    return request as LocalAsrWorkerRequest;
  }
  if (request.type === 'transcribe'
    && request.samples instanceof Float32Array
    && typeof request.language === 'string' && request.language.length > 0) {
    return request as LocalAsrWorkerRequest;
  }
  throw new Error('Invalid local ASR worker request payload');
}

async function handleRequest(value: unknown): Promise<void> {
  const request = validateRequest(value);
  if (request.type === 'load') {
    await loadModel(request);
    post({ id: request.id, type: 'result', result: { text: '', chunks: [] } });
    return;
  }
  post({ id: request.id, type: 'result', result: await transcribe(request) });
}

workerScope.onmessage = (event: MessageEvent<unknown>) => {
  void handleRequest(event.data).catch((reason: unknown) => {
    const message = reason instanceof Error ? reason.message : String(reason);
    const raw = event.data as { id?: unknown } | null;
    const id = raw && Number.isInteger(raw.id) ? Number(raw.id) : -1;
    post({ id, type: 'error', message });
  });
};
