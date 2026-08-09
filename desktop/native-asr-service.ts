import { accessSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { isAbsolute } from 'node:path';
import { utilityProcess, type UtilityProcess } from 'electron';
import { ASR_MODELS } from '../shared/asr-models.ts';
import { inspectAsrModel } from '../server/plugins/asr-models.ts';
import { ffmpegBin } from '../server/media-binaries.ts';
import { resolveUploadFile } from '../server/media-dir.ts';
import {
  isDesktopAsrResponse,
  isDesktopInferenceProgress,
  isDesktopInferenceRequestId,
  isDesktopModelLoadResponse,
  type DesktopAsrPreloadRequest,
  type DesktopAsrRequest,
  type DesktopAsrResponse,
  type DesktopInferenceCapabilities,
  type DesktopInferenceProgress,
  type DesktopModelLoadResponse,
} from '../shared/desktop-inference.ts';
import { resolveDesktopInferenceCapabilities } from './native-inference-policy.ts';
import { lowerNativeWorkerPriority } from './native-worker-priority.ts';

const REQUEST_TIMEOUT_MS = 90 * 60_000;

type NativeAsrServiceResponse = DesktopAsrResponse | DesktopModelLoadResponse;

interface PendingRequest {
  readonly resolve: (value: NativeAsrServiceResponse) => void;
  readonly reject: (reason?: unknown) => void;
  readonly onProgress: (progress: DesktopInferenceProgress) => void;
  readonly timer: NodeJS.Timeout;
}

export interface NativeAsrServiceOptions {
  readonly cacheDir: string;
  readonly platform?: NodeJS.Platform;
  readonly ffmpegPath?: string;
  readonly transformerRuntime?: boolean;
}

const require = createRequire(import.meta.url);

function transformerRuntimeAvailable(): boolean {
  try {
    require.resolve('@huggingface/transformers');
    require.resolve('onnxruntime-node');
    return true;
  } catch {
    return false;
  }
}

function ffmpegRuntimeAvailable(path: string): boolean {
  if (!isAbsolute(path)) return true;
  try {
    accessSync(path);
    return true;
  } catch {
    return false;
  }
}

export class NativeAsrService {
  private readonly platform: NodeJS.Platform;
  private readonly ffmpegPath: string;
  private readonly cacheDir: string;
  private readonly capabilities: DesktopInferenceCapabilities;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly inflight = new Set<string>();
  private readonly cancelRequested = new Set<string>();
  private worker: UtilityProcess | null = null;
  private disposed = false;

  constructor(options: NativeAsrServiceOptions) {
    this.cacheDir = options.cacheDir;
    this.platform = options.platform ?? process.platform;
    this.ffmpegPath = options.ffmpegPath ?? ffmpegBin();
    this.capabilities = resolveDesktopInferenceCapabilities({
      platform: this.platform,
      transformerRuntime: options.transformerRuntime ?? transformerRuntimeAvailable(),
      ffmpegRuntime: ffmpegRuntimeAvailable(this.ffmpegPath),
    });
  }

  getCapabilities(): DesktopInferenceCapabilities {
    return this.capabilities;
  }
  async preload(
    request: DesktopAsrPreloadRequest,
    onProgress: (progress: DesktopInferenceProgress) => void = () => {},
  ): Promise<DesktopModelLoadResponse> {
    const response = await this.run(request, onProgress);
    if (!isDesktopModelLoadResponse(response)) throw new Error('native ASR returned an invalid preload response');
    return response;
  }

  async transcribe(
    request: DesktopAsrRequest,
    onProgress: (progress: DesktopInferenceProgress) => void = () => {},
  ): Promise<DesktopAsrResponse> {
    const response = await this.run(request, onProgress);
    if (!isDesktopAsrResponse(response)) throw new Error('native ASR returned an invalid transcription response');
    return response;
  }

  private async ensureModelInstalled(request: DesktopAsrRequest | DesktopAsrPreloadRequest): Promise<void> {
    const model = ASR_MODELS.find((entry) =>
      entry.modelId === request.modelId && entry.revision === request.revision);
    if (!model) throw new Error('native ASR model is not in the verified catalog');
    const installed = await inspectAsrModel(model, this.cacheDir);
    if (!installed.downloaded) throw new Error('native ASR model is not installed or failed verification');
  }

  private resolveSourcePath(sourcePath: string): string {
    const encodedName = sourcePath.slice('/media/uploads/'.length);
    let name: string;
    try {
      name = decodeURIComponent(encodedName);
    } catch {
      throw new Error('native ASR source is invalid');
    }
    const file = resolveUploadFile(name);
    if (!file) throw new Error('native ASR source is not a local uploaded file');
    return file;
  }

  private async run(
    request: DesktopAsrRequest | DesktopAsrPreloadRequest,
    onProgress: (progress: DesktopInferenceProgress) => void,
  ): Promise<NativeAsrServiceResponse> {
    if (this.disposed) throw new Error('native ASR service is disposed');
    if (!this.capabilities.asr.available) {
      throw new Error(this.capabilities.asr.reason ?? 'native ASR is unavailable');
    }
    if (this.inflight.has(request.requestId)) throw new Error('duplicate native ASR request id');
    this.inflight.add(request.requestId);
    try {
      await this.ensureModelInstalled(request);
      if (this.disposed) throw new Error('native ASR service is disposed');
      if (this.cancelRequested.has(request.requestId)) {
        throw new DOMException('Native ASR request canceled', 'AbortError');
      }
      const workerRequest = 'sourcePath' in request
        ? { ...request, sourcePath: this.resolveSourcePath(request.sourcePath) }
        : request;
      const worker = this.ensureWorker();
      return await new Promise<NativeAsrServiceResponse>((resolve, reject) => {
        const timer = setTimeout(
          () => this.failWorker(new Error('native ASR request timed out')),
          REQUEST_TIMEOUT_MS,
        );
        this.pending.set(request.requestId, { resolve, reject, onProgress, timer });
        worker.postMessage(workerRequest);
      });
    } finally {
      this.inflight.delete(request.requestId);
      this.cancelRequested.delete(request.requestId);
    }
  }

  cancel(requestId: string): void {
    if (!isDesktopInferenceRequestId(requestId)) throw new Error('invalid native ASR request id');
    if (!this.inflight.has(requestId)) return;
    this.cancelRequested.add(requestId);
    if (!this.pending.has(requestId)) return;
    try {
      this.worker?.postMessage({ type: 'cancel', requestId });
    } catch (error) {
      this.failWorker(error instanceof Error ? error : new Error(String(error)));
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.failWorker(new Error('native ASR service is disposed'));
  }

  private ensureWorker(): UtilityProcess {
    if (this.worker) return this.worker;
    const worker = utilityProcess.fork(
      fileURLToPath(new URL('./native-asr-worker.mjs', import.meta.url)),
      [],
      { serviceName: 'OpenChatCut Native ASR' },
    );
    lowerNativeWorkerPriority(worker);
    worker.on('message', (value: unknown) => this.handleWorkerMessage(value));
    worker.on('exit', (code) => {
      if (this.worker === worker) {
        this.failWorker(new Error(`native ASR process exited with code ${code}`));
      }
    });
    worker.postMessage({
      type: 'initialize',
      config: {
        cacheDir: this.cacheDir,
        platform: this.platform,
        ffmpegPath: this.ffmpegPath,
      },
    });
    this.worker = worker;
    return worker;
  }

  private handleWorkerMessage(value: unknown): void {
    if (typeof value !== 'object' || value === null) {
      this.failWorker(new Error('invalid native ASR worker response'));
      return;
    }
    const message = value as {
      type?: unknown;
      response?: unknown;
      progress?: unknown;
      requestId?: unknown;
      message?: unknown;
      name?: unknown;
    };
    if (message.type === 'progress' && isDesktopInferenceProgress(message.progress)) {
      this.pending.get(message.progress.requestId)?.onProgress(message.progress);
      return;
    }
    if (message.type === 'result'
      && (isDesktopAsrResponse(message.response) || isDesktopModelLoadResponse(message.response))) {
      this.settle(message.response.requestId, undefined, message.response);
      return;
    }
    if (message.type === 'error' && isDesktopInferenceRequestId(message.requestId)
      && typeof message.message === 'string'
      && (message.name === undefined || message.name === 'Error' || message.name === 'AbortError')) {
      const error = message.name === 'AbortError'
        ? new DOMException(message.message, 'AbortError')
        : new Error(message.message);
      this.settle(message.requestId, error);
      return;
    }
    this.failWorker(new Error('invalid native ASR worker response'));
  }

  private settle(requestId: string, error?: Error, response?: NativeAsrServiceResponse): void {
    const pending = this.pending.get(requestId);
    if (!pending) return;
    this.pending.delete(requestId);
    clearTimeout(pending.timer);
    if (error) pending.reject(error);
    else if (response) pending.resolve(response);
  }

  private resetWorker(): void {
    const worker = this.worker;
    this.worker = null;
    if (worker) worker.kill();
  }

  private failWorker(error: Error): void {
    this.resetWorker();
    for (const [requestId] of this.pending) this.settle(requestId, error);
  }
}
