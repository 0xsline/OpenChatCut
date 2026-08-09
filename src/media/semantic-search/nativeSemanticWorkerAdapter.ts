import {
  isDesktopInferenceProgress,
  isDesktopSemanticResponse,
  type DesktopInferenceProgress,
  type DesktopSemanticRequest,
  type DesktopSemanticResponse,
} from '../../../shared/desktop-inference';
import { SEMANTIC_INFERENCE_CONTRACT } from '../../../shared/vector-inference-contract';
import { desktopNativeInferenceEnabled } from '../../transcript/desktop-inference-preference';
import type {
  SemanticDevice, WorkerRequest, WorkerResponse, WorkerResult,
} from './types';

export const DESKTOP_NATIVE_SEMANTIC_READY_KEY = 'cc.desktopNativeSemanticReady';

interface DesktopSemanticApi {
  semantic(request: DesktopSemanticRequest): Promise<DesktopSemanticResponse>;
  cancel(requestId: string): Promise<void>;
  subscribeProgress(listener: (progress: DesktopInferenceProgress) => void): () => void;
}

interface PendingAdapterRequest {
  readonly request: WorkerRequest;
  readonly transfer: Transferable[];
}

type AdapterMode = 'native' | 'starting-browser' | 'browser' | 'terminated';

let nativeSemanticAvailable = true;
let nativeRequestSequence = 0;

function desktopSemanticApi(): DesktopSemanticApi | null {
  if (typeof window === 'undefined') return null;
  const desktop = window.openChatCutDesktop as typeof window.openChatCutDesktop & {
    inference?: Partial<DesktopSemanticApi>;
  };
  const inference = desktop?.inference;
  if (typeof inference?.semantic !== 'function'
    || typeof inference.cancel !== 'function'
    || typeof inference.subscribeProgress !== 'function') return null;
  return inference as DesktopSemanticApi;
}

function toDesktopRequest(request: WorkerRequest, requestId: string): DesktopSemanticRequest {
  const common = { requestId, contractId: SEMANTIC_INFERENCE_CONTRACT.id } as const;
  if (request.type === 'load') return { ...common, action: 'load' };
  if (request.type === 'embed-text') return { ...common, action: 'embed-text', text: request.text };
  if (request.type === 'embed-image') {
    const { data, width, height } = request.frame;
    return { ...common, action: 'embed-image', frame: { data, width, height } };
  }
  return {
    ...common,
    action: 'find-duplicates',
    threshold: request.threshold,
    vectors: request.vectors,
  };
}

function toWorkerResult(response: DesktopSemanticResponse): WorkerResult {
  if (response.result.type === 'loaded') return { type: 'loaded' };
  if (response.result.type === 'embedding') {
    return { type: 'embedding', vector: [...response.result.vector] };
  }
  return {
    type: 'duplicates',
    matches: response.result.matches.map((match) => ({ ...match })),
  };
}

function markNativeSemanticReady(): void {
  try {
    globalThis.localStorage?.setItem(
      DESKTOP_NATIVE_SEMANTIC_READY_KEY,
      SEMANTIC_INFERENCE_CONTRACT.id,
    );
  } catch {
    // Native inference remains usable when renderer storage is unavailable.
  }
}
function nativeSemanticWasReady(): boolean {
  try {
    return globalThis.localStorage?.getItem(DESKTOP_NATIVE_SEMANTIC_READY_KEY)
      === SEMANTIC_INFERENCE_CONTRACT.id;
  } catch {
    return false;
  }
}

export async function warmUpDesktopNativeSemantic(): Promise<boolean> {
  if (!nativeSemanticAvailable || !desktopNativeInferenceEnabled() || !nativeSemanticWasReady()) {
    return false;
  }
  const api = desktopSemanticApi();
  if (!api) return false;
  nativeRequestSequence += 1;
  const requestId = `semantic_warm_${Date.now().toString(36)}_${nativeRequestSequence.toString(36)}`;
  try {
    const response = await api.semantic({
      requestId,
      contractId: SEMANTIC_INFERENCE_CONTRACT.id,
      action: 'load',
    });
    if (!isDesktopSemanticResponse(response)
      || response.requestId !== requestId
      || response.result.type !== 'loaded') {
      throw new Error('Desktop semantic API returned an invalid preload response');
    }
    markNativeSemanticReady();
    return true;
  } catch {
    nativeSemanticAvailable = false;
    return false;
  }
}

class NativeSemanticWorkerAdapter {
  onmessage: Worker['onmessage'] = null;
  onerror: Worker['onerror'] = null;
  private readonly api: DesktopSemanticApi;
  private readonly nativePending = new Map<string, PendingAdapterRequest>();
  private unsubscribeProgress: (() => void) | null;
  private browserWorker: Worker | null = null;
  private browserQueue: PendingAdapterRequest[] = [];
  private replayAfterBootstrap: PendingAdapterRequest[] = [];
  private bootstrapId: number | null = null;
  private bootstrapDevice: SemanticDevice | null = null;
  private lastDevice: SemanticDevice | null = null;
  private mode: AdapterMode = 'native';

  constructor(api: DesktopSemanticApi) {
    this.api = api;
    this.unsubscribeProgress = api.subscribeProgress((progress) => this.handleProgress(progress));
  }

  postMessage(value: unknown, transfer: Transferable[] = []): void {
    if (this.mode === 'terminated') {
      throw new DOMException('Semantic worker is terminated', 'InvalidStateError');
    }
    const request = value as WorkerRequest;
    if (!request || !Number.isSafeInteger(request.id) || typeof request.type !== 'string') {
      throw new Error('Invalid native semantic adapter request');
    }
    if (request.type === 'load') this.lastDevice = request.device;
    const pending = { request, transfer: [...transfer] };
    if (this.mode === 'native' && desktopNativeInferenceEnabled()) this.sendNative(pending);
    else if (this.mode === 'native') this.disableNative(pending);
    else if (this.mode === 'starting-browser') this.browserQueue.push(pending);
    else this.postToBrowser(pending);
  }

  terminate(): void {
    if (this.mode === 'terminated') return;
    this.mode = 'terminated';
    this.stopNativeProgress();
    for (const requestId of this.nativePending.keys()) {
      void this.api.cancel(requestId).catch(() => undefined);
    }
    this.nativePending.clear();
    this.browserQueue = [];
    this.replayAfterBootstrap = [];
    this.browserWorker?.terminate();
    this.browserWorker = null;
  }

  private sendNative(pending: PendingAdapterRequest): void {
    nativeRequestSequence += 1;
    const requestId = `semantic_${Date.now().toString(36)}_${nativeRequestSequence.toString(36)}_${pending.request.id}`;
    this.nativePending.set(requestId, pending);
    try {
      void this.api.semantic(toDesktopRequest(pending.request, requestId))
        .then(
          (response) => this.handleNativeResponse(requestId, response),
          (reason) => this.failNative(reason),
        );
    } catch (reason) {
      this.failNative(reason);
    }
  }

  private handleProgress(progress: DesktopInferenceProgress): void {
    if (this.mode !== 'native' || !isDesktopInferenceProgress(progress)) return;
    const pending = this.nativePending.get(progress.requestId);
    if (!pending) return;
    this.emit({
      id: pending.request.id,
      type: 'progress',
      ...(progress.progress === undefined ? {} : { progress: progress.progress }),
      ...(progress.file === undefined ? {} : { file: progress.file }),
    });
  }

  private handleNativeResponse(requestId: string, response: DesktopSemanticResponse): void {
    if (this.mode !== 'native') return;
    const pending = this.nativePending.get(requestId);
    if (!pending) return;
    if (!isDesktopSemanticResponse(response)
      || response.requestId !== requestId
      || !this.responseMatches(pending.request, response)) {
      this.failNative(new Error('Desktop semantic API returned an invalid response'));
      return;
    }
    this.nativePending.delete(requestId);
    if (pending.request.type === 'load') markNativeSemanticReady();
    this.emit({ id: pending.request.id, type: 'result', result: toWorkerResult(response) });
  }

  private responseMatches(request: WorkerRequest, response: DesktopSemanticResponse): boolean {
    if (request.type === 'load') return response.result.type === 'loaded';
    if (request.type === 'find-duplicates') return response.result.type === 'duplicates';
    return response.result.type === 'embedding';
  }

  private disableNative(pending: PendingAdapterRequest): void {
    const replay = [...this.nativePending.values(), pending];
    const requestIds = [...this.nativePending.keys()];
    this.nativePending.clear();
    this.stopNativeProgress();
    for (const requestId of requestIds) void this.api.cancel(requestId).catch(() => undefined);
    this.startBrowserFallback(replay);
  }

  private failNative(_reason: unknown): void {
    if (this.mode !== 'native') return;
    nativeSemanticAvailable = false;
    const replay = [...this.nativePending.values()];
    const requestIds = [...this.nativePending.keys()];
    this.nativePending.clear();
    this.stopNativeProgress();
    for (const requestId of requestIds) void this.api.cancel(requestId).catch(() => undefined);
    this.startBrowserFallback(replay);
  }

  private startBrowserFallback(replay: PendingAdapterRequest[]): void {
    const requiresModel = replay.some(({ request }) => request.type !== 'find-duplicates');
    if (!requiresModel) {
      this.activateBrowser(replay);
      return;
    }
    const hasLoadRequest = replay.some(({ request }) => request.type === 'load');
    if (hasLoadRequest || !this.lastDevice) {
      this.activateBrowser(replay);
      return;
    }
    this.replayAfterBootstrap = replay;
    this.launchBootstrap(this.lastDevice);
  }

  private launchBootstrap(device: SemanticDevice): void {
    this.mode = 'starting-browser';
    this.bootstrapDevice = device;
    this.bootstrapId = Number.MAX_SAFE_INTEGER;
    this.browserWorker?.terminate();
    try {
      this.browserWorker = this.createBrowserWorker();
      this.browserWorker.postMessage({ id: this.bootstrapId, type: 'load', device });
    } catch (reason) {
      if (device === 'webgpu') this.launchBootstrap('wasm');
      else this.failBrowser(reason);
    }
  }

  private activateBrowser(initial: PendingAdapterRequest[]): void {
    try {
      if (!this.browserWorker) this.browserWorker = this.createBrowserWorker();
      this.mode = 'browser';
      const queued = [...initial, ...this.browserQueue];
      this.browserQueue = [];
      this.replayAfterBootstrap = [];
      for (const pending of queued) this.postToBrowser(pending);
    } catch (reason) {
      this.failBrowser(reason);
    }
  }

  private createBrowserWorker(): Worker {
    const worker = new Worker(new URL('./semantic.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (event: MessageEvent<unknown>) => this.handleBrowserMessage(worker, event.data);
    worker.onerror = (event) => this.handleBrowserError(worker, event);
    return worker;
  }

  private handleBrowserMessage(worker: Worker, value: unknown): void {
    if (this.browserWorker !== worker || this.mode === 'terminated') return;
    const response = value as {
      id?: unknown;
      type?: unknown;
      result?: { type?: unknown };
      message?: unknown;
    };
    if (this.mode !== 'starting-browser') {
      if (response.type === 'result' && response.result?.type === 'loaded') {
        markNativeSemanticReady();
      }
      this.onmessage?.call(this as unknown as Worker, { data: value } as MessageEvent<unknown>);
      return;
    }
    if (response.id !== this.bootstrapId || response.type === 'progress') return;
    if (response.type === 'result' && response.result?.type === 'loaded') {
      markNativeSemanticReady();
      this.bootstrapId = null;
      this.bootstrapDevice = null;
      this.activateBrowser(this.replayAfterBootstrap);
      return;
    }
    const message = response.type === 'error' && typeof response.message === 'string'
      ? response.message
      : 'Semantic browser bootstrap failed';
    this.retryBootstrapOrFail(new Error(message));
  }

  private handleBrowserError(worker: Worker, event: ErrorEvent): void {
    if (this.browserWorker !== worker || this.mode === 'terminated') return;
    if (this.mode === 'starting-browser') {
      this.retryBootstrapOrFail(new Error(event.message || 'Semantic browser bootstrap failed'));
      return;
    }
    this.onerror?.call(this as unknown as Worker, event);
  }

  private retryBootstrapOrFail(reason: Error): void {
    if (this.bootstrapDevice === 'webgpu') {
      this.launchBootstrap('wasm');
      return;
    }
    this.failBrowser(reason);
  }

  private postToBrowser(pending: PendingAdapterRequest): void {
    if (!this.browserWorker) throw new Error('Semantic browser fallback is unavailable');
    this.browserWorker.postMessage(pending.request, pending.transfer);
  }

  private failBrowser(reason: unknown): void {
    if (this.mode === 'terminated') return;
    const error = reason instanceof Error ? reason : new Error(String(reason));
    const onerror = this.onerror;
    if (onerror) onerror.call(this as unknown as Worker, { message: error.message } as ErrorEvent);
    else this.terminate();
  }

  private stopNativeProgress(): void {
    this.unsubscribeProgress?.();
    this.unsubscribeProgress = null;
  }

  private emit(response: WorkerResponse): void {
    this.onmessage?.call(
      this as unknown as Worker,
      { data: response } as MessageEvent<WorkerResponse>,
    );
  }
}

export function createNativeSemanticWorkerAdapter(): Worker | null {
  if (!nativeSemanticAvailable || !desktopNativeInferenceEnabled()) return null;
  const api = desktopSemanticApi();
  if (!api) return null;
  try {
    return new NativeSemanticWorkerAdapter(api) as unknown as Worker;
  } catch {
    nativeSemanticAvailable = false;
    return null;
  }
}
