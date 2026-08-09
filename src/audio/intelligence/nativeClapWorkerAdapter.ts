import {
  isDesktopClapResponse,
  isDesktopInferenceProgress,
  type DesktopClapRequest,
  type DesktopClapResponse,
  type DesktopInferenceProgress,
} from '../../../shared/desktop-inference';
import { CLAP_INFERENCE_CONTRACT } from '../../../shared/vector-inference-contract';
import { desktopNativeInferenceEnabled } from '../../transcript/desktop-inference-preference';
import {
  CLAP_SAMPLE_RATE,
  type ClapWorkerRequest,
  type ClapWorkerResponse,
  type ClapWorkerResult,
} from './clapTypes';

interface DesktopClapApi {
  clap(request: DesktopClapRequest): Promise<DesktopClapResponse>;
  cancel(requestId: string): Promise<void>;
  subscribeProgress(listener: (progress: DesktopInferenceProgress) => void): () => void;
}

let nativeClapAvailable = true;
let requestSequence = 0;
const nativeClapWorkers = new WeakSet<Worker>();

export function createNativeClapWorker(): Worker | null {
  if (!nativeClapAvailable || !desktopNativeInferenceEnabled() || typeof window === 'undefined') return null;
  const inference = window.openChatCutDesktop?.inference as unknown as Partial<DesktopClapApi> | undefined;
  if (typeof inference?.clap !== 'function'
    || typeof inference.cancel !== 'function'
    || typeof inference.subscribeProgress !== 'function') return null;
  try {
    const worker = new NativeClapWorkerAdapter(inference as DesktopClapApi) as unknown as Worker;
    nativeClapWorkers.add(worker);
    return worker;
  } catch {
    nativeClapAvailable = false;
    return null;
  }
}

export function markNativeClapWorkerFailed(worker: Worker, reason: unknown): void {
  if (typeof reason === 'object' && reason !== null && Reflect.get(reason, 'name') === 'AbortError') return;
  if (nativeClapWorkers.has(worker)) nativeClapAvailable = false;
}
export async function warmUpDesktopNativeClap(): Promise<boolean> {
  if (!nativeClapAvailable || !desktopNativeInferenceEnabled() || typeof window === 'undefined') {
    return false;
  }
  const inference = window.openChatCutDesktop?.inference as unknown as Partial<DesktopClapApi> | undefined;
  if (typeof inference?.clap !== 'function') return false;
  const requestId = nextDesktopRequestId();
  try {
    const response = await inference.clap({
      requestId,
      contractId: CLAP_INFERENCE_CONTRACT.id,
      action: 'load',
    });
    if (!isDesktopClapResponse(response)
      || response.requestId !== requestId
      || response.result.type !== 'loaded') {
      throw new Error('native CLAP returned an invalid preload response');
    }
    return true;
  } catch {
    nativeClapAvailable = false;
    return false;
  }
}

class NativeClapWorkerAdapter {
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;

  private readonly active = new Map<string, number>();
  private readonly api: DesktopClapApi;
  private readonly unsubscribe: () => void;
  private terminated = false;

  constructor(api: DesktopClapApi) {
    this.api = api;
    this.unsubscribe = api.subscribeProgress((progress) => this.handleProgress(progress));
  }

  postMessage(value: unknown, _transfer?: Transferable[]): void {
    let request: ClapWorkerRequest;
    try {
      request = parseWorkerRequest(value);
    } catch (error) {
      const id = workerRequestId(value);
      queueMicrotask(() => this.post({
        id,
        type: 'error',
        message: error instanceof Error ? error.message : String(error),
      }));
      return;
    }
    if (this.terminated) return;
    void this.send(request);
  }

  terminate(): void {
    if (this.terminated) return;
    this.terminated = true;
    this.unsubscribe();
    const requestIds = [...this.active.keys()];
    this.active.clear();
    for (const requestId of requestIds) void this.api.cancel(requestId).catch(() => {});
  }

  private async send(request: ClapWorkerRequest): Promise<void> {
    const requestId = nextDesktopRequestId();
    this.active.set(requestId, request.id);
    const desktopRequest: DesktopClapRequest = request.type === 'load'
      ? { requestId, contractId: CLAP_INFERENCE_CONTRACT.id, action: 'load' }
      : {
          requestId,
          contractId: CLAP_INFERENCE_CONTRACT.id,
          action: 'embed',
          samples: request.samples,
          sampleRate: CLAP_SAMPLE_RATE,
        };
    try {
      const response = await this.api.clap(desktopRequest);
      if (this.terminated || !this.active.has(requestId)) return;
      this.post({ id: request.id, type: 'result', result: workerResult(request, requestId, response) });
    } catch (error) {
      if (this.terminated || !this.active.has(requestId)) return;
      nativeClapAvailable = false;
      this.post({
        id: request.id,
        type: 'error',
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.active.delete(requestId);
    }
  }

  private handleProgress(value: unknown): void {
    if (!isDesktopInferenceProgress(value)) {
      this.failActive(new Error('native CLAP returned invalid progress'));
      return;
    }
    const id = this.active.get(value.requestId);
    if (id === undefined || value.progress === undefined || this.terminated) return;
    if (value.progress < 0 || value.progress > 1) {
      this.failActive(new Error('native CLAP returned out-of-range progress'));
      return;
    }
    this.post({ id, type: 'progress', progress: value.progress });
  }

  private failActive(error: Error): void {
    nativeClapAvailable = false;
    const active = [...this.active];
    this.active.clear();
    for (const [requestId, id] of active) {
      void this.api.cancel(requestId).catch(() => {});
      this.post({ id, type: 'error', message: error.message });
    }
  }

  private post(response: ClapWorkerResponse): void {
    if (this.terminated) return;
    this.onmessage?.({ data: response } as MessageEvent<unknown>);
  }
}

function nextDesktopRequestId(): string {
  requestSequence = (requestSequence + 1) % Number.MAX_SAFE_INTEGER;
  const random = globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2);
  return `clap_${Date.now().toString(36)}_${requestSequence.toString(36)}_${random}`;
}

function workerRequestId(value: unknown): number {
  if (typeof value !== 'object' || value === null) return -1;
  const id = Reflect.get(value, 'id');
  return Number.isSafeInteger(id) ? Number(id) : -1;
}

function parseWorkerRequest(value: unknown): ClapWorkerRequest {
  if (typeof value !== 'object' || value === null) throw new Error('Invalid CLAP worker request');
  const request = value as Partial<ClapWorkerRequest>;
  if (!Number.isSafeInteger(request.id) || (request.id as number) < 0) {
    throw new Error('Invalid CLAP worker request id');
  }
  if (request.type === 'load' && (request.backend === 'webgpu' || request.backend === 'wasm')) {
    return request as ClapWorkerRequest;
  }
  if (request.type === 'embed' && request.samples instanceof Float32Array
    && request.sampleRate === CLAP_SAMPLE_RATE) return request as ClapWorkerRequest;
  throw new Error('Invalid CLAP worker request payload');
}

function workerResult(request: ClapWorkerRequest, requestId: string, value: unknown): ClapWorkerResult {
  if (!isDesktopClapResponse(value) || value.requestId !== requestId) {
    throw new Error('native CLAP returned an invalid response');
  }
  if (request.type === 'load' && value.result.type === 'loaded') return { type: 'loaded' };
  if (request.type === 'embed' && value.result.type === 'embedding') {
    let squaredLength = 0;
    for (const entry of value.result.vector) squaredLength += entry * entry;
    const length = Math.sqrt(squaredLength);
    if (!Number.isFinite(length) || Math.abs(length - 1) > 1e-3) {
      throw new Error(`native CLAP returned a non-unit embedding (length ${length})`);
    }
    return { type: 'embedding', vector: [...value.result.vector] };
  }
  throw new Error('native CLAP returned an unexpected response');
}
