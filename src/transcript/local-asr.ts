// On-device ASR transcriber (whisper via transformers.js in a WebWorker).
// Reuses the shared audio-extract pipeline (/api/extract-audio → 16 kHz mono);
// the worker picks backend + model tier per device profile (WebGPU on
// Metal/D3D12/Vulkan, wasm fallback). No uploads, no API key, offline-capable.
import type { TranscriptResult } from './types';
import type { AsrConfig, AsrResult, AsrDevice, LocalAsrWorkerResponse } from './local-asr-types';
import { chooseAsrConfig, detectDeviceProfile, markAsrWebgpuBroken } from './deviceProfile';
import {
  TranscriptionError, transcriptionSourceForPath,
  type AssemblyAiCheckpointWriter, type AssemblyAiResumeCheckpoint, type TranscribeOptions,
} from './assemblyai';
import { downsampleMono } from './client-asr-extract';
import { ASR_INFERENCE_CONTRACT } from '../../shared/asr-inference-contract';
import { tryDesktopNativeAsr, warmUpDesktopNativeAsr } from './desktop-native-asr';
import { desktopNativeInferenceEnabled } from './desktop-inference-preference';

const TARGET_SR = ASR_INFERENCE_CONTRACT.sampleRate;
/** WebGPU load can hang on software renderers (headless/SwiftShader); force-fail
 *  so ensureLoaded falls back to wasm instead of stalling transcription forever. */
const WASM_LOAD_TIMEOUT_MS = 120_000;
const WEBGPU_LOAD_TIMEOUT_MS = 90_000;

type Pending = {
  resolve: (result: AsrResult) => void;
  reject: (reason?: unknown) => void;
};

type ProgressListener = (progress?: number, file?: string) => void;

/** Local checkpoint reuses the cloud shape; uploadUrl is simply never written. */
type LocalAsrCheckpoint = AssemblyAiResumeCheckpoint;
type LocalAsrCheckpointWriter = AssemblyAiCheckpointWriter;

type ClientAsrRequest =
  | { type: 'load'; device: AsrDevice; modelId: string; revision: string }
  | { type: 'transcribe'; samples: Float32Array; language: string };

let sharedClient: LocalAsrClient | null = null;

export class LocalAsrClient {
  private worker: Worker | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  /** Requested load key; the actual backend may be wasm after a WebGPU fallback. */
  private config: AsrConfig | null = null;
  private loading: Promise<void> | null = null;
  private onProgress: ProgressListener = () => {};

  attachProgress(listener: ProgressListener): void {
    this.onProgress = listener;
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    this.worker = new Worker(new URL('./local-asr.worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (event: MessageEvent<LocalAsrWorkerResponse>) => {
      const message = event.data;
      if (message.type === 'progress') {
        this.onProgress(message.progress, message.file);
        return;
      }
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.type === 'error') {
        pending.reject(new Error(message.message));
      } else if (message.type === 'result') {
        pending.resolve(message.result);
      }
      // progress messages carry no id-specific result; ignored here.
    };
    this.worker.onerror = (event) => {
      for (const pending of this.pending.values()) pending.reject(new Error(event.message || 'Local ASR worker crashed'));
      this.pending.clear();
      this.worker?.terminate();
      this.worker = null;
    };
    return this.worker;
  }

  private request(request: ClientAsrRequest, timeoutMs?: number): Promise<AsrResult> {
    const worker = this.ensureWorker();
    const id = this.nextId++;
    return new Promise<AsrResult>((resolve, reject) => {
      const timer = timeoutMs
        ? setTimeout(() => {
          this.pending.delete(id);
          reject(new Error(`Local ASR ${request.type} timed out after ${Math.round(timeoutMs / 1000)}s`));
        }, timeoutMs)
        : null;
      const settle = (fn: () => void): void => {
        if (timer) clearTimeout(timer);
        fn();
      };
      this.pending.set(id, {
        resolve: (result) => settle(() => resolve(result)),
        reject: (reason) => settle(() => reject(reason)),
      });
      worker.postMessage({ ...request, id });
    });
  }

  /** Load the requested model after any in-flight warm-up finishes. */
  async ensureLoaded(config: AsrConfig): Promise<void> {
    while (this.loading) await this.loading;
    if (this.config?.device === config.device
      && this.config.modelId === config.modelId
      && this.config.revision === config.revision) return;
    if (this.worker) this.dispose();

    const loading = (async () => {
      try {
        await this.request(
          {
            type: 'load',
            device: config.device,
            modelId: config.modelId,
            revision: config.revision,
          },
          config.device === 'webgpu' ? WEBGPU_LOAD_TIMEOUT_MS
            : config.device === 'wasm' ? WASM_LOAD_TIMEOUT_MS : undefined,
        );
        this.config = config;
      } catch (webgpuError) {
        if (config.device !== 'webgpu') throw webgpuError;
        // A half-initialized WebGPU session can corrupt the wasm fallback.
        this.dispose();
        const fallback: AsrConfig = { ...config, device: 'wasm' };
        await this.request({
          type: 'load',
          device: 'wasm',
          modelId: fallback.modelId,
          revision: fallback.revision,
        }, WASM_LOAD_TIMEOUT_MS);
        this.config = config;
      }
    })();
    this.loading = loading;
    try {
      await loading;
    } finally {
      if (this.loading === loading) this.loading = null;
    }
  }

  async transcribe(samples: Float32Array, language: string): Promise<AsrResult> {
    const result = await this.request({ type: 'transcribe', samples, language });
    // A WebGPU session that yields an empty transcript is silently broken
    // (measured: encoder fp16 on Metal/WebGPU); remember it and retry on wasm
    // once so the user still gets their transcript this run.
    if (this.config?.device === 'webgpu' && !result.text && result.chunks.length === 0) {
      markAsrWebgpuBroken();
      const fallback: AsrConfig = { ...this.config, device: 'wasm' };
      this.dispose();
      await this.ensureLoaded(fallback);
      return this.request({ type: 'transcribe', samples, language });
    }
    return result;
  }

  dispose(): void {
    this.worker?.terminate();
    this.worker = null;
    this.config = null;
    for (const pending of this.pending.values()) {
      pending.reject(new Error('Local ASR worker disposed'));
    }
    this.pending.clear();
  }
}

function getSharedClient(): LocalAsrClient {
  if (!sharedClient) sharedClient = new LocalAsrClient();
  return sharedClient;
}

/** Fetch a same-origin media path as 16 kHz mono Float32 samples. */
async function decodeSourceToSamples(path: string): Promise<Float32Array> {
  let response: Response;
  try {
    // no-store: transcription must read the latest bytes on disk; a stale http
    // cache entry would transcribe an outdated version of the source.
    response = await fetch(path, { cache: 'no-store' });
  } catch (error) {
    throw new TranscriptionError('source-unavailable', error instanceof Error ? error.message : String(error));
  }
  if (!response.ok) throw new TranscriptionError('source-unavailable', `HTTP ${response.status}`);
  const AC = typeof AudioContext !== 'undefined'
    ? AudioContext
    : (globalThis as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AC) throw new TranscriptionError('service-unavailable', 'WebAudio is unavailable');
  const context = new AC();
  try {
    const arrayBuffer = await response.arrayBuffer();
    const decoded = await context.decodeAudioData(arrayBuffer);
    const mono = downsampleMono(decoded, TARGET_SR);
    if (mono.length > ASR_INFERENCE_CONTRACT.maxAudioSeconds * TARGET_SR) {
      throw new TranscriptionError(
        'service-unavailable',
        `audio exceeds ${ASR_INFERENCE_CONTRACT.maxAudioSeconds}s local ASR limit`,
      );
    }
    return mono;
  } finally {
    void context.close().catch(() => undefined);
  }
}

function toTranscriptResult(result: AsrResult): TranscriptResult {
  const words = result.chunks.map((chunk) => ({
    text: chunk.text,
    start: chunk.start,
    end: Math.max(chunk.start + 1, chunk.end),
    speaker: null,
  }));
  const text = result.text || words.map((word) => word.text).join('');
  const utterances = words.length
    ? [{ speaker: 'A', text, start: words[0]!.start, end: words[words.length - 1]!.end, words }]
    : [];
  return { text, words, utterances };
}

function reportModelProgress(
  onWait: ((note?: string) => void) | undefined,
  progress?: number,
  file?: string,
): void {
  if (progress != null) onWait?.(`模型下载 ${Math.min(100, Math.round(progress))}%`);
  else if (file) onWait?.(`加载模型 ${file.split('/').pop() ?? ''}`);
}

/** Transcribe a same-origin media path with the on-device model. */
/**
 * Refuse to transcribe with a partially downloaded model. A model whose
 * files are incomplete can load into a broken state and produce hallucinated
 * repeated text instead of failing; the server-side catalog reports the
 * sha-verified downloaded state (ONNX tier + GGML companion), so check it
 * before any local engine runs. Server unreachable or unknown model id does
 * not block (the worker layer still surfaces real load errors).
 */
export async function assertAsrModelDownloaded(config: AsrConfig): Promise<void> {
  try {
    const response = await fetch('/api/asr-models', { cache: 'no-store' });
    if (!response.ok) return;
    const catalog = await response.json() as {
      models?: readonly { modelId?: string; downloaded?: boolean }[];
    };
    const entry = catalog.models?.find((model) => model.modelId === config.modelId);
    if (entry && entry.downloaded === false) {
      throw new TranscriptionError(
        'service-unavailable',
        `本地转写模型未完整下载（${config.modelId}）。请到 设置 → 转写 → 本地模型 重新下载后再试。`,
      );
    }
  } catch (error) {
    if (error instanceof TranscriptionError) throw error;
    // Catalog unavailable: let the worker surface the load error.
  }
}

export async function localTranscribePathResumable(
  path: string,
  resume: LocalAsrCheckpoint = {},
  onCheckpoint: LocalAsrCheckpointWriter = () => {},
  onWait?: (note?: string) => void,
  opts: TranscribeOptions = {},
): Promise<TranscriptResult> {
  const providerJobId = resume.providerJobId ?? `local:${Date.now().toString(36)}`;
  const checkpoint: LocalAsrCheckpoint = { ...resume, providerJobId, providerStatus: 'processing' };
  await onCheckpoint(checkpoint);
  onWait?.();

  const profile = await detectDeviceProfile();
  const config = chooseAsrConfig(profile);
  await assertAsrModelDownloaded(config);
  let source: string | undefined;
  if (desktopNativeInferenceEnabled()) {
    source = await transcriptionSourceForPath(path, opts);
    const native = await tryDesktopNativeAsr({
      sourcePath: source,
      config,
      language: opts.languageCode ?? 'zh',
      onProgress: (progress, file) => reportModelProgress(onWait, progress, file),
      onFallback: () => onWait?.('桌面原生推理不可用，已回退浏览器引擎'),
    });
    if (native) {
      await onCheckpoint({ ...checkpoint, providerStatus: 'completed' });
      return toTranscriptResult(native.result);
    }
  }
  const client = getSharedClient();
  client.attachProgress((progress, file) => reportModelProgress(onWait, progress, file));
  await client.ensureLoaded(config);
  await onCheckpoint({ ...checkpoint, providerStatus: 'processing' });

  source ??= await transcriptionSourceForPath(path, opts);
  const samples = await decodeSourceToSamples(source);
  const result = await client.transcribe(samples, opts.languageCode ?? 'zh');
  await onCheckpoint({ ...checkpoint, providerStatus: 'completed' });
  return toTranscriptResult(result);
}

export async function localTranscribePath(
  path: string,
  onWait?: () => void,
  opts: TranscribeOptions = {},
): Promise<TranscriptResult> {
  return localTranscribePathResumable(path, {}, () => {}, onWait, opts);
}

/** Test seam: drop the shared worker (used by checks; not part of the app flow). */
export function __resetLocalAsrClient(): void {
  sharedClient?.dispose();
  sharedClient = null;
}

async function fetchDownloadedModelIds(): Promise<string[]> {
  const body: unknown = await fetch('/api/asr-models', { cache: 'no-store' })
    .then((response) => (response.ok ? response.json() : null))
    .catch(() => null);
  if (typeof body !== 'object' || body === null || !('models' in body)
    || !Array.isArray(body.models)) return [];
  return body.models.flatMap((model): string[] => {
    if (typeof model !== 'object' || model === null
      || !('downloaded' in model) || model.downloaded !== true
      || !('modelId' in model) || typeof model.modelId !== 'string') return [];
    return [model.modelId];
  });
}

/**
 * Initialize an already-downloaded model in the desktop utility process or
 * browser worker. Failures stay silent; a real transcription reports them.
 */
export async function warmUpLocalAsr(downloadedModelIds?: readonly string[]): Promise<void> {
  try {
    const profile = await detectDeviceProfile();
    const config = chooseAsrConfig(profile);
    const available = downloadedModelIds ?? await fetchDownloadedModelIds();
    if (!available.includes(config.modelId)) return;
    if (await warmUpDesktopNativeAsr(config)) return;
    await getSharedClient().ensureLoaded(config);
  } catch {
    // Best-effort only.
  }
}
