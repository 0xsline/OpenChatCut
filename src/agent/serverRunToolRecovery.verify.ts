import assert from 'node:assert/strict';
import { ToolActivation } from './tool-activation.ts';
import { TOOL_SCHEMAS } from './tools.ts';
import {
  ServerRunToolExecutor,
  type ServerRunLockManager,
} from './serverRunToolExecutor.ts';
import {
  beginStoredToolAttempt,
  captureStoredToolResult,
  readStoredServerRun,
  saveStoredServerRun,
} from './serverRunSessionStorage.ts';

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();
  get length(): number { return this.values.size; }
  clear(): void { this.values.clear(); }
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  key(index: number): string | null { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string): void { this.values.delete(key); }
  setItem(key: string, value: string): void { this.values.set(key, value); }
}

class ImmediateLockManager implements ServerRunLockManager {
  request<T>(
    _name: string,
    _options: { readonly mode: 'exclusive' },
    callback: () => T | PromiseLike<T>,
  ): Promise<T> {
    return Promise.resolve(callback());
  }
}

const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
const originalFetch = globalThis.fetch;
Object.defineProperty(globalThis, 'sessionStorage', {
  configurable: true,
  value: new MemoryStorage(),
});

try {
  const projectId = 'cursor-admitted-recovery';
  const runId = 'run-cursor-admitted';
  const recoveredCall = 'call-recovered-result';
  const interruptedCall = 'call-interrupted-result';
  assert(saveStoredServerRun(projectId, { projectId, runId, attempts: [], cursor: 12 }));
  assert(beginStoredToolAttempt(projectId, recoveredCall, 'digest-recovered'));
  assert(beginStoredToolAttempt(projectId, interruptedCall, 'digest-interrupted'));
  assert(captureStoredToolResult(projectId, recoveredCall, {
    name: 'read_project',
    argsDigest: 'digest-recovered',
    result: { ok: true },
  }));

  const posted = new Map<string, Record<string, unknown>>();
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith('/tool-claim')) {
      return Response.json({ claimed: true, outcome: 'duplicate' });
    }
    if (url.endsWith('/tool-result')) {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      posted.set(String(body.toolCallId), body);
      return Response.json({ ok: true, outcome: 'accepted' });
    }
    throw new Error(`unexpected request: ${url}`);
  };

  const executor = new ServerRunToolExecutor(projectId, {
    ctx: () => ({} as never),
    settings: () => ({} as never),
    onToolAction: () => undefined,
    updateMessages: () => undefined,
    setLiveTool: () => undefined,
    retryStream: () => assert.fail('an admitted durable attempt must not depend on SSE replay'),
    abandonRecovery: (_id, error) => assert.fail(String(error)),
  }, new ImmediateLockManager());
  executor.start({
    capability: 'cursor-recovery-capability',
    baseDoc: {} as never,
    activation: new ToolActivation(TOOL_SCHEMAS, []),
    runId,
    abort: new AbortController(),
    recovered: new Map(),
  });

  const attempts = readStoredServerRun(projectId)?.attempts ?? [];
  await executor.reconcileStoredAttempts(runId, attempts);
  assert.deepEqual(posted.get(recoveredCall)?.result, { ok: true },
    'a persisted draft outcome is delivered even when its tool-request event is before the cursor');
  assert.match(String(posted.get(interruptedCall)?.error), /not replayed automatically/,
    'a cursor-admitted attempt without a durable outcome settles as interrupted instead of hanging');
  assert.deepEqual(readStoredServerRun(projectId)?.attempts, [],
    'settled cursor-admitted attempts are removed from browser recovery storage');
} finally {
  globalThis.fetch = originalFetch;
  if (originalStorage) Object.defineProperty(globalThis, 'sessionStorage', originalStorage);
  else Reflect.deleteProperty(globalThis, 'sessionStorage');
}

console.log('server run admitted tool recovery verification passed');
