import assert from 'node:assert/strict';
import { buildTrackingKeyframeActions } from './keyframeActions';
import { createGrayTemplate, findBestMatch } from './templateMatch';
import type { TimelineItem, TimelineState } from '../editor/types';
import type { TrackingResult } from './types';

function patternedFrame(width: number, height: number, patchX: number, patchY: number): Uint8Array {
  const frame = new Uint8Array(width * height).fill(18);
  for (let y = 0; y < 10; y += 1) {
    for (let x = 0; x < 12; x += 1) frame[(patchY + y) * width + patchX + x] = (x * 19 + y * 31) % 255;
  }
  return frame;
}

const width = 80;
const height = 60;
const first = patternedFrame(width, height, 9, 11);
const template = createGrayTemplate(first, width, 9, 11, 12, 10);
const match = findBestMatch(patternedFrame(width, height, 27, 24), width, height, template, 9, 11, 30);
assert.equal(match.x, 27);
assert.equal(match.y, 24);
assert.ok(match.confidence > 0.99);

const source: TimelineItem = { id: 'source', track: 'V1', startFrame: 10, durationInFrames: 60, name: 'video', kind: 'video', width: 1920, height: 1080 };
const target: TimelineItem = { id: 'target', track: 'V2', startFrame: 10, durationInFrames: 60, name: 'title', kind: 'text', transform: { x: 5, y: -2 } };
const state = { fps: 30, width: 1920, height: 1080, fit: 'contain', items: [source, target], selectedId: 'source', tracks: { V1: { kind: 'video' }, V2: { kind: 'video' } } } as TimelineState;
const result: TrackingResult = {
  points: [{ frame: 0, x: 0.4, y: 0.4, confidence: 1 }, { frame: 15, x: 0.5, y: 0.6, confidence: 0.9 }],
  averageConfidence: 0.95,
  processedFrames: 2,
  totalFrames: 2,
  videoWidth: 1920,
  videoHeight: 1080,
  stoppedBecauseLost: false,
};
const actions = buildTrackingKeyframeActions({ state, source, target, result, mode: 'follow' });
assert.equal(actions.length, 6);
assert.deepEqual(actions.at(-2), { type: 'setKeyframe', id: 'target', prop: 'x', frame: 15, value: 15, easing: 'linear' });
assert.deepEqual(actions.at(-1), { type: 'setKeyframe', id: 'target', prop: 'y', frame: 15, value: 18, easing: 'linear' });

console.log('motion tracking verification passed');
