import assert from 'node:assert/strict';
import { personFromSubject, segmentBoundaries } from './visual-geometry';

async function main(): Promise<void> {
  // 1. Scene boundaries from sampled frames (sceneStart/sceneEnd) are used.
  const frames = [
    { sampleTime: 0.5, sceneStart: 0, sceneEnd: 10 },
    { sampleTime: 3, sceneStart: 0, sceneEnd: 10 },
    { sampleTime: 12, sceneStart: 10, sceneEnd: 20 },
  ];
  const scenes = segmentBoundaries(frames, 20);
  assert.deepEqual(scenes, [
    { startSec: 0, endSec: 10 },
    { startSec: 10, endSec: 20 },
  ]);

  // 2. Sub-minimum scenes are dropped.
  const short = [
    { sampleTime: 0.1, sceneStart: 0, sceneEnd: 0.2 },
    { sampleTime: 5, sceneStart: 0, sceneEnd: 10 },
  ];
  const kept = segmentBoundaries(short, 10);
  assert.deepEqual(kept, [{ startSec: 0, endSec: 10 }]);

  // 3. No scene metadata → uniform buckets covering the full span.
  const plain = [{ sampleTime: 1 }, { sampleTime: 5 }];
  const buckets = segmentBoundaries(plain, 12);
  assert.ok(buckets.length >= 2, 'buckets cover the span');
  assert.equal(buckets[0]!.startSec, 0);
  assert.equal(buckets[buckets.length - 1]!.endSec, 12);

  // 4. personFromSubject side detection.
  assert.equal(personFromSubject({ x: 0.1, y: 0.2, w: 0.1, h: 0.3 }), 'left');
  assert.equal(personFromSubject({ x: 0.45, y: 0.2, w: 0.1, h: 0.3 }), 'center');
  assert.equal(personFromSubject({ x: 0.7, y: 0.2, w: 0.1, h: 0.3 }), 'right');
  assert.equal(personFromSubject(null), 'none');
  assert.equal(personFromSubject({ x: 0.1, y: 0.2, w: 0.01, h: 0.01 }), 'none', 'tiny bbox is not a person');

  console.log('visual-geometry.verify: all assertions passed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
