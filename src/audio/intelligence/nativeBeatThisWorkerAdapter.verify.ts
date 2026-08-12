import assert from 'node:assert/strict';
import type {
  DesktopInferenceCapabilities,
  DesktopRhythmRequest,
} from '../../../shared/desktop-inference';
import { RHYTHM_INFERENCE_CONTRACT } from '../../../shared/vector-inference-contract';
import { DESKTOP_NATIVE_INFERENCE_KEY } from '../../transcript/desktop-inference-preference';

const storageValues = new Map<string, string>();
const browserRequests: unknown[] = [];
let nativeRequests = 0;
function requestId(value: unknown): number {
  if (typeof value !== 'object' || value === null || !('id' in value)) {
    throw new Error('invalid fake browser request');
  }
  const id = value.id;
  if (typeof id !== 'number' || !Number.isSafeInteger(id)) throw new Error('invalid fake browser request');
  return id;
}

function backend(value: unknown): unknown {
  if (typeof value !== 'object' || value === null || !('backend' in value)) return undefined;
  return value.backend;
}


class FakeBrowserWorker {
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  onmessageerror: ((event: MessageEvent<unknown>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;

  postMessage(value: unknown): void {
    browserRequests.push(value);
    const id = requestId(value);
    queueMicrotask(() => this.onmessage?.({
      data: {
        id,
        type: 'result',
        beat: new Float32Array([1]),
        downbeat: new Float32Array([2]),
      },
    } as MessageEvent<unknown>));
  }

  terminate(): void {}
}

const capabilities: DesktopInferenceCapabilities = {
  version: 3,
  platform: 'darwin',
  asr: { available: true, preferredBackend: 'native-cpu', contractId: 'whisper-q8-16khz-word-v1' },
  semantic: { available: true, preferredBackend: 'native-cpu', contractId: 'chinese-clip-q4-224-v1' },
  clap: { available: true, preferredBackend: 'native-cpu', contractId: 'clap-q8-48khz-v1' },
  rhythm: { available: true, preferredBackend: 'coreml', contractId: RHYTHM_INFERENCE_CONTRACT.id },
};
const originalWindow = globalThis.window;
const originalStorage = globalThis.localStorage;
const originalWorker = globalThis.Worker;
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    getItem: (key: string) => storageValues.get(key) ?? null,
    setItem: (key: string, value: string) => { storageValues.set(key, value); },
  },
});
Object.defineProperty(globalThis, 'Worker', { configurable: true, value: FakeBrowserWorker });
Object.defineProperty(globalThis, 'window', {
  configurable: true,
  value: {
    openChatCutDesktop: {
      inference: {
        setEnabled: async () => {},
        getCapabilities: async () => capabilities,
        rhythm: async (_request: DesktopRhythmRequest) => {
          nativeRequests += 1;
          throw new Error('forced native rhythm failure');
        },
        cancel: async () => {},
        subscribeProgress: () => () => {},
      },
    },
  },
});

try {
  const { createBeatThisWorker } = await import('./nativeBeatThisWorkerAdapter');
  // Auto mode with a desktop bridge: native routing defaults on, matching
  // the ASR preference contract (opt-out via the inference preference).
  const defaultWorker = createBeatThisWorker();
  assert.ok(!(defaultWorker instanceof FakeBrowserWorker),
    'native rhythm routing defaults on with a desktop bridge');
  defaultWorker.terminate();

  storageValues.set(DESKTOP_NATIVE_INFERENCE_KEY, '1');
  const worker = createBeatThisWorker();
  const messages: unknown[] = [];
  worker.onmessage = (event) => { messages.push(event.data); };
  worker.postMessage({
    id: 7,
    type: 'analyze',
    backend: 'webgpu',
    samples: new Float32Array([0, 0, 0, 0]),
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(nativeRequests, 1);
  assert.equal(browserRequests.length, 1, 'native failure must start one fresh browser worker');
  assert.equal(backend(browserRequests[0]), 'webgpu');
  assert.deepEqual(messages, [{
    id: 7,
    type: 'result',
    beat: new Float32Array([1]),
    downbeat: new Float32Array([2]),
  }]);
  worker.terminate();
} finally {
  Object.defineProperty(globalThis, 'window', { configurable: true, value: originalWindow });
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: originalStorage });
  Object.defineProperty(globalThis, 'Worker', { configurable: true, value: originalWorker });
}

console.log('native-beat-this-worker-adapter.verify: opt-in and browser fallback ordering OK');
