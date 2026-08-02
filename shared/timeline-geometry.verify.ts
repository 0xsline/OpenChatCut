import assert from 'node:assert/strict';
import {
  TIMELINE_MAX_HEIGHT,
  TIMELINE_MIN_HEIGHT,
  timelineHeightForVisibleTracks,
} from './timeline-geometry';

assert.equal(TIMELINE_MIN_HEIGHT, 288);
assert.equal(timelineHeightForVisibleTracks(4), 288);
assert.equal(timelineHeightForVisibleTracks(5), 344);
assert.equal(timelineHeightForVisibleTracks(6), 400);
assert.equal(timelineHeightForVisibleTracks(20), TIMELINE_MAX_HEIGHT);

console.log('timeline-geometry.verify: shared track geometry passed');
