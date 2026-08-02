import assert from 'node:assert/strict';
import type { TimelineState } from '../../editor/types';
import { timelineFitTotalFrames } from './timelineFitRange';

const state: TimelineState = {
  fps: 30,
  width: 1080,
  height: 1920,
  selectedId: null,
  trackOrder: ['track_c1', 'track_v1'],
  tracks: {
    track_c1: {
      kind: 'caption',
      captions: {
        enabled: true,
        template: 'plain',
        pacing: 'phrase',
        sourceEntries: [{
          id: 'manual:one',
          itemId: 'manual:one',
          words: [{ text: 'Test caption', start: 12_000, end: 20_000 }],
        }],
      },
    },
    track_v1: { kind: 'video' },
  },
  items: [{
    id: 'video-1',
    track: 'track_v1',
    kind: 'video',
    name: 'video.mp4',
    startFrame: 0,
    durationInFrames: 300,
    src: '/media/uploads/video.mp4',
  }],
};

assert.equal(
  timelineFitTotalFrames(state),
  600,
  'fit-to-view must include caption cues that outlast media clips',
);
assert.equal(
  timelineFitTotalFrames({ ...state, items: [] }),
  600,
  'caption-only timelines must remain fit-to-view compatible',
);
assert.equal(
  timelineFitTotalFrames({
    ...state,
    items: [],
    trackOrder: ['track_v1'],
    tracks: { track_v1: { kind: 'video' } },
    captions: {
      enabled: true,
      template: 'plain',
      pacing: 'phrase',
      words: [{ text: 'Legacy caption', start: 0, end: 20_000 }],
    },
  }),
  600,
  'legacy captions must participate before caption-track migration',
);

console.log('timelineFitRange.verify: captions participate in fit-to-view range');
