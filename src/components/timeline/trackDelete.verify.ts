import assert from 'node:assert/strict';
import type { TimelineState } from '../../editor/types';
import { trackDeletePlan } from './trackDelete';

const base = {
  fps: 30,
  width: 1080,
  height: 1920,
  fit: 'contain',
  items: [],
  transitions: [],
  trackOrder: ['V1', 'V2', 'A1', 'C1'],
  tracks: {
    V1: { kind: 'video' },
    V2: { kind: 'video' },
    A1: { kind: 'audio' },
    C1: { kind: 'caption', captions: null },
  },
} as unknown as TimelineState;

assert.equal(trackDeletePlan(base, 'V1').requiresConfirmation, false);
assert.deepEqual(trackDeletePlan(base, 'V1').actions, [{ type: 'track.delete', tracks: ['V1'] }]);

const populated = {
  ...base,
  items: [{ id: 'clip', track: 'V1', kind: 'video', name: 'clip', startFrame: 0, durationInFrames: 30 }],
  transitions: [{ id: 'transition', trackId: 'V1', incomingItemId: 'clip', outgoingItemId: 'other', type: 'fade', durationInFrames: 6 }],
} as unknown as TimelineState;
const populatedPlan = trackDeletePlan(populated, 'V1');
assert.equal(populatedPlan.requiresConfirmation, true);
assert.deepEqual(populatedPlan.actions, [
  { type: 'removeTransition', id: 'transition' },
  { type: 'remove', id: 'clip' },
  { type: 'track.delete', tracks: ['V1'] },
]);

const captioned = {
  ...base,
  tracks: {
    ...base.tracks,
    C1: { kind: 'caption', captions: { enabled: true, sourceEntries: [] } },
  },
} as unknown as TimelineState;
const captionPlan = trackDeletePlan(captioned, 'C1');
assert.equal(captionPlan.requiresConfirmation, true);
assert.deepEqual(captionPlan.actions, [
  { type: 'setCaptions', captions: null, track: 'C1' },
  { type: 'track.delete', tracks: ['C1'] },
]);

const lastVideo = {
  ...base,
  trackOrder: ['V1', 'A1'],
  tracks: { V1: { kind: 'video' }, A1: { kind: 'audio' } },
} as unknown as TimelineState;
assert.equal(trackDeletePlan(lastVideo, 'V1').blockedReason, 'last-video');

const locked = {
  ...base,
  tracks: { ...base.tracks, A1: { kind: 'audio', locked: true } },
} as unknown as TimelineState;
assert.equal(trackDeletePlan(locked, 'A1').blockedReason, 'locked');

console.log('trackDelete.verify: confirmation, cascade and safety guards passed');
