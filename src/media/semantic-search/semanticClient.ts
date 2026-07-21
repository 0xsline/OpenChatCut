import type { FramePixels, SemanticDevice, WorkerRequest, WorkerResponse } from './types';

type ProgressListener = (progress?: number, file?: string) => void;
type PendingRequest = {
  resolve: (vector?: number[]) => void;
  reject: (reason?: unknown) => void;
  onProgress?: ProgressListener;
};

export class SemanticClient {
  private worker: Worker | null = null;
  private requestId = 0;
  private readonly pending = new Map<number, PendingRequest>();

  load(device: SemanticDevice, onProgress?: ProgressListener): Promise<void> {
    return this.request({ id: this.nextId(), type: 'load', device }, onProgress).then(() => undefined);
  }

  embedText(text: string): Promise<number[]> {
    return this.request({ id: this.nextId(), type: 'embed-text', text }).then(requireVector);
  }

  embedImage(frame: FramePixels): Promise<number[]> {
    const request: WorkerRequest = { id: this.nextId(), type: 'embed-image', frame };
    return this.request(request, undefined, [frame.data.buffer as ArrayBuffer]).then(requireVector);
  }

  cancel(): void {
    this.worker?.terminate();
    this.worker = null;
    const error = new DOMException('Semantic indexing canceled', 'AbortError');
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  private nextId(): number {
    this.requestId += 1;
    return this.requestId;
  }

  private getWorker(): Worker {
    if (this.worker) return this.worker;
    this.worker = new Worker(new URL('./semantic.worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (event: MessageEvent<WorkerResponse>) => this.handleMessage(event.data);
    this.worker.onerror = (event) => this.failAll(new Error(event.message || 'Semantic worker failed'));
    return this.worker;
  }

  private request(request: WorkerRequest, onProgress?: ProgressListener, transfer?: Transferable[]): Promise<number[] | undefined> {
    return new Promise((resolve, reject) => {
      this.pending.set(request.id, { resolve, reject, onProgress });
      this.getWorker().postMessage(request, transfer ?? []);
    });
  }

  private handleMessage(response: WorkerResponse): void {
    const pending = this.pending.get(response.id);
    if (!pending) return;
    if (response.type === 'progress') {
      pending.onProgress?.(response.progress, response.file);
      return;
    }
    this.pending.delete(response.id);
    if (response.type === 'error') pending.reject(new Error(response.message));
    else pending.resolve(response.vector);
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    this.worker?.terminate();
    this.worker = null;
  }
}

function requireVector(vector?: number[]): number[] {
  if (!vector) throw new Error('Semantic model returned no embedding');
  return vector;
}
