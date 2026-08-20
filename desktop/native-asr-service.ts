import { accessSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { isAbsolute } from 'node:path';
import type { UtilityProcess } from 'electron';
import { ASR_MODELS } from '../shared/asr-models.ts';
import { inspectAsrModel } from '../server/plugins/asr-models.ts';
import { ffmpegBin, whisperCliBin } from '../server/media-binaries.ts';
import { resolveUploadFile } from '../server/media-dir.ts';
import {
  isDesktopAsrResponse,
  isDesktopInferenceProgress,
  isDesktopInferenceRequestId,
  isDesktopModelLoadResponse,
  type DesktopAsrPreloadRequest,
  type DesktopAsrRequest,
  type DesktopAsrResponse,
  type DesktopHardwareCapabilities,
  type DesktopInferenceCapabilities,
  type DesktopInferenceProgress,
  type DesktopModelLoadResponse,
} from '../shared/desktop-inference.ts';
import { resolveDesktopInferenceCapabilities } from './native-inference-policy.ts';
import { lowerNativeWorkerPriority } from './native-worker-priority.ts';

const REQUEST_TIMEOUT_MS = 90 * 60_000;
const FORCE_KILL_GRACE_MS = 250;

type NativeAsrServiceResponse = DesktopAsrResponse | DesktopModelLoadResponse;

interface PendingRequest {
  readonly resolve: (value: NativeAsrServiceResponse) => void;
  readonly reject: (reason?: unknown) => void;
  readonly onProgress: (progress: DesktopInferenceProgress) => void;
  readonly timer: NodeJS.Timeout;
}

interface NativeAsrFatalWorkerResult {
  readonly type: 'fatal';
  readonly reason: 'model-load-timeout';
  readonly requestId: string;
  readonly message: string;
}

export interface NativeAsrServiceOptions {
  readonly cacheDir: string;
  readonly platform?: NodeJS.Platform;
  readonly ffmpegPath?: string;
  readonly whisperCliPath?: string;
  readonly transformerRuntime?: boolean;
  readonly hardware?: DesktopHardwareCapabilities;
}

export interface NativeAsrServiceDependencies {
  readonly inspectModel: typeof inspectAsrModel;
  readonly createWorker: () => UtilityProcess;
  readonly resolveSourcePath: (sourcePath: string) => string;
  readonly scheduleForceKill: (callback: () => void, delayMs: number) => () => void;
  readonly forceKillProcess: (pid: number) => void;
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

function resolveNativeAsrSourcePath(sourcePath: string): string {
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

function createNativeAsrWorker(): UtilityProcess {
  const electron = require('electron') as {
    readonly utilityProcess: {
      fork(
        modulePath: string,
        args: readonly string[],
        options: { readonly serviceName: string },
      ): UtilityProcess;
    };
  };
  return electron.utilityProcess.fork(
    fileURLToPath(new URL('./native-asr-worker.mjs', import.meta.url)),
    [],
    { serviceName: 'OpenChatCut Native ASR' },
  );
}

function nativeAsrAbortError(): DOMException {
  return new DOMException('Native ASR request canceled', 'AbortError');
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : nativeAsrAbortError();
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortReason(signal);
}

async function raceWithAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  throwIfAborted(signal);
  const aborted = Promise.withResolvers<never>();
  const onAbort = (): void => aborted.reject(abortReason(signal));
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    return await Promise.race([operation, aborted.promise]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

function isNativeAsrFatalWorkerResult(value: unknown): value is NativeAsrFatalWorkerResult {
  if (typeof value !== 'object' || value === null) return false;
  return Reflect.get(value, 'type') === 'fatal'
    && Reflect.get(value, 'reason') === 'model-load-timeout'
    && isDesktopInferenceRequestId(Reflect.get(value, 'requestId'))
    && typeof Reflect.get(value, 'message') === 'string';
}

export class NativeAsrService {
  private readonly platform: NodeJS.Platform;
  private readonly ffmpegPath: string;
  private readonly whisperCliPath: string;
  private readonly cacheDir: string;
  private readonly capabilities: DesktopInferenceCapabilities;
  private readonly inspectModel: typeof inspectAsrModel;
  private readonly createWorker: () => UtilityProcess;
  private readonly sourcePathResolver: (sourcePath: string) => string;
  private readonly scheduleForceKill: (callback: () => void, delayMs: number) => () => void;
  private readonly forceKillProcess: (pid: number) => void;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly inflight = new Set<string>();
  private readonly abortControllers = new Map<string, AbortController>();
  private readonly retiringWorkers = new Map<UtilityProcess, () => void>();
  private worker: UtilityProcess | null = null;
  private disposed = false;

  constructor(
    options: NativeAsrServiceOptions,
    dependencies: Partial<NativeAsrServiceDependencies> = {},
  ) {
    this.cacheDir = options.cacheDir;
    this.platform = options.platform ?? process.platform;
    this.ffmpegPath = options.ffmpegPath ?? ffmpegBin();
    this.whisperCliPath = options.whisperCliPath ?? whisperCliBin();
    this.capabilities = resolveDesktopInferenceCapabilities({
      platform: this.platform,
      transformerRuntime: options.transformerRuntime ?? transformerRuntimeAvailable(),
      ffmpegRuntime: ffmpegRuntimeAvailable(this.ffmpegPath),
      hardware: options.hardware,
    });
    this.inspectModel = dependencies.inspectModel ?? inspectAsrModel;
    this.createWorker = dependencies.createWorker ?? createNativeAsrWorker;
    this.sourcePathResolver = dependencies.resolveSourcePath ?? resolveNativeAsrSourcePath;
    this.scheduleForceKill = dependencies.scheduleForceKill ?? ((callback, delayMs) => {
      const timer = setTimeout(callback, delayMs);
      return () => clearTimeout(timer);
    });
    this.forceKillProcess = dependencies.forceKillProcess ?? ((pid) => {
      process.kill(pid, 'SIGKILL');
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

  private async ensureModelInstalled(
    request: DesktopAsrRequest | DesktopAsrPreloadRequest,
    signal: AbortSignal,
  ): Promise<void> {
    const model = ASR_MODELS.find((entry) =>
      entry.modelId === request.modelId && entry.revision === request.revision);
    if (!model) throw new Error('native ASR model is not in the verified catalog');
    const installed = await this.inspectModel(model, this.cacheDir, signal);
    if (!installed.downloaded) throw new Error('native ASR model is not installed or failed verification');
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
    const abortController = new AbortController();
    this.inflight.add(request.requestId);
    this.abortControllers.set(request.requestId, abortController);
    try {
      await raceWithAbort(this.ensureModelInstalled(request, abortController.signal), abortController.signal);
      if (this.disposed) throw new Error('native ASR service is disposed');
      throwIfAborted(abortController.signal);
      const workerRequest = 'sourcePath' in request
        ? { ...request, sourcePath: this.sourcePathResolver(request.sourcePath) }
        : request;
      const worker = this.ensureWorker();
      const deferred = Promise.withResolvers<NativeAsrServiceResponse>();
      const timer = setTimeout(
        () => this.failWorker(new Error('native ASR request timed out')),
        REQUEST_TIMEOUT_MS,
      );
      this.pending.set(request.requestId, {
        resolve: deferred.resolve,
        reject: deferred.reject,
        onProgress,
        timer,
      });
      try {
        worker.postMessage(workerRequest);
      } catch (error) {
        this.failWorker(error instanceof Error ? error : new Error(String(error)));
      }
      return await deferred.promise;
    } finally {
      this.inflight.delete(request.requestId);
      this.abortControllers.delete(request.requestId);
    }
  }

  cancel(requestId: string): void {
    if (!isDesktopInferenceRequestId(requestId)) throw new Error('invalid native ASR request id');
    const abortController = this.abortControllers.get(requestId);
    if (!abortController) return;
    const error = nativeAsrAbortError();
    abortController.abort(error);
    if (!this.pending.has(requestId)) return;

    this.settle(requestId, error);
    this.resetWorker();
    const interrupted = new Error('native ASR worker terminated because a request was canceled');
    for (const [pendingRequestId] of this.pending) this.settle(pendingRequestId, interrupted);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const error = new Error('native ASR service is disposed');
    for (const controller of this.abortControllers.values()) controller.abort(error);
    this.failWorker(error);
  }

  private ensureWorker(): UtilityProcess {
    if (this.worker) return this.worker;
    const worker = this.createWorker();
    lowerNativeWorkerPriority(worker);
    worker.on('message', (value: unknown) => {
      if (this.worker === worker) this.handleWorkerMessage(value);
    });
    worker.on('exit', (code) => this.handleWorkerExit(worker, code));
    this.worker = worker;
    try {
      worker.postMessage({
        type: 'initialize',
        config: {
          cacheDir: this.cacheDir,
          platform: this.platform,
          ffmpegPath: this.ffmpegPath,
          whisperCliPath: this.whisperCliPath,
        },
      });
    } catch (error) {
      const reason = error instanceof Error ? error : new Error(String(error));
      this.failWorker(reason);
      throw reason;
    }
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
    if (isNativeAsrFatalWorkerResult(value)) {
      this.failWorker(new Error(value.message));
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

  private handleWorkerExit(worker: UtilityProcess, code: number): void {
    const cancelForceKill = this.retiringWorkers.get(worker);
    if (cancelForceKill) {
      this.retiringWorkers.delete(worker);
      cancelForceKill();
      return;
    }
    if (this.worker !== worker) return;
    this.worker = null;
    this.rejectPending(new Error(`native ASR process exited with code ${code}`));
  }

  private resetWorker(): void {
    const worker = this.worker;
    this.worker = null;
    if (!worker) return;
    const pid = worker.pid;

    this.retiringWorkers.set(worker, () => {});
    try {
      worker.kill();
    } catch {
      // The force-kill deadline below remains authoritative when graceful kill fails.
    }
    if (!this.retiringWorkers.has(worker)) return;
    const cancelForceKill = this.scheduleForceKill(() => {
      if (!this.retiringWorkers.has(worker) || pid === undefined) return;
      try {
        this.forceKillProcess(pid);
      } catch {
        // Exit remains the retirement boundary even if the PID is already gone.
      }
    }, FORCE_KILL_GRACE_MS);
    if (this.retiringWorkers.has(worker)) this.retiringWorkers.set(worker, cancelForceKill);
    else cancelForceKill();
  }

  private rejectPending(error: Error): void {
    for (const [requestId] of this.pending) this.settle(requestId, error);
  }

  private failWorker(error: Error): void {
    this.resetWorker();
    this.rejectPending(error);
  }
}
