import assert from 'node:assert/strict';
import { topClipOverlapSpans } from './trackOverlap';

assert.deepEqual(
  topClipOverlapSpans(100, 100, [
    { startFrame: 80, durationInFrames: 40 },
    { startFrame: 110, durationInFrames: 20 },
    { startFrame: 125, durationInFrames: 40 },
    { startFrame: 180, durationInFrames: 40 },
  ]),
  [
    { startFrame: 100, endFrame: 165 },
    { startFrame: 180, endFrame: 200 },
  ],
  'overlap spans should be clipped to the top item and merged',
);

assert.deepEqual(
  topClipOverlapSpans(100, 30, [{ startFrame: 0, durationInFrames: 50 }]),
  [],
  'non-overlapping clips should not create a warning region',
);

console.log('trackOverlap.verify: same-track overlap spans are clipped and merged');
