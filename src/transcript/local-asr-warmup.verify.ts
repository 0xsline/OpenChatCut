import assert from 'node:assert/strict';
import { __resetLocalAsrClient, LocalAsrClient, warmUpLocalAsr } from './local-asr';
import type { AsrConfig } from './local-asr-types';

interface LoadRequest {
  id: number;
  type: 'load';
  device: string;
  modelId: string;
  revision: string;
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

  rejectNext(message = 'load failed'): void {
    const request = this.pending.shift();
    assert.ok(request, 'expected a pending worker request');
    queueMicrotask(() => this.onmessage?.({
      data: { id: request.id, type: 'error', message },
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
  assert.equal(worker.requests[0]?.revision, '5332fcc35e32a33b86612b9a57a89be7906102b1');
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
  assert.equal(FakeWorker.instances.length, 1, 'model switch must wait for current load');
  switchingWorker.resolveNext();
  await waitFor(() => FakeWorker.instances[1]?.requests.length === 1);
  const smallWorker = FakeWorker.instances[1]!;
  assert.equal(smallWorker.requests[0]?.modelId, 'Xenova/whisper-small');
  assert.equal(smallWorker.requests[0]?.revision, '2d67713f236afa48a18992566e7647f6ca848e13');
  smallWorker.resolveNext();
  await Promise.all([first, second]);

  FakeWorker.instances.length = 0;
  const client = new LocalAsrClient();
  const base: AsrConfig = {
    device: 'wasm',
    modelTier: 'tiny',
    modelId: 'Xenova/whisper-tiny',
    revision: '5332fcc35e32a33b86612b9a57a89be7906102b1',
  };
  const initial = client.ensureLoaded(base);
  await waitFor(() => FakeWorker.instances[0]?.requests.length === 1);
  FakeWorker.instances[0]!.resolveNext();
  await initial;
  await client.ensureLoaded(base);
  assert.equal(FakeWorker.instances.length, 1, 'same requested config must reuse its loaded worker');

  const modelChangedConfig: AsrConfig = { ...base, modelId: 'Xenova/whisper-small' };
  const modelChanged = client.ensureLoaded(modelChangedConfig);
  await waitFor(() => FakeWorker.instances[1]?.requests.length === 1);
  FakeWorker.instances[1]!.resolveNext();
  await modelChanged;
  const revisionChanged = client.ensureLoaded({ ...modelChangedConfig, revision: 'a'.repeat(40) });
  await waitFor(() => FakeWorker.instances[2]?.requests.length === 1);
  FakeWorker.instances[2]!.resolveNext();
  await revisionChanged;
  const deviceChanged = client.ensureLoaded({
    ...modelChangedConfig,
    revision: 'a'.repeat(40),
    device: 'webgpu',
  });
  await waitFor(() => FakeWorker.instances[3]?.requests.length === 1);
  FakeWorker.instances[3]!.resolveNext();
  await deviceChanged;
  assert.equal(FakeWorker.instances.length, 4,
    'model, revision, and device changes must each recreate the worker');
  client.dispose();

  FakeWorker.instances.length = 0;
  const fallbackClient = new LocalAsrClient();
  const webgpuConfig: AsrConfig = { ...base, device: 'webgpu' };
  const fallbackLoad = fallbackClient.ensureLoaded(webgpuConfig);
  await waitFor(() => FakeWorker.instances[0]?.requests.length === 1);
  FakeWorker.instances[0]!.rejectNext('webgpu unavailable');
  await waitFor(() => FakeWorker.instances[1]?.requests.length === 1);
  assert.equal(FakeWorker.instances[1]!.requests[0]?.device, 'wasm');
  FakeWorker.instances[1]!.resolveNext();
  await fallbackLoad;
  await fallbackClient.ensureLoaded(webgpuConfig);
  assert.equal(FakeWorker.instances.length, 2,
    'a webgpu request already loaded through wasm fallback must reuse that worker');
  fallbackClient.dispose();

  console.log('local-asr-warmup.verify: downloaded-only, reuse, and model switching passed');
} finally {
  __resetLocalAsrClient();
  for (const [key, descriptor] of Object.entries(originals)) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
}
