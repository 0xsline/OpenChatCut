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

console.log('export auto QA checks passed');
