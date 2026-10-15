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

// The desktop ASR engine is whisper.cpp, which loads only the GGML companion.
// Sizing it from the ONNX export refused small, medium and large-v3-turbo on
// 8-12 GB machines and sent them to the wasm engine that runs out of memory.
function fitsMachine(bytes: number, totalMemoryGiB: number): boolean {
  try {
    new NativeInferenceResidency(defaultNativeResidencyLimit(totalMemoryGiB * 1024 ** 3))
      .claim('asr', bytes, () => {})();
    return true;
  } catch {
    return false;
  }
}
for (const model of ASR_MODELS) {
  const ggml = model.ggmlFile!;
  const estimate = estimateAsrResidentBytes(model.modelId, model.revision);
  assert.equal(estimate, Math.max(512 * 1024 ** 2, ggml.sizeBytes * 3 + 256 * 1024 ** 2),
    `${model.id}: whisper.cpp residency is estimated from the GGML companion`);
  assert.ok(estimate >= ggml.sizeBytes * 2, `${model.id}: buffers are budgeted beyond the weights`);
  assert.ok(fitsMachine(estimate, 8), `${model.id}: the desktop engine must be admitted on an 8 GB machine`);
}
for (const id of ['tiny', 'base']) {
  const model = ASR_MODELS.find((entry) => entry.id === id)!;
  assert.ok(fitsMachine(estimateAsrResidentBytes(model.modelId, model.revision), 4),
    `${id}: still admitted on a 4 GB machine`);
}

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
