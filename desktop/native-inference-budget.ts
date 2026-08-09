const MAX_ACTIVE_REQUESTS = 4;
const MAX_ACTIVE_INPUT_BYTES = 128 * 1024 * 1024;

interface ActiveRequest {
  readonly ownerId: number;
  readonly inputBytes: number;
}

export class NativeInferenceBudget {
  private activeInputBytes = 0;
  private readonly active = new Map<string, ActiveRequest>();
  private readonly ownerRequests = new Map<number, Set<string>>();

  claim(ownerId: number, requestId: string, inputBytes: number): void {
    if (!Number.isSafeInteger(ownerId) || ownerId < 0
      || !Number.isSafeInteger(inputBytes) || inputBytes < 0) {
      throw new Error('invalid desktop inference request budget');
    }
    if (this.active.has(requestId)) throw new Error('duplicate desktop inference request id');
    if (this.active.size >= MAX_ACTIVE_REQUESTS) throw new Error('too many active desktop inference requests');
    if (this.active.size > 0 && !this.ownerRequests.has(ownerId)) {
      throw new Error('desktop inference is busy in another renderer');
    }
    if (this.activeInputBytes + inputBytes > MAX_ACTIVE_INPUT_BYTES) {
      throw new Error('desktop inference input limit exceeded');
    }
    this.active.set(requestId, { ownerId, inputBytes });
    this.activeInputBytes += inputBytes;
    const requests = this.ownerRequests.get(ownerId) ?? new Set<string>();
    requests.add(requestId);
    this.ownerRequests.set(ownerId, requests);
  }

  release(requestId: string): void {
    const request = this.active.get(requestId);
    if (!request) return;
    this.active.delete(requestId);
    this.activeInputBytes -= request.inputBytes;
    const requests = this.ownerRequests.get(request.ownerId);
    requests?.delete(requestId);
    if (requests?.size === 0) this.ownerRequests.delete(request.ownerId);
  }

  ownerOf(requestId: string): number | undefined {
    return this.active.get(requestId)?.ownerId;
  }

  requestIds(ownerId?: number): readonly string[] {
    if (ownerId === undefined) return [...this.active.keys()];
    return [...(this.ownerRequests.get(ownerId) ?? [])];
  }

  get activeCount(): number {
    return this.active.size;
  }
}
