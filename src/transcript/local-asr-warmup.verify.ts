import assert from 'node:assert/strict';
import { __resetLocalAsrClient, warmUpLocalAsr } from './local-asr';

interface LoadRequest {
  id: number;
  type: 'load';
  device: string;
  modelId: string;
}

class FakeWorker {
  static instances: FakeWorker[] = [];
  readonly requests: LoadRequest[] = [];
  private readonly pending: LoadRequest[] = [];
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: { message: string }) => void) | null = null;

  constructor() {
    FakeWorker.instances.push(this);
  }

  postMessage(request: LoadRequest): void {
    this.requests.push(request);
    this.pending.push(request);
  }

  resolveNext(): void {
    const request = this.pending.shift();
    assert.ok(request, 'expected a pending worker request');
    queueMicrotask(() => this.onmessage?.({
      data: { id: request.id, type: 'result', result: { text: '', chunks: [] } },
    }));
  }

  terminate(): void {}
}

class FakeStorage {
  private readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

async function waitFor(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (check()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  assert.fail('timed out waiting for worker request');
}

const originals = {
  Worker: Object.getOwnPropertyDescriptor(globalThis, 'Worker'),
  navigator: Object.getOwnPropertyDescriptor(globalThis, 'navigator'),
  localStorage: Object.getOwnPropertyDescriptor(globalThis, 'localStorage'),
};
const storage = new FakeStorage();
Object.defineProperty(globalThis, 'Worker', { configurable: true, value: FakeWorker });
Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: { userAgent: 'Macintosh', deviceMemory: 32, hardwareConcurrency: 10 },
});
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });

try {
  storage.setItem('cc.asrModel', 'tiny');
  await warmUpLocalAsr(['Xenova/whisper-base']);
  assert.equal(FakeWorker.instances.length, 0, 'missing selected model must not start a worker');

  const tinyWarmup = warmUpLocalAsr(['Xenova/whisper-tiny']);
  await waitFor(() => FakeWorker.instances[0]?.requests.length === 1);
  const worker = FakeWorker.instances[0]!;
  assert.equal(worker.requests[0]?.modelId, 'Xenova/whisper-tiny');
  worker.resolveNext();
  await tinyWarmup;

  await warmUpLocalAsr(['Xenova/whisper-tiny']);
  assert.equal(worker.requests.length, 1, 'already-loaded model must be reused');

  __resetLocalAsrClient();
  FakeWorker.instances.length = 0;
  storage.setItem('cc.asrModel', 'tiny');
  const first = warmUpLocalAsr(['Xenova/whisper-tiny']);
  await waitFor(() => FakeWorker.instances[0]?.requests.length === 1);
  const switchingWorker = FakeWorker.instances[0]!;

  storage.setItem('cc.asrModel', 'small');
  const second = warmUpLocalAsr(['Xenova/whisper-small']);
  assert.equal(switchingWorker.requests.length, 1, 'model switch must wait for current load');
  switchingWorker.resolveNext();
  await waitFor(() => switchingWorker.requests.length === 2);
  assert.equal(switchingWorker.requests[1]?.modelId, 'Xenova/whisper-small');
  switchingWorker.resolveNext();
  await Promise.all([first, second]);

  console.log('local-asr-warmup.verify: downloaded-only, reuse, and model switching passed');
} finally {
  __resetLocalAsrClient();
  for (const [key, descriptor] of Object.entries(originals)) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
}
