import assert from 'node:assert/strict';
import { DESKTOP_NATIVE_INFERENCE_KEY } from '../../transcript/desktop-inference-preference';
import type { DesktopClapRequest } from '../../../shared/desktop-inference';

const values = new Map([[DESKTOP_NATIVE_INFERENCE_KEY, '1']]);
const storage = {
  getItem: (key: string) => values.get(key) ?? null,
  setItem: (key: string, value: string) => { values.set(key, value); },
};
const nativeRequests: DesktopClapRequest[] = [];
let browserRequests = 0;

class FakeBrowserWorker {
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;

  postMessage(value: unknown): void {
    browserRequests += 1;
    const request = value as { id: number; type: string };
    const vector = Array(512).fill(0) as number[];
    vector[0] = 1;
    const result = request.type === 'load'
      ? { type: 'loaded' }
      : { type: 'embedding', vector };
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
        clap: async (request: DesktopClapRequest) => {
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
  const { ClapClient } = await import('./clapClient');
  const client = new ClapClient({ arePacksInstalled: async () => true });
  const vector = await client.embed(new Float32Array(48_000), 48_000);
  assert.equal(nativeRequests.length, 1, 'the enabled path must try native first');
  assert.equal(browserRequests, 2, 'native failure must retry browser load and embedding');
  assert.equal(vector.length, 512);
  assert.equal(vector[0], 1);
} finally {
  Object.defineProperty(globalThis, 'window', { configurable: true, value: originalWindow });
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: originalStorage });
  Object.defineProperty(globalThis, 'Worker', { configurable: true, value: originalWorker });
}

console.log('native-clap-worker-adapter.verify: native failure falls back in the same analysis');
