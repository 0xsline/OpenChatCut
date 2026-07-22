import assert from 'node:assert/strict';
import { rateStretchItem } from './rateStretch';
import type { TimelineState } from './types';

const state: TimelineState = {
  fps: 30,
  width: 1920,
  height: 1080,
  selectedId: 'clip',
  tracks: { V1: { kind: 'video' } },
  trackOrder: ['V1'],
  items: [
    {
      id: 'clip', track: 'V1', startFrame: 10, durationInFrames: 100,
      name: 'clip', kind: 'video', src: '/media/uploads/clip.mp4',
      keyframes: { opacity: [{ frame: 50, value: 1 }] },
    },
    { id: 'next', track: 'V1', startFrame: 120, durationInFrames: 20, name: 'next', kind: 'video' },
  ],
};

const right = rateStretchItem(state, 'clip', 'right', 100);
assert.deepEqual(right.items[0]?.durationInFrames, 200);
assert.deepEqual(right.items[0]?.playbackRate, 0.5);
assert.deepEqual(right.items[0]?.keyframes?.opacity?.[0]?.frame, 100);
assert.deepEqual(right.items[1]?.startFrame, 120);

const left = rateStretchItem(state, 'clip', 'left', 20);
assert.deepEqual(left.items[0]?.startFrame, 30);
assert.deepEqual(left.items[0]?.durationInFrames, 80);
assert.deepEqual(left.items[0]?.playbackRate, 1.25);
assert.deepEqual(left.items[0]?.keyframes?.opacity?.[0]?.frame, 40);

const clamped = rateStretchItem(state, 'clip', 'right', -99);
assert.ok((clamped.items[0]?.playbackRate ?? 0) <= 8);
assert.ok((clamped.items[0]?.durationInFrames ?? 0) >= 13);

console.log('rateStretch.check: ok');
