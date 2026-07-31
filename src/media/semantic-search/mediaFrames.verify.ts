import assert from 'node:assert/strict';
import { sceneAwareSamplePlan } from './mediaFrames';

const staticInterview = sceneAwareSamplePlan(30 * 60, []);
assert.equal(staticInterview.length, 1, 'a long locked-off shot must not burn the semantic budget on duplicate frames');
assert.equal(staticInterview[0]?.sampleTime, 15 * 60);

const withFlashCut = sceneAwareSamplePlan(120, [30, 30.5, 60, 90], 3);
assert.equal(withFlashCut.length, 3, 'scene-aware sampling obeys the total budget');
assert.ok(
  withFlashCut.some((sample) => sample.sceneStart === 30 && sample.sceneEnd === 30.5),
  'a short but meaningful shot is retained when long shots compete for the budget',
);
assert.ok(withFlashCut.every((sample) => {
  assert.ok(sample.sceneStart !== undefined);
  assert.ok(sample.sceneEnd !== undefined);
  return sample.sampleTime >= sample.sceneStart && sample.sampleTime < sample.sceneEnd;
}), 'every embedding timestamp remains inside its traceable scene range');
assert.equal(new Set(withFlashCut.map((sample) => sample.sceneId)).size, withFlashCut.length);

const manyShots = sceneAwareSamplePlan(
  1_800,
  Array.from({ length: 180 }, (_, index) => (index + 1) * 9.9),
  96,
);
assert.equal(manyShots.length, 96, 'long videos retain a bounded adaptive index size');
assert.ok(manyShots.at(-1)!.sampleTime > 1_700, 'budgeted coverage reaches the end of a long source');

console.log('mediaFrames.verify: ok');
