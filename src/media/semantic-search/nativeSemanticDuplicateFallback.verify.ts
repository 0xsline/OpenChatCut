import assert from 'node:assert/strict';
import { DESKTOP_NATIVE_INFERENCE_KEY } from '../../transcript/desktop-inference-preference';
import type { DesktopSemanticRequest, DesktopSemanticResponse } from '../../../shared/desktop-inference';

const values = new Map<string, string>([[DESKTOP_NATIVE_INFERENCE_KEY, '1']]);
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
      : { type: 'duplicates', matches: [] };
    queueMicrotask(() => this.onmessage?.({
      data: { id: request.id, type: 'result', result },
    } as MessageEvent<unknown>));
  }

  terminate(): void {}
}

const originalWindow = globalThis.window;
const originalStorage = globalThis.localStorage;
const originalWorker = globalThis.Worker;
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
  },
});
Object.defineProperty(globalThis, 'Worker', { configurable: true, value: FakeBrowserWorker });
Object.defineProperty(globalThis, 'window', {
  configurable: true,
  value: {
    openChatCutDesktop: {
      inference: {
        setEnabled: async () => {},
        semantic: async (request: DesktopSemanticRequest): Promise<DesktopSemanticResponse> => {
          nativeRequests.push(request);
          if (request.action !== 'load') throw new Error('forced model-free native failure');
          return {
            requestId: request.requestId,
            backend: 'native-cpu',
            result: { type: 'loaded' },
          };
        },
        cancel: async () => {},
        subscribeProgress: () => () => {},
      },
    },
  },
});

try {
  const { createNativeSemanticWorkerAdapter } = await import('./nativeSemanticWorkerAdapter');
  const worker = createNativeSemanticWorkerAdapter();
  assert.ok(worker);
  const messages: unknown[] = [];
  worker.onmessage = (event) => { messages.push(event.data); };
  worker.postMessage({ id: 1, type: 'load', device: 'wasm' });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(nativeRequests.length, 1);
  assert.equal(browserRequests, 0);

  worker.postMessage({
    id: 2,
    type: 'find-duplicates',
    vectors: {
      assetIds: [],
      assetVectorOffsets: new Uint32Array([0]),
      vectorValueOffsets: new Uint32Array([0]),
      values: new Float32Array(),
    },
    threshold: 0.985,
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(browserRequests, 1, 'duplicate fallback must not bootstrap the browser model');
  assert.deepEqual(messages.at(-1), {
    id: 2,
    type: 'result',
    result: { type: 'duplicates', matches: [] },
  });
  worker.terminate();
} finally {
  Object.defineProperty(globalThis, 'window', { configurable: true, value: originalWindow });
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: originalStorage });
  Object.defineProperty(globalThis, 'Worker', { configurable: true, value: originalWorker });
}

console.log('native-semantic-duplicate-fallback.verify: model-free fallback skips model bootstrap OK');
