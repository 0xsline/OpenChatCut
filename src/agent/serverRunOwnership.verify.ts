import assert from 'node:assert/strict';
import { ServerRunOwnership, type ServerRunLockManager } from './serverRunOwnership';

class MemoryLockManager implements ServerRunLockManager {
  private readonly held = new Set<string>();

  async request<T>(
    name: string,
    _options: { readonly mode: 'exclusive'; readonly ifAvailable: true },
    callback: (lock: Lock | null) => T | PromiseLike<T>,
  ): Promise<T> {
    if (this.held.has(name)) return callback(null);
    this.held.add(name);
    try {
      return await callback({ name, mode: 'exclusive' } as Lock);
    } finally {
      this.held.delete(name);
    }
  }
}

const manager = new MemoryLockManager();
const owner = new ServerRunOwnership(manager);
const duplicate = new ServerRunOwnership(manager);
assert.equal(await owner.acquire('project-1', 'run-1'), true);
assert.equal(
  await duplicate.acquire('project-1', 'run-1'),
  false,
  'a duplicated tab cannot own the same browser run lifecycle',
);
owner.release('project-1', 'run-1');
await new Promise((resolve) => setTimeout(resolve, 0));
assert.equal(await duplicate.acquire('project-1', 'run-1'), true);
duplicate.release('project-1', 'run-1');

console.log('serverRunOwnership.verify: run-scoped tab ownership fence OK');
