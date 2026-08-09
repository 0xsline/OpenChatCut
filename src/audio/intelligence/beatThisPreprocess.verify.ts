import assert from 'node:assert/strict';
import {
  BEAT_THIS_BORDER_FRAMES,
  BEAT_THIS_CHUNK_FRAMES,
  BEAT_THIS_FFT_BINS,
  BEAT_THIS_FPS,
  BEAT_THIS_HOP_LENGTH,
  BEAT_THIS_MEL_BINS,
  beatThisWindowStarts,
  createBeatThisWindow,
  mergeBeatThisLogits,
  preprocessBeatThis,
  preprocessBeatThisWindow,
  splitBeatThisFeatures,
  type BeatThisWindow,
  type BeatThisWindowLogits,
} from './beatThisPreprocess';

assert.equal(BEAT_THIS_FPS, 50);

const filterbank = new Float32Array(BEAT_THIS_FFT_BINS * BEAT_THIS_MEL_BINS);
filterbank[0] = 1;
const impulse = new Float32Array(513);
impulse[0] = 1;
const impulseFeatures = preprocessBeatThis(impulse, filterbank);
assert.equal(impulseFeatures.frames, 2);
assert.equal(impulseFeatures.values.length, 2 * BEAT_THIS_MEL_BINS);
assert.ok(Math.abs(impulseFeatures.values[0]! - Math.log1p(1_000 / Math.sqrt(1_024))) < 1e-5);
for (let mel = 1; mel < BEAT_THIS_MEL_BINS; mel += 1) assert.equal(impulseFeatures.values[mel], 0);

assert.deepEqual(beatThisWindowStarts(100), [-6]);
assert.deepEqual(beatThisWindowStarts(1_488), [-6]);
assert.deepEqual(beatThisWindowStarts(1_489), [-6, -5]);
assert.deepEqual(beatThisWindowStarts(3_000), [-6, 1_482, 1_506]);

const equivalenceFilterbank = filterbank.slice();
equivalenceFilterbank[BEAT_THIS_MEL_BINS + 3] = 0.25;
const finalFilterbankIndex = (BEAT_THIS_FFT_BINS - 1) * BEAT_THIS_MEL_BINS + BEAT_THIS_MEL_BINS - 1;
equivalenceFilterbank[finalFilterbankIndex] = 0.75;

const makeSamples = (length: number): Float32Array => {
  const samples = new Float32Array(length);
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = Math.sin(index * 0.013) * 0.6 + Math.cos(index * 0.0037) * 0.4;
  }
  return samples;
};

const assertDirectWindowsEqualLegacy = (samples: Float32Array): BeatThisWindow[] => {
  const features = preprocessBeatThis(samples, equivalenceFilterbank);
  return beatThisWindowStarts(features.frames).map((start) => {
    const expected = createBeatThisWindow(features, start);
    const actual = preprocessBeatThisWindow(samples, equivalenceFilterbank, start);
    assert.equal(actual.start, expected.start);
    assert.equal(actual.frames, expected.frames);
    assert.equal(actual.values.length, expected.values.length);
    let maxDelta = 0;
    for (let index = 0; index < actual.values.length; index += 1) {
      maxDelta = Math.max(maxDelta, Math.abs(actual.values[index]! - expected.values[index]!));
    }
    assert.ok(maxDelta <= 1e-6, `window ${start} differs by ${maxDelta}`);
    return actual;
  });
};

const shortDirectWindows = assertDirectWindowsEqualLegacy(makeSamples(BEAT_THIS_HOP_LENGTH * 3 + 17));
assert.equal(shortDirectWindows.length, 1);
assert.ok(shortDirectWindows[0]!.values
  .subarray(0, BEAT_THIS_BORDER_FRAMES * BEAT_THIS_MEL_BINS)
  .every((value) => value === 0));
assert.ok(shortDirectWindows[0]!.values
  .subarray((shortDirectWindows[0]!.frames - BEAT_THIS_BORDER_FRAMES) * BEAT_THIS_MEL_BINS)
  .every((value) => value === 0));

const multiDirectWindows = assertDirectWindowsEqualLegacy(
  makeSamples(BEAT_THIS_CHUNK_FRAMES * BEAT_THIS_HOP_LENGTH),
);
assert.equal(multiDirectWindows.length, 2);
assert.ok(multiDirectWindows[0]!.values
  .subarray(0, BEAT_THIS_BORDER_FRAMES * BEAT_THIS_MEL_BINS)
  .every((value) => value === 0));
const finalDirectWindow = multiDirectWindows[multiDirectWindows.length - 1]!;
assert.ok(finalDirectWindow.values
  .subarray((BEAT_THIS_CHUNK_FRAMES - BEAT_THIS_BORDER_FRAMES) * BEAT_THIS_MEL_BINS)
  .every((value) => value === 0));

const smallValues = new Float32Array(100 * BEAT_THIS_MEL_BINS);
smallValues[0] = 7;
smallValues[smallValues.length - 1] = 9;
const smallWindows = splitBeatThisFeatures({ values: smallValues, frames: 100 });
assert.equal(smallWindows.length, 1);
assert.equal(smallWindows[0]!.frames, 112);
assert.equal(smallWindows[0]!.values[6 * BEAT_THIS_MEL_BINS], 7);
assert.equal(smallWindows[0]!.values[(105 * BEAT_THIS_MEL_BINS) + BEAT_THIS_MEL_BINS - 1], 9);
assert.equal(smallWindows[0]!.values[0], 0);

const seamFeatures = { values: new Float32Array(1_490 * BEAT_THIS_MEL_BINS), frames: 1_490 };
const seamWindows = splitBeatThisFeatures(seamFeatures);
assert.deepEqual(seamWindows.map((window) => window.start), [-6, -4]);
const predictions: BeatThisWindowLogits[] = seamWindows.map((window, index) => ({
  beat: new Float32Array(window.frames).fill(index + 1),
  downbeat: new Float32Array(window.frames).fill((index + 1) * 10),
}));
const merged = mergeBeatThisLogits(seamWindows, predictions, seamFeatures.frames);
assert.equal(merged.beat[0], 1);
assert.equal(merged.beat[1_487], 1);
assert.equal(merged.beat[1_488], 2);
assert.equal(merged.beat[1_489], 2);
assert.equal(merged.downbeat[1_487], 10);
assert.equal(merged.downbeat[1_488], 20);

assert.throws(
  () => preprocessBeatThis(new Float32Array(512), filterbank),
  /more than 512 samples/,
);
assert.throws(
  () => preprocessBeatThis(impulse, new Float32Array(1)),
  /filterbank length/,
);

console.log('beatThisPreprocess.verify: ok');
