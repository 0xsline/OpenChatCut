const DEFAULT_TOMBSTONE_LIMIT = 128;
const DEFAULT_TOMBSTONE_TTL_MS = 60_000;

interface CancellationTombstone {
  message: string;
  expiresAt: number;
}

/**
 * Coordinates the editor's call and cancellation poll loops. One registry is
 * scoped to one registered editor bridge, so call ids cannot cancel work owned
 * by another editor instance.
 */
export class ExternalCallCancellationRegistry {
  private readonly active = new Map<string, AbortController>();
  private readonly tombstones = new Map<string, CancellationTombstone>();
  private readonly tombstoneLimit: number;
  private readonly tombstoneTtlMs: number;
  private readonly now: () => number;

  constructor(
    tombstoneLimit = DEFAULT_TOMBSTONE_LIMIT,
    tombstoneTtlMs = DEFAULT_TOMBSTONE_TTL_MS,
    now: () => number = Date.now,
  ) {
    this.tombstoneLimit = tombstoneLimit;
    this.tombstoneTtlMs = tombstoneTtlMs;
    this.now = now;
  }

  register(id: string, controller: AbortController): void {
    this.prune();
    this.active.set(id, controller);
    const cancellation = this.tombstones.get(id);
    if (!cancellation) return;
    this.tombstones.delete(id);
    controller.abort(cancellation.message);
  }

  cancel(id: string, message: string): void {
    const controller = this.active.get(id);
    if (controller) {
      controller.abort(message);
      return;
    }
    this.prune();
    this.tombstones.delete(id);
    this.tombstones.set(id, {
      message,
      expiresAt: this.now() + this.tombstoneTtlMs,
    });
    while (this.tombstones.size > Math.max(0, this.tombstoneLimit)) {
      const oldest = this.tombstones.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.tombstones.delete(oldest);
    }
  }

  release(id: string): void {
    this.active.delete(id);
    this.tombstones.delete(id);
  }

  abortAll(reason?: unknown): void {
    for (const controller of this.active.values()) controller.abort(reason);
    this.active.clear();
    this.tombstones.clear();
  }

  get tombstoneCount(): number {
    this.prune();
    return this.tombstones.size;
  }

  private prune(): void {
    const now = this.now();
    for (const [id, tombstone] of this.tombstones) {
      if (tombstone.expiresAt <= now) this.tombstones.delete(id);
    }
  }
}
