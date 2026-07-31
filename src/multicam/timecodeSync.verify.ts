import assert from 'node:assert/strict';
import { sourceClockFrameAtItemIn } from '../editor/timecode';
import { sourceFrameAt } from '../editor/sourceLimit';
import type { MediaAsset, SourceClockMetadata, TimelineItem } from '../editor/types';
import { clockSyncPlacement } from './timecodeSync';

const clock = (frameCount: number, numerator: number, denominator = 1, dropFrame = false): SourceClockMetadata => ({
  frameCount,
  frameRate: { numerator, denominator },
  dropFrame,
});

const item = (
  id: string,
  startFrame: number,
  srcInFrame: number,
  playbackRate = 1,
): TimelineItem => ({
  id,
  track: id,
  startFrame,
  durationInFrames: 120,
  srcInFrame,
  playbackRate,
  name: id,
  kind: 'video',
  src: `/media/${id}.mov`,
});

const assets = (
  reference: TimelineItem,
  follower: TimelineItem,
  referenceClock: SourceClockMetadata,
  followerClock: SourceClockMetadata,
): MediaAsset[] => [
  { id: 'asset-reference', name: 'Reference', kind: 'video', src: reference.src!, durationInFrames: 300, sourceTimecode: referenceClock },
  { id: 'asset-follower', name: 'Follower', kind: 'video', src: follower.src!, durationInFrames: 300, sourceTimecode: followerClock },
];

{
  const reference = item('reference-equal', 100, 30);
  const follower = item('follower-equal', 900, 30);
  const placement = clockSyncPlacement(
    reference,
    follower,
    assets(reference, follower, clock(0, 24), clock(0, 30_000, 1_001, true)),
    30,
  );
  assert.equal(placement?.offsetFrames, 0, 'same wall-clock one-second trim aligns mixed native rates');
  assert.equal(placement?.startFrame, 100, 'clock placement remains reference-anchored');
}

{
  const reference = item('reference-trim', 100, 30);
  const follower = item('follower-trim', 900, 60);
  const placement = clockSyncPlacement(
    reference,
    follower,
    assets(reference, follower, clock(0, 24), clock(0, 30)),
    30,
  );
  assert.equal(placement?.offsetFrames, 30, 'one extra second of follower trim maps to 30 project frames');
  assert.equal(placement?.startFrame, 130);
}

{
  const reference = item('reference-fast', 10, 0, 2);
  const follower = item('follower-fast', 500, 0, 2);
  const referenceClock = clock(0, 30);
  const followerClock = clock(30, 30);
  const placement = clockSyncPlacement(
    reference,
    follower,
    assets(reference, follower, referenceClock, followerClock),
    30,
  )!;
  assert.equal(placement.offsetFrames, 15, 'a one-second source clock offset occupies 15 timeline frames at 2x');
  assert.equal(placement.startFrame, 25);

  const referenceSourceAtPlacement = sourceFrameAt(reference, placement.startFrame - reference.startFrame);
  const followerSourceAtPlacement = sourceFrameAt(follower, 0);
  const referenceGlobalClock = sourceClockFrameAtItemIn(referenceClock, { srcInFrame: referenceSourceAtPlacement }, 30);
  const followerGlobalClock = sourceClockFrameAtItemIn(followerClock, { srcInFrame: followerSourceAtPlacement }, 30);
  assert.equal(referenceGlobalClock, followerGlobalClock, 'both angles resolve to the same physical clock at the placement frame');
}

console.log('timecodeSync.verify: ok (mixed rates, trim offsets, 2x placement, global clock invariant)');
