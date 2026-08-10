import type {} from '../../desktop-api';
import type {
  DesktopInferenceCapabilities,
  DesktopRhythmResponse,
} from '../../../shared/desktop-inference';
import { RHYTHM_INFERENCE_CONTRACT } from '../../../shared/vector-inference-contract';
import { desktopNativeInferenceEnabled } from '../../transcript/desktop-inference-preference';

type BrowserBackend = 'webgpu' | 'wasm';
type BeatThisWorkerRequest = {
  readonly id: number;
  readonly type: 'analyze';
  readonly backend: BrowserBackend;
  readonly samples: Float32Array;
};
type BeatThisWorkerResponse =
  | { readonly id: number; readonly type: 'progress'; readonly progress: number }
  | { readonly id: number; readonly type: 'result'; readonly beat: Float32Array; readonly downbeat: Float32Array }
  | { readonly id: number; readonly type: 'error'; readonly message: string };

type DesktopInferenceBridge = NonNullable<Window['openChatCutDesktop']>['inference'];

let nativeDisabledForSession = false;
let requestSequence = 0;

function browserBeatThisWorker(): Worker {
  return new Worker(new URL('./beatThis.worker.ts', import.meta.url), { type: 'module' });
}

function inferenceBridge(): DesktopInferenceBridge | null {
  if (typeof window === 'undefined') return null;
  const bridge = window.openChatCutDesktop?.inference;
  return bridge && typeof bridge.rhythm === 'function' ? bridge : null;
}

function nativeAvailable(): boolean {
  return !nativeDisabledForSession && desktopNativeInferenceEnabled() && inferenceBridge() !== null;
}

function nextRequestId(): string {
  requestSequence += 1;
  return `rhythm_${Date.now().toString(36)}_${requestSequence.toString(36)}`;
}

function validCapabilities(capabilities: DesktopInferenceCapabilities): boolean {
  return capabilities.version === 3
    && capabilities.rhythm.available
    && capabilities.rhythm.contractId === RHYTHM_INFERENCE_CONTRACT.id;
}

class NativeBeatThisWorkerAdapter {
  onmessage: Worker['onmessage'] = null;
  onmessageerror: Worker['onmessageerror'] = null;
  onerror: Worker['onerror'] = null;
  private fallback: Worker | null = null;
  private nativeRequestId: string | null = null;
  private unsubscribe: (() => void) | null = null;
  private terminated = false;
  private started = false;

  postMessage(value: unknown): void {
    if (this.terminated || this.started) return;
    this.started = true;
    if (!this.isRequest(value)) {
      this.emit({ id: -1, type: 'error', message: 'Invalid Beat This worker request' });
      return;
    }
    if (value.samples.length > RHYTHM_INFERENCE_CONTRACT.sampleRate
      * RHYTHM_INFERENCE_CONTRACT.nativeMaxDurationSeconds) {
      this.startBrowserFallback(value);
      return;
    }
    void this.runNative(value);
  }

  terminate(): void {
    if (this.terminated) return;
    this.terminated = true;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.fallback?.terminate();
    const requestId = this.nativeRequestId;
    this.nativeRequestId = null;
    if (requestId) {
      void inferenceBridge()?.cancel(requestId).catch(() => undefined);
    }
  }

  private isRequest(value: unknown): value is BeatThisWorkerRequest {
    if (typeof value !== 'object' || value === null) return false;
    const request = value as Partial<BeatThisWorkerRequest>;
    return request.type === 'analyze'
      && Number.isSafeInteger(request.id)
      && request.backend !== undefined
      && (request.backend === 'webgpu' || request.backend === 'wasm')
      && request.samples instanceof Float32Array;
  }

  private async runNative(request: BeatThisWorkerRequest): Promise<void> {
    const bridge = inferenceBridge();
    if (!bridge) {
      this.startBrowserFallback(request);
      return;
    }
    const requestId = nextRequestId();
    this.nativeRequestId = requestId;
    try {
      this.unsubscribe = bridge.subscribeProgress((progress) => {
        if (progress.requestId === requestId) {
          this.emit({ id: request.id, type: 'progress', progress: progress.progress ?? 0 });
        }
      });
      const capabilities = await bridge.getCapabilities();
      if (!validCapabilities(capabilities)) throw new Error('native rhythm capability is unavailable');
      if (this.terminated) return;
      const response = await bridge.rhythm({
        requestId,
        contractId: RHYTHM_INFERENCE_CONTRACT.id,
        action: 'analyze',
        samples: request.samples,
        sampleRate: RHYTHM_INFERENCE_CONTRACT.sampleRate,
      });
      this.finishNative(request, requestId, response);
    } catch {
      if (!this.terminated) {
        nativeDisabledForSession = true;
        this.startBrowserFallback(request);
      }
    } finally {
      this.unsubscribe?.();
      this.unsubscribe = null;
      this.nativeRequestId = null;
    }
  }

  private finishNative(
    request: BeatThisWorkerRequest,
    requestId: string,
    response: DesktopRhythmResponse,
  ): void {
    if (this.terminated) return;
    if (response.requestId !== requestId || response.result.type !== 'analysis') {
      throw new Error('native rhythm returned an invalid analysis');
    }
    this.emit({
      id: request.id,
      type: 'result',
      beat: response.result.beat,
      downbeat: response.result.downbeat,
    });
  }

  private startBrowserFallback(request: BeatThisWorkerRequest): void {
    if (this.terminated) return;
    try {
      const worker = browserBeatThisWorker();
      this.fallback = worker;
      worker.onmessage = (event) => this.onmessage?.call(this as unknown as Worker, event);
      worker.onmessageerror = (event) => this.onmessageerror?.call(this as unknown as Worker, event);
      worker.onerror = (event) => this.onerror?.call(this as unknown as Worker, event);
      worker.postMessage(request, [request.samples.buffer]);
    } catch (error) {
      this.emit({
        id: request.id,
        type: 'error',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private emit(response: BeatThisWorkerResponse): void {
    if (this.terminated) return;
    const event = new MessageEvent<BeatThisWorkerResponse>('message', { data: response });
    this.onmessage?.call(this as unknown as Worker, event);
  }
}

export function createBeatThisWorker(): Worker {
  return nativeAvailable()
    ? new NativeBeatThisWorkerAdapter() as unknown as Worker
    : browserBeatThisWorker();
}

export async function warmUpDesktopNativeRhythm(): Promise<void> {
  if (!nativeAvailable()) return;
  const bridge = inferenceBridge();
  if (!bridge) return;
  try {
    const capabilities = await bridge.getCapabilities();
    if (!validCapabilities(capabilities)) return;
    const requestId = nextRequestId();
    const response = await bridge.rhythm({
      requestId,
      contractId: RHYTHM_INFERENCE_CONTRACT.id,
      action: 'load',
    });
    if (response.requestId !== requestId || response.result.type !== 'loaded') {
      throw new Error('native rhythm returned an invalid preload response');
    }
  } catch {
    nativeDisabledForSession = true;
  }
}
