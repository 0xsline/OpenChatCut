import { createNativeSemanticWorkerAdapter } from './nativeSemanticWorkerAdapter';
import { packSemanticVectors } from './vectorSearch';
import { readSamplingConfig } from './samplingConfig';
import type {
  DuplicateMatch, FramePixels, SemanticDevice, SemanticVectorRecord,
  WorkerRequest, WorkerResponse, WorkerResult,
} from './types';

type ProgressListener = (progress?: number, file?: string) => void;
type PendingRequest = {
  resolve: (result: WorkerResult) => void;
  reject: (reason?: unknown) => void;
  onProgress?: ProgressListener;
  removeAbortListener?: () => void;
};
export type SemanticWorkerFactory = () => Worker;
type PromiseResolvers<T> = {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
};
const promiseConstructor = Promise as unknown as {
  withResolvers<T>(): PromiseResolvers<T>;
};

export class SemanticClient {
  private worker: Worker | null = null;
  private requestId = 0;
  private disposed = false;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly createWorker: SemanticWorkerFactory;

  constructor(createWorker: SemanticWorkerFactory = createSemanticWorker) {
    this.createWorker = createWorker;
  }

  load(device: SemanticDevice, onProgress?: ProgressListener): Promise<void> {
    return this.request({ id: this.nextId(), type: 'load', device }, onProgress).then(requireLoaded);
  }

  embedText(text: string): Promise<number[]> {
    return this.request({ id: this.nextId(), type: 'embed-text', text }).then(requireVector);
  }

  embedImage(frame: FramePixels): Promise<number[]> {
    const request: WorkerRequest = { id: this.nextId(), type: 'embed-image', frame };
    return this.request(request, undefined, [frame.data.buffer as ArrayBuffer]).then(requireVector);
  }

  findDuplicateAssets(
    records: readonly SemanticVectorRecord[],
    threshold?: number,
    signal?: AbortSignal,
  ): Promise<DuplicateMatch[]> {
    if (signal?.aborted) return Promise.reject(semanticAbortError());
    const similarityThreshold = threshold ?? readSamplingConfig().duplicateThreshold;
    const vectors = packSemanticVectors(records);
    const request: WorkerRequest = { id: this.nextId(), type: 'find-duplicates', threshold: similarityThreshold, vectors };
    const transfer = [
      vectors.assetVectorOffsets.buffer as ArrayBuffer,
      vectors.vectorValueOffsets.buffer as ArrayBuffer,
      vectors.values.buffer as ArrayBuffer,
    ];
    return this.request(request, undefined, transfer, signal).then(requireDuplicates);
  }

  cancel(): void {
    this.failAll(semanticAbortError());
  }

  dispose(): void {
    this.disposed = true;
    this.cancel();
  }

  private nextId(): number {
    this.requestId += 1;
    return this.requestId;
  }

  private getWorker(): Worker {
    if (this.disposed) throw new Error('Semantic client is disposed');
    if (this.worker) return this.worker;
    const worker = this.createWorker();
    worker.onmessage = (event: MessageEvent<unknown>) => {
      try {
        this.handleMessage(validateWorkerResponse(event.data));
      } catch (reason) {
        if (this.worker === worker) {
          const error = reason instanceof Error ? reason : new Error(String(reason));
          this.failAll(error);
        }
      }
    };
    worker.onerror = (event) => {
      if (this.worker === worker) this.failAll(new Error(event.message || 'Semantic worker failed'));
    };
    this.worker = worker;
    return worker;
  }

  private request(
    request: WorkerRequest,
    onProgress?: ProgressListener,
    transfer: Transferable[] = [],
    signal?: AbortSignal,
  ): Promise<WorkerResult> {
    if (signal?.aborted) return Promise.reject(semanticAbortError());
    const { promise, resolve, reject } = promiseConstructor.withResolvers<WorkerResult>();
    const pending: PendingRequest = { resolve, reject, onProgress };
    if (signal) {
      const abort = () => this.abortRequest(request.id);
      signal.addEventListener('abort', abort, { once: true });
      pending.removeAbortListener = () => signal.removeEventListener('abort', abort);
    }
    this.pending.set(request.id, pending);
    try {
      this.getWorker().postMessage(request, transfer);
    } catch (reason) {
      this.finishRequest(request.id);
      reject(reason);
    }
    return promise;
  }

  private abortRequest(id: number): void {
    const pending = this.finishRequest(id);
    pending?.reject(semanticAbortError());
  }

  private handleMessage(response: WorkerResponse): void {
    const pending = this.pending.get(response.id);
    if (!pending) return;
    if (response.type === 'progress') {
      pending.onProgress?.(response.progress, response.file);
      return;
    }
    this.finishRequest(response.id);
    if (response.type === 'error') pending.reject(new Error(response.message));
    else pending.resolve(response.result);
  }

  private finishRequest(id: number): PendingRequest | undefined {
    const pending = this.pending.get(id);
    if (!pending) return undefined;
    this.pending.delete(id);
    pending.removeAbortListener?.();
    return pending;
  }

  private failAll(error: Error): void {
    this.worker?.terminate();
    this.worker = null;
    for (const [id, pending] of this.pending) {
      this.finishRequest(id);
      pending.reject(error);
    }
  }
}

function createSemanticWorker(): Worker {
  return createNativeSemanticWorkerAdapter()
    ?? new Worker(new URL('./semantic.worker.ts', import.meta.url), { type: 'module' });
}

function semanticAbortError(): DOMException {
  return new DOMException('Semantic request canceled', 'AbortError');
}

function requireLoaded(result: WorkerResult): void {
  if (result.type !== 'loaded') throw new Error('Semantic worker returned an unexpected result');
}

function requireVector(result: WorkerResult): number[] {
  if (result.type !== 'embedding') throw new Error('Semantic model returned no embedding');
  return result.vector;
}

function requireDuplicates(result: WorkerResult): DuplicateMatch[] {
  if (result.type !== 'duplicates') throw new Error('Semantic worker returned no duplicate matches');
  return result.matches;
}

function validateWorkerResponse(value: unknown): WorkerResponse {
  if (!value || typeof value !== 'object') throw new Error('Semantic worker returned an invalid response');
  const response = value as Record<string, unknown>;
  if (!Number.isSafeInteger(response.id)) throw new Error('Semantic worker returned an invalid request id');
  if (response.type === 'error' && typeof response.message === 'string') return response as WorkerResponse;
  if (response.type === 'progress'
    && (response.progress === undefined || typeof response.progress === 'number')
    && (response.file === undefined || typeof response.file === 'string')) return response as WorkerResponse;
  if (response.type === 'result' && isWorkerResult(response.result)) return response as WorkerResponse;
  throw new Error('Semantic worker returned an invalid response payload');
}

function isWorkerResult(value: unknown): value is WorkerResult {
  if (!value || typeof value !== 'object') return false;
  const result = value as Record<string, unknown>;
  if (result.type === 'loaded') return true;
  if (result.type === 'embedding') {
    return Array.isArray(result.vector) && result.vector.every((entry) => typeof entry === 'number');
  }
  if (result.type !== 'duplicates' || !Array.isArray(result.matches)) return false;
  return result.matches.every((match) => {
    if (!match || typeof match !== 'object') return false;
    const item = match as Record<string, unknown>;
    return typeof item.leftAssetId === 'string'
      && typeof item.rightAssetId === 'string'
      && typeof item.score === 'number';
  });
}
