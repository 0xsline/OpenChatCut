import assert from 'node:assert/strict';
import {
  obtainVadEvidence,
  registerVadRunner,
  removableSilenceFromEvidence,
  VAD_MODEL,
  VAD_MODEL_VERSION,
} from './vad';
import { loadVadEvidence, resetVadEvidenceQueues } from '../persist/vadEvidenceStore';
import { resetSharedKvMemory } from '../persist/sharedKv';

const quiet = [
  { startMs: 0, endMs: 500 },
  { startMs: 1_000, endMs: 1_500 },
];
const key = {
  assetId: 'voice-1',
  sourceRevision: 'rev-current',
  model: VAD_MODEL,
  modelVersion: VAD_MODEL_VERSION,
  threshold: 0.5,
};

assert.deepEqual(removableSilenceFromEvidence(quiet, null, { featureEnabled: true }), [], 'missing evidence fails conservative');
assert.deepEqual(removableSilenceFromEvidence(quiet, {
  status: 'unavailable', reason: 'model missing',
}, { featureEnabled: true }), [], 'an unavailable VAD never falls back to RMS deletion');
assert.deepEqual(removableSilenceFromEvidence(quiet, {
  status: 'ready', cached: false,
  evidence: { ...key, analyzedAt: 1, confidence: 0.4, speechSpans: [] },
}, { featureEnabled: true }), [], 'low-confidence no-speech evidence cannot authorize destructive cuts');

const ready = {
  status: 'ready' as const,
  cached: false,
  evidence: {
    ...key,
    analyzedAt: 1,
    confidence: 0.95,
    speechSpans: [{ startMs: 100, endMs: 200, confidence: 0.95 }],
  },
};
assert.deepEqual(removableSilenceFromEvidence(quiet, ready, {
  featureEnabled: false,
}), [], 'the feature flag gates silence deletion even with confident evidence');
assert.deepEqual(removableSilenceFromEvidence(quiet, ready, {
  featureEnabled: true,
  speechPaddingMs: 50,
}), [{ startMs: 1_000, endMs: 1_500 }], 'RMS is only a quiet candidate; VAD protects speech-overlapping candidates');

resetSharedKvMemory();
resetVadEvidenceQueues();
registerVadRunner(undefined);
assert.equal((await obtainVadEvidence(key, new Float32Array(160), 16_000)).status, 'unavailable');
assert.equal(await loadVadEvidence(key), null, 'model unavailability is not cached as empty speech');

registerVadRunner(async () => { throw new Error('onnx unavailable'); });
assert.equal((await obtainVadEvidence(key, new Float32Array(160), 16_000)).status, 'failed');
assert.equal(await loadVadEvidence(key), null, 'model errors are not cached as no speech');

registerVadRunner(async () => ({
  confidence: 0.9,
  speechSpans: [{ startMs: 20, endMs: 80, confidence: 0.9 }],
}));
assert.equal((await obtainVadEvidence(key, new Float32Array(160), 16_000)).status, 'ready');
const cached = await obtainVadEvidence(key, new Float32Array(0), 16_000);
assert.equal(cached.status, 'ready');
assert.equal(cached.status === 'ready' && cached.cached, true, 'model/version/revision/threshold evidence resumes from cache');

registerVadRunner(undefined);
resetSharedKvMemory();
resetVadEvidenceQueues();
console.log('vad.verify: ok');
