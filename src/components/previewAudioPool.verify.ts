import assert from 'node:assert/strict';
import type { TimelineState } from '../editor/types';
import { PREVIEW_SHARED_AUDIO_TAGS, previewAudioTagCount } from './previewAudioPool';

const state = (items: TimelineState['items'], tracks: TimelineState['tracks'] = {}) => ({
  items,
  tracks,
} as TimelineState);
const audio = (id: string, startFrame: number, durationInFrames: number, track = 'A1') => ({
  id,
  name: id,
  kind: 'audio' as const,
  track,
  src: `/media/${id}.mp3`,
  startFrame,
  durationInFrames,
});

assert.equal(PREVIEW_SHARED_AUDIO_TAGS, 32);
assert.equal(previewAudioTagCount(state([])), 4);
assert.equal(previewAudioTagCount(state([audio('a', 0, 30), audio('b', 30, 30)])), 4);
assert.equal(
  previewAudioTagCount(state(Array.from({ length: 5 }, (_, i) => audio(`a${i}`, 0, 30, `A${i + 1}`)))),
  7,
);
assert.equal(previewAudioTagCount(state([audio('muted', 0, 30)], { A1: { muted: true } })), 4);
assert.equal(
  previewAudioTagCount(state(Array.from({ length: 40 }, (_, i) => audio(`a${i}`, 0, 30, `A${i + 1}`)))),
  32,
);

console.log('previewAudioPool.verify: stable pool and demand diagnostics passed');
