export interface ServerRunLockManager {
  request<T>(
    name: string,
    options: { readonly mode: 'exclusive'; readonly ifAvailable: true },
    callback: (lock: Lock | null) => T | PromiseLike<T>,
  ): Promise<T>;
}

function lockName(projectId: string, runId: string): string {
  return JSON.stringify(['openchatcut-server-run-owner', projectId, runId]);
}

/** Fences browser-side draft mutation and terminal finalization to one live tab. */
export class ServerRunOwnership {
  private readonly manager: ServerRunLockManager | null;
  private heldKey: string | null = null;
  private pendingKey: string | null = null;
  private pending: Promise<boolean> | null = null;
  private releaseHeld: (() => void) | null = null;

  constructor(manager: ServerRunLockManager | null = (
    typeof navigator === 'undefined' || !navigator.locks
      ? null
      : navigator.locks as ServerRunLockManager
  )) {
    this.manager = manager;
  }

  acquire(projectId: string, runId: string): Promise<boolean> {
    const key = lockName(projectId, runId);
    if (this.heldKey === key) return Promise.resolve(true);
    if (this.pendingKey === key && this.pending) return this.pending;
    if (!this.manager || this.heldKey || this.pendingKey) return Promise.resolve(false);
    const ready = Promise.withResolvers<boolean>();
    this.pendingKey = key;
    this.pending = ready.promise;
    void this.manager.request(key, { mode: 'exclusive', ifAvailable: true }, async (lock) => {
      this.pendingKey = null;
      this.pending = null;
      if (!lock) return ready.resolve(false);
      const released = Promise.withResolvers<void>();
      this.heldKey = key;
      this.releaseHeld = released.resolve;
      ready.resolve(true);
      await released.promise;
      if (this.heldKey === key) this.heldKey = null;
      this.releaseHeld = null;
    }).catch(() => {
      this.pendingKey = null;
      this.pending = null;
      ready.resolve(false);
    });
    return ready.promise;
  }

  release(projectId: string, runId: string): void {
    if (this.heldKey !== lockName(projectId, runId)) return;
    this.releaseHeld?.();
  }
}

const pageOwnership = new ServerRunOwnership();

export function acquireServerRunOwnership(projectId: string, runId: string): Promise<boolean> {
  return pageOwnership.acquire(projectId, runId);
}

export function releaseServerRunOwnership(projectId: string, runId: string): void {
  pageOwnership.release(projectId, runId);
}
