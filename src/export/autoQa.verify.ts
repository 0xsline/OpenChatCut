import assert from 'node:assert/strict';
import {
  DEFAULT_EXPORT_AUTO_QA,
  loadExportAutoQaPreference,
  MAX_EXPORT_QA_ATTEMPTS,
  runExportQa,
  saveExportAutoQaPreference,
  type ExportQaRequest,
} from './autoQa';
import type { ExportQaReport } from './quality';
interface Deferred<Value> {
  promise: Promise<Value>;
  resolve(value?: Value): void;
}

function deferred<Value>(): Deferred<Value> {
  let resolvePromise!: (value: Value | PromiseLike<Value>) => void;
  const promise = new Promise<Value>((resolve) => { resolvePromise = resolve; });
  return {
    promise,
    resolve: (value) => { resolvePromise(value as Value); },
  };
}


const storage = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => { storage.set(key, value); },
  },
});
assert.deepEqual(loadExportAutoQaPreference(), DEFAULT_EXPORT_AUTO_QA);
saveExportAutoQaPreference({ enabled: false });
assert.deepEqual(loadExportAutoQaPreference(), { enabled: false });

const request: ExportQaRequest = {
  src: '/media/uploads/test.mp4',
  durationSeconds: 1,
  width: 320,
  height: 180,
  fps: 30,
  expectsAudio: false,
  cutTimesSeconds: [],
  maxEvidenceCuts: 8,
};
const report: ExportQaReport = {
  ok: true,
  durationSeconds: 1,
  width: 320,
  height: 180,
  fps: 30,
  hasVideo: true,
  hasAudio: false,
  blackFrames: [],
  frozenFrames: [],
  silence: [],
  issues: [],
  summary: { errors: 0, warnings: 0 },
};

let calls = 0;
const retried = await runExportQa(request, {
  retryDelayMs: 0,
  fetcher: async () => {
    calls += 1;
    return calls < MAX_EXPORT_QA_ATTEMPTS
      ? new Response(JSON.stringify({ error: 'temporarily unavailable' }), { status: 503 })
      : new Response(JSON.stringify({ ok: true, report }), { status: 200 });
  },
});
assert.equal(retried.attempts, 3);
assert.equal(calls, 3, 'transient errors stop at the bounded third attempt');

calls = 0;
await assert.rejects(
  () => runExportQa(request, {
    retryDelayMs: 0,
    fetcher: async () => {
      calls += 1;
      return new Response(JSON.stringify({ error: 'bad request' }), { status: 400 });
    },
  }),
  /bad request/,
);
assert.equal(calls, 1, 'non-retryable validation errors fail immediately');

let cancelledCalls = 0;
const qaStarted = deferred<void>();
const qaResponse = deferred<Response>();
const qaController = new AbortController();
let qaSignal: AbortSignal | null | undefined;
const cancelledQa = runExportQa(request, {
  signal: qaController.signal,
  fetcher: async (_input, init) => {
    cancelledCalls += 1;
    qaSignal = init?.signal;
    qaStarted.resolve();
    return qaResponse.promise;
  },
});
await qaStarted.promise;
assert.equal(qaSignal, qaController.signal);
qaController.abort(new DOMException('cancelled', 'AbortError'));
qaResponse.resolve(new Response(JSON.stringify({ ok: true, report }), { status: 200 }));
await assert.rejects(
  cancelledQa,
  (error) => error instanceof DOMException && error.name === 'AbortError',
);
assert.equal(cancelledCalls, 1, 'cancelled QA does not retry');

console.log('export auto QA checks passed');
