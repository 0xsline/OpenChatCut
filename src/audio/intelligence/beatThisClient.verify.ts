import assert from 'node:assert/strict';
import { analyzeBeatThis, pickBeatThisPeaks } from './beatThisClient';

const beat = new Float32Array(20).fill(-1);
beat[4] = 1;
beat[5] = 1;
beat[12] = 2;
beat[19] = 0;
const downbeat = new Float32Array(20).fill(-1);
downbeat[11] = 3;
downbeat[18] = 0;

assert.deepEqual(pickBeatThisPeaks(beat, downbeat), {
  beats: [4.5, 12],
  downbeats: [12],
});

const tiedDownbeats = new Float32Array(20).fill(-1);
tiedDownbeats[8] = 1;
tiedDownbeats[15] = 1;
assert.deepEqual(pickBeatThisPeaks(beat, tiedDownbeats), {
  beats: [4.5, 12],
  downbeats: [4.5, 12],
});

assert.deepEqual(
  pickBeatThisPeaks(new Float32Array([0, 0, 0]), new Float32Array([0, 0, 0])),
  { beats: [], downbeats: [] },
);
assert.throws(
  () => pickBeatThisPeaks(new Float32Array(2), new Float32Array(3)),
  /lengths do not match/,
);
const controller = new AbortController();
controller.abort(new DOMException('cancel beat analysis', 'AbortError'));
await assert.rejects(
  analyzeBeatThis(new Float32Array(513), 22_050, undefined, controller.signal),
  (error: unknown) => error instanceof Error && error.name === 'AbortError',
);


console.log('beatThisClient.verify: ok');
