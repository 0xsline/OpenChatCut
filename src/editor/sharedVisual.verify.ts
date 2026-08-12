import assert from 'node:assert/strict';
import { shareableVisualItem } from './transitionAudio';
import type { TimelineItem } from './types';

const base: TimelineItem = {
  id: 'i1',
  track: 'track_v1',
  kind: 'video',
  src: '/media/uploads/x.mp4',
  srcInFrame: 0,
  startFrame: 0,
  durationInFrames: 60,
  name: 'clip',
  volume: 1,
  effects: [],
} as TimelineItem;

const clean = (over: Partial<TimelineItem> = {}, flags: Partial<Parameters<typeof shareableVisualItem>[0]> = {}) => (
  shareableVisualItem({
    item: { ...base, ...over } as TimelineItem,
    hasGlEffect: false,
    hasBackgroundFill: false,
    hasExtendBefore: false,
    hasExtendAfter: false,
    hasEntrance: false,
    ...flags,
  })
);

assert.equal(clean(), true, 'plain consecutive video clip shares');
assert.equal(clean({ kind: 'image' }), false, 'image never shares');
assert.equal(clean({ kind: 'audio' }), false, 'audio never shares');
assert.equal(clean({ src: '' }), false, 'missing src never shares');
assert.equal(clean({ denoisedSrc: '/media/x-denoised.wav' }), false, 'denoised clip keeps its own element');
assert.equal(clean({}, { hasGlEffect: true }), false, 'GL effect clips stay independent');
assert.equal(clean({}, { hasBackgroundFill: true }), false, 'background-fill clips stay independent');
assert.equal(clean({}, { hasExtendBefore: true }), false, 'transition-extended clips stay independent');
assert.equal(clean({}, { hasExtendAfter: true }), false, 'transition-extended clips stay independent');
assert.equal(clean({}, { hasEntrance: true }), false, 'entrance-animated clips stay independent');
assert.equal(clean({ zoom: { magnification: 2, focalPointX: 0.5, focalPointY: 0.5 } }), true, 'zoomed clips still share (zoom applies in the shared layer)');
assert.equal(clean({ transform: { x: 10 } }), false, 'transformed clips stay independent');
assert.equal(clean({ keyframes: { opacity: [{ frame: 0, value: 0.5 }] } }), false, 'keyframed clips stay independent');
assert.equal(clean({ filters: { brightness: 0.8 } }), false, 'filtered clips stay independent');

console.log('shared-visual predicate check passed');
