import assert from 'node:assert/strict';
import { multicamOffsetFrames, multicamPlacementFrame } from './sync';
import type { TimelineItem } from '../editor/types';

const reference: TimelineItem = {
  id: 'master',
  track: 'V1',
  startFrame: 20,
  durationInFrames: 100,
  srcInFrame: 10,
  playbackRate: 2,
  kind: 'video',
  name: 'Master',
  src: '/media/take.mp4',
};

const follower = (startFrame: number, srcInFrame = 10): TimelineItem => ({
  id: `follower-${startFrame}`,
  track: 'V2',
  startFrame,
  durationInFrames: 100,
  srcInFrame,
  playbackRate: 1,
  kind: 'video',
  name: 'Follower',
  src: '/media/take.mp4',
});

{
  const near = follower(100);
  const far = follower(900);
  const nearOffset = multicamOffsetFrames(reference, near, 0, 30);
  const farOffset = multicamOffsetFrames(reference, far, 0, 30);
  assert.equal(nearOffset, 0);
  assert.equal(farOffset, nearOffset, 'computed sync offset is independent of the follower original placement');
  assert.equal(multicamPlacementFrame(reference, nearOffset), 20);
  assert.equal(multicamPlacementFrame(reference, farOffset), 20, 'both followers land on the master anchor, not their old startFrame');
}

{
  const trimmed = follower(700, 70);
  const offset = multicamOffsetFrames(reference, trimmed, 0, 30);
  assert.equal(offset, 30, 'visible source in-points are converted through the master playback rate');
  assert.equal(multicamPlacementFrame(reference, offset), 50);

  const delayed = multicamOffsetFrames(reference, trimmed, 1, 30);
  assert.equal(delayed, 15, 'positive source lag places the follower earlier relative to the master anchor');
  assert.equal(multicamPlacementFrame(reference, delayed), 35);
}

console.log('multicam/sync.verify: ok (master-anchored placement + visible source-window offsets)');
