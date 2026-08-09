import assert from 'node:assert/strict';
import { DESKTOP_NATIVE_INFERENCE_KEY } from '../../transcript/desktop-inference-preference';
import type { DesktopSemanticRequest } from '../../../shared/desktop-inference';
import { SEMANTIC_INFERENCE_CONTRACT } from '../../../shared/vector-inference-contract';
import { DESKTOP_NATIVE_SEMANTIC_READY_KEY } from './nativeSemanticWorkerAdapter';

const values = new Map<string, string>();
const storage = {
  getItem: (key: string) => values.get(key) ?? null,
  setItem: (key: string, value: string) => { values.set(key, value); },
};
const nativeRequests: DesktopSemanticRequest[] = [];
let browserRequests = 0;

class FakeBrowserWorker {
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;

  postMessage(value: unknown): void {
    browserRequests += 1;
    const request = value as { id: number; type: string };
    const result = request.type === 'load'
      ? { type: 'loaded' }
      : request.type === 'find-duplicates'
        ? { type: 'duplicates', matches: [] }
        : { type: 'embedding', vector: [1] };
    queueMicrotask(() => this.onmessage?.({
      data: { id: request.id, type: 'result', result },
    } as MessageEvent<unknown>));
  }

  terminate(): void {}
}

const originalWindow = globalThis.window;
const originalStorage = globalThis.localStorage;
const originalWorker = globalThis.Worker;
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });
Object.defineProperty(globalThis, 'Worker', { configurable: true, value: FakeBrowserWorker });
Object.defineProperty(globalThis, 'window', {
  configurable: true,
  value: {
    openChatCutDesktop: {
      inference: {
        setEnabled: async () => {},
        semantic: async (request: DesktopSemanticRequest) => {
          nativeRequests.push(request);
          throw new Error('forced native failure');
        },
        cancel: async () => {},
        subscribeProgress: () => () => {},
      },
    },
  },
});

try {
  const { createNativeSemanticWorkerAdapter } = await import('./nativeSemanticWorkerAdapter');
  assert.equal(createNativeSemanticWorkerAdapter(), null, 'native semantic routing must default off');
  storage.setItem(DESKTOP_NATIVE_INFERENCE_KEY, '1');
  const disabledWorker = createNativeSemanticWorkerAdapter();
  assert.ok(disabledWorker);
  storage.setItem(DESKTOP_NATIVE_INFERENCE_KEY, '0');
  disabledWorker.postMessage({ id: 0, type: 'load', device: 'wasm' });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(nativeRequests.length, 0, 'an existing adapter must honor a later disable');
  assert.equal(browserRequests, 1, 'a disabled existing adapter must move to the browser path');
  disabledWorker.terminate();

  storage.setItem(DESKTOP_NATIVE_INFERENCE_KEY, '1');
  browserRequests = 0;
  const worker = createNativeSemanticWorkerAdapter();
  assert.ok(worker);
  const messages: unknown[] = [];
  worker.onmessage = (event) => { messages.push(event.data); };
  worker.postMessage({ id: 1, type: 'load', device: 'wasm' });
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(nativeRequests.length, 1);
  assert.equal(browserRequests, 1, 'failed native load must replay through one browser worker');
  assert.deepEqual(messages, [{ id: 1, type: 'result', result: { type: 'loaded' } }]);
  assert.equal(
    storage.getItem(DESKTOP_NATIVE_SEMANTIC_READY_KEY),
    SEMANTIC_INFERENCE_CONTRACT.id,
    'a successful browser fallback must mark the downloaded model for next-session native preload',
  );
  worker.terminate();

} finally {
  Object.defineProperty(globalThis, 'window', { configurable: true, value: originalWindow });
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: originalStorage });
  Object.defineProperty(globalThis, 'Worker', { configurable: true, value: originalWorker });
}

console.log('native-semantic-worker-adapter.verify: opt-in and same-call browser fallback OK');
