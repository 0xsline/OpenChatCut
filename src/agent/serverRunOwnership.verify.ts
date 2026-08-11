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
assert.equal(await owner.acquire('project-1', 'run-2'), true);
let switched = false;
const switchedOwnership = owner.acquire('project-2', 'run-3').then((acquired) => {
  switched = acquired;
  return acquired;
});
await Promise.resolve();
assert.equal(switched, false, 'destination recovery waits while this page settles its previous run');
owner.release('project-1', 'run-2');
assert.equal(await switchedOwnership, true,
  'destination recovery acquires ownership after the previous project releases it');
owner.release('project-2', 'run-3');

console.log('serverRunOwnership.verify: run-scoped tab ownership fence OK');
