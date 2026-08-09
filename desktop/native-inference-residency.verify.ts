import assert from 'node:assert/strict';
import { ASR_MODELS } from '../shared/asr-models.ts';
import {
  NativeInferenceResidency,
  defaultNativeResidencyLimit,
  estimateAsrResidentBytes,
  modelPackResidentBytes,
  type NativeInferenceKind,
} from './native-inference-residency.ts';

assert.equal(defaultNativeResidencyLimit(2 * 1024 ** 3), 1024 ** 3);
assert.equal(defaultNativeResidencyLimit(64 * 1024 ** 3), 4 * 1024 ** 3);
assert.equal(modelPackResidentBytes('rhythm-lite'), 1024 ** 3);
assert.equal(modelPackResidentBytes('visual-semantics-lite'), 2 * 1024 ** 3);

const tiny = ASR_MODELS.find((model) => model.id === 'tiny')!;
assert.equal(estimateAsrResidentBytes(tiny.modelId, tiny.revision), 512 * 1024 ** 2);
assert.equal(estimateAsrResidentBytes('unknown', 'unknown'), 2 * 1024 ** 3);

const evicted: NativeInferenceKind[] = [];
const residency = new NativeInferenceResidency(100);
const releaseAsr = residency.claim('asr', 40, (kind) => evicted.push(kind));
releaseAsr();
const releaseSemantic = residency.claim('semantic', 40, (kind) => evicted.push(kind));
releaseSemantic();
const releaseClap = residency.claim('clap', 40, (kind) => evicted.push(kind));
assert.deepEqual(evicted, ['asr'], 'the least-recently-used idle model is evicted first');
assert.deepEqual(residency.residentKinds(), ['semantic', 'clap']);

assert.throws(
  () => residency.claim('rhythm', 70, (kind) => evicted.push(kind)),
  /resident memory limit exceeded/,
  'an active model is never evicted to admit another model',
);
assert.deepEqual(evicted, ['asr', 'semantic'], 'idle models may be evicted before a safe rejection');
releaseClap();

const releaseRhythm = residency.claim('rhythm', 70, (kind) => evicted.push(kind));
assert.deepEqual(evicted, ['asr', 'semantic', 'clap']);
releaseRhythm();
assert.deepEqual(residency.residentKinds(), ['rhythm']);

const sameKind = new NativeInferenceResidency(100);
const releaseFirst = sameKind.claim('semantic', 60, () => assert.fail('must not evict the requested kind'));
const releaseSecond = sameKind.claim('semantic', 60, () => assert.fail('must not evict the requested kind'));
releaseFirst();
releaseSecond();
assert.deepEqual(sameKind.residentKinds(), ['semantic']);
sameKind.clear();
assert.deepEqual(sameKind.residentKinds(), []);

console.log('native-inference-residency.verify: bounded residency, LRU eviction, and active isolation OK');
