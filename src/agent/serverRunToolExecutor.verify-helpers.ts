import type { ServerRunLockManager } from './serverRunToolExecutor.ts';

export class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();
  mutationCount = 0;

  get length(): number { return this.values.size; }

  clear(): void {
    this.mutationCount += 1;
    this.values.clear();
  }

  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  key(index: number): string | null { return [...this.values.keys()][index] ?? null; }

  removeItem(key: string): void {
    this.mutationCount += 1;
    this.values.delete(key);
  }

  setItem(key: string, value: string): void {
    this.mutationCount += 1;
    this.values.set(key, value);
  }
}

export class FakeLockManager implements ServerRunLockManager {
  private readonly tails = new Map<string, Promise<void>>();

  request<T>(
    name: string,
    _options: { readonly mode: 'exclusive' },
    callback: () => T | PromiseLike<T>,
  ): Promise<T> {
    const previous = this.tails.get(name) ?? Promise.resolve();
    const result = previous.then(callback);
    const tail = result.then(() => undefined, () => undefined);
    this.tails.set(name, tail);
    return result.finally(() => {
      if (this.tails.get(name) === tail) this.tails.delete(name);
    });
  }
}
