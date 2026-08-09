/// <reference lib="webworker" />
// On-device whisper ASR worker (transformers.js). WebGPU backend where available
// (Metal/D3D12/Vulkan), wasm fallback. Word-level timestamps via return_timestamps.
// Models are loaded only through the same-origin proxy from immutable catalog revisions.
import { env, pipeline, type AutomaticSpeechRecognitionPipeline } from '@huggingface/transformers';
import type {
  AsrChunk, AsrResult, LocalAsrWorkerRequest, LocalAsrWorkerResponse,
} from './local-asr-types';
import { localAsrLoadError, localAsrModelHosts } from './local-asr-model-source';
import { ASR_INFERENCE_CONTRACT } from '../../shared/asr-inference-contract';

const MAX_AUDIO_SAMPLES = ASR_INFERENCE_CONTRACT.maxAudioSeconds
  * ASR_INFERENCE_CONTRACT.sampleRate;
/**
 * The proxy is the only model source. It enforces the pinned model/revision/file
 * tuple and verifies size and SHA-256 before serving bytes.
 */
/** A model-load attempt may hang on software renderers or dead peers. Fail
 * explicitly instead of switching to any remote host. The long timeout still
 * allows a first-time pinned model download to finish. */
const LOAD_ATTEMPT_TIMEOUT_MS = 15 * 60_000;

type ProgressInfo = { progress?: number; file?: string };

let asr: AutomaticSpeechRecognitionPipeline | null = null;
let loading: Promise<void> | null = null;
const workerScope = self as unknown as DedicatedWorkerGlobalScope;

const post = (message: LocalAsrWorkerResponse) => workerScope.postMessage(message);

// Bypass the browser Cache Storage entirely: transformers.js' own caching
// corrupted large model files after partial/range interactions (observed
// 93004745-byte "ghosts" instead of the real 92324809 → INVALID_PROTOBUF).
// The server proxy disk cache serves the same bytes in milliseconds, so the
// browser-side copy buys nothing but risk.
env.useBrowserCache = false;

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
    env.remoteHost = localAsrModelHosts(workerScope.location.origin)[0];
    try {
      // transformers.js forwards this revision to model, tokenizer, and processor loaders.
      const attemptPromise = (pipeline('automatic-speech-recognition', request.modelId, {
        revision: request.revision,
        device: request.device,
        dtype: ASR_INFERENCE_CONTRACT.dtype,
        progress_callback: progress,
      }) as Promise<unknown>);
      const next = await Promise.race([
        attemptPromise,
        new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error(
            `model load timed out after ${Math.round(LOAD_ATTEMPT_TIMEOUT_MS / 1000)}s`,
          )), LOAD_ATTEMPT_TIMEOUT_MS);
        }),
      ]);
      asr = next as AutomaticSpeechRecognitionPipeline;
    } catch (error) {
      throw localAsrLoadError(error);
    }
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
    throw new Error(`Audio length out of range (${Math.round(n / ASR_INFERENCE_CONTRACT.sampleRate)}s; max ${ASR_INFERENCE_CONTRACT.maxAudioSeconds}s)`);
  }
  const output = await asr(request.samples, {
    return_timestamps: 'word',
    chunk_length_s: ASR_INFERENCE_CONTRACT.chunkSeconds,
    stride_length_s: ASR_INFERENCE_CONTRACT.strideSeconds,
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
    && typeof request.modelId === 'string' && request.modelId.length > 0
    && typeof request.revision === 'string' && /^[a-f0-9]{40}$/.test(request.revision)) {
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
