import assert from 'node:assert/strict';
import { ClapClient } from './clapClient';
import {
  CLAP_EMBEDDING_DIMENSION,
  CLAP_SAMPLE_RATE,
  type ClapWorkerRequest,
  type ClapWorkerResponse,
} from './clapTypes';

class FakeClapWorker {
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  terminated = false;
  readonly requests: ClapWorkerRequest[] = [];
  readonly embedStarts: number[] = [];

  private readonly failLoad: boolean;
  private readonly silent: boolean;
  private readonly retainEmbedRequests: boolean;

  constructor(failLoad: boolean, silent = false, retainEmbedRequests = true) {
    this.failLoad = failLoad;
    this.silent = silent;
    this.retainEmbedRequests = retainEmbedRequests;
  }

  postMessage(value: unknown): void {
    const request = value as ClapWorkerRequest;
    if (request.type === 'embed') this.embedStarts.push(request.samples[0]!);
    if (request.type !== 'embed' || this.retainEmbedRequests) this.requests.push(request);
    if (this.silent) return;
    queueMicrotask(() => {
      if (request.type === 'load' && this.failLoad) {
        this.emit({ id: request.id, type: 'error', message: 'WebGPU unavailable' });
      } else if (request.type === 'load') {
        this.emit({ id: request.id, type: 'progress', progress: 0.5 });
        this.emit({ id: request.id, type: 'result', result: { type: 'loaded' } });
      } else {
        const vector = Array.from(
          { length: CLAP_EMBEDDING_DIMENSION },
          (_, index) => index === 0 ? 1 : 0,
        );
        this.emit({ id: request.id, type: 'result', result: { type: 'embedding', vector } });
      }
    });
  }

  terminate(): void {
    this.terminated = true;
  }

  private emit(response: ClapWorkerResponse): void {
    this.onmessage?.({ data: response } as MessageEvent<unknown>);
  }
}

const TEST_SAMPLE_RATE = 8_000;
const REPRESENTATIVE_WINDOW_LIMIT = 24;
const WINDOW_SECONDS = 10;
const WINDOW_STEP_SECONDS = 8;

function naturalWindowStarts(durationSeconds: number): number[] {
  const starts = [0];
  while (starts[starts.length - 1]! + WINDOW_SECONDS < durationSeconds) {
    starts.push(starts[starts.length - 1]! + WINDOW_STEP_SECONDS);
  }
  return starts;
}

async function captureWindowStarts(durationSeconds: number): Promise<number[]> {
  const audio = new Float32Array(durationSeconds * TEST_SAMPLE_RATE);
  for (const start of naturalWindowStarts(durationSeconds)) audio[start * TEST_SAMPLE_RATE] = start;
  const workers: FakeClapWorker[] = [];
  const captureClient = new ClapClient({
    arePacksInstalled: async () => true,
    createWorker: () => {
      const worker = new FakeClapWorker(false, false, false);
      workers.push(worker);
      return worker as unknown as Worker;
    },
  });
  await captureClient.embed(audio, TEST_SAMPLE_RATE);
  assert.equal(workers.length, 1, 'representative sampling uses one successful backend');
  assert.equal(workers[0]?.terminated, true, 'representative sampling worker is terminated');
  return workers[0]!.embedStarts;
}

function assertRepresentativeCoverage(starts: number[], durationSeconds: number): void {
  const candidates = naturalWindowStarts(durationSeconds);
  assert.equal(starts.length, REPRESENTATIVE_WINDOW_LIMIT);
  assert.equal(starts[0], candidates[0], 'representative sampling includes the first candidate');
  assert.equal(starts.at(-1), candidates.at(-1), 'representative sampling includes the last candidate');
  assert.ok(starts.some((start) => start >= durationSeconds * 0.4 && start <= durationSeconds * 0.6),
    'representative sampling covers the middle of the track');
  const gaps = starts.slice(1).map((start, index) => (start - starts[index]!) / WINDOW_STEP_SECONDS);
  assert.ok(gaps.every((gap) => gap > 0), 'representative starts are strictly increasing and unique');
  assert.ok(Math.max(...gaps) - Math.min(...gaps) <= 1, 'representative starts are uniformly spaced');
}

const workers: FakeClapWorker[] = [];
const progress: number[] = [];
const samples = new Float32Array(CLAP_SAMPLE_RATE);
samples[0] = 0.25;
const client = new ClapClient({
  arePacksInstalled: async () => true,
  createWorker: () => {
    const worker = new FakeClapWorker(workers.length === 0);
    workers.push(worker);
    return worker as unknown as Worker;
  },
});
const embedding = await client.embed(samples, CLAP_SAMPLE_RATE, (value) => progress.push(value));
assert.equal(workers.length, 2, 'WASM fallback uses a fresh worker after WebGPU failure');
assert.equal(workers.every((worker) => worker.terminated), true, 'every backend worker is terminated');
assert.equal(embedding.length, CLAP_EMBEDDING_DIMENSION);
assert.equal(Math.hypot(...embedding), 1, 'client accepts a finite unit embedding');
assert.equal(samples.buffer.byteLength, CLAP_SAMPLE_RATE * Float32Array.BYTES_PER_ELEMENT,
  'caller-owned audio remains attached after worker transfer');
const wasmEmbed = workers[1]!.requests.find((request) => request.type === 'embed');
assert.ok(wasmEmbed?.type === 'embed');
assert.notEqual(wasmEmbed.samples.buffer, samples.buffer, 'worker receives an owned copy of caller audio');
assert.deepEqual(progress, [0.5]);

let forbiddenWorkers = 0;
const missingPackClient = new ClapClient({
  arePacksInstalled: async () => false,
  createWorker: () => {
    forbiddenWorkers += 1;
    return new FakeClapWorker(false) as unknown as Worker;
  },
});
await assert.rejects(
  missingPackClient.embed(samples, CLAP_SAMPLE_RATE),
  /music-semantics-lite is not installed/,
);
assert.equal(forbiddenWorkers, 0, 'missing packs never start a model worker');

let timeoutWorkers = 0;
const timeoutClient = new ClapClient({
  arePacksInstalled: async () => true,
  loadTimeoutMs: 1,
  createWorker: () => {
    timeoutWorkers += 1;
    return new FakeClapWorker(false, true) as unknown as Worker;
  },
});
await assert.rejects(
  timeoutClient.embed(samples, CLAP_SAMPLE_RATE),
  (error: unknown) => error instanceof AggregateError && /WebGPU and WASM/.test(error.message),
  'both backend attempts are bounded by the client timeout',
);
assert.equal(timeoutWorkers, 2, 'a timed-out WebGPU worker is replaced before WASM');
const abortWorkers: FakeClapWorker[] = [];
const abortClient = new ClapClient({
  arePacksInstalled: async () => true,
  createWorker: () => {
    const worker = new FakeClapWorker(false, true);
    abortWorkers.push(worker);
    return worker as unknown as Worker;
  },
});
const controller = new AbortController();
const aborted = abortClient.embed(samples, CLAP_SAMPLE_RATE, undefined, controller.signal);
await Promise.resolve();
await Promise.resolve();
controller.abort(new DOMException('cancelled by verify', 'AbortError'));
await assert.rejects(aborted, (error: unknown) => error instanceof Error && error.name === 'AbortError');
assert.equal(abortWorkers.length, 1, 'abort does not fall through to a second backend');
assert.equal(abortWorkers[0]?.terminated, true, 'abort terminates the active CLAP worker');

assert.deepEqual(await captureWindowStarts(34), [0, 8, 16, 24],
  'short audio preserves every natural window start');
assert.deepEqual(await captureWindowStarts(194), naturalWindowStarts(194),
  'audio with exactly 24 natural windows remains unchanged');
assert.equal(naturalWindowStarts(10 * 60).length, 75, 'ten-minute audio has 75 natural windows');

const tenMinuteStarts = await captureWindowStarts(10 * 60);
assertRepresentativeCoverage(tenMinuteStarts, 10 * 60);
assert.equal(naturalWindowStarts(60 * 60).length, 450, 'one-hour audio has 450 natural windows');

const oneHourStarts = await captureWindowStarts(60 * 60);
assertRepresentativeCoverage(oneHourStarts, 60 * 60);
assert.ok(naturalWindowStarts(60 * 60).length > oneHourStarts.length,
  'one-hour audio does not send all natural windows');

console.log('clapClient.verify: ok');
