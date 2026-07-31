import assert from 'node:assert/strict';
import {
  isSourceClockMetadata,
  sourceClockFrameAtItemIn,
  sourceClockOffsetInTimelineFrames,
  type TimelineFrameRate,
} from './timecode';
import type { SourceClockMetadata } from './types';

const clock = (
  numerator: number,
  denominator = 1,
  dropFrame = false,
): SourceClockMetadata => ({
  frameCount: 0,
  frameRate: { numerator, denominator },
  dropFrame,
});

const clockAtItemIn = (
  sourceClock: SourceClockMetadata,
  srcInFrame: number,
  timelineRate: TimelineFrameRate,
): SourceClockMetadata => ({
  ...sourceClock,
  frameCount: sourceClockFrameAtItemIn(sourceClock, { srcInFrame }, timelineRate),
});

const clocks = [
  clock(24),
  clock(30),
  clock(30_000, 1_001, true),
];

{
  const atOneSecond = clocks.map((sourceClock) => clockAtItemIn(sourceClock, 30, 30));
  assert.deepEqual(
    atOneSecond.map(({ frameCount }) => frameCount),
    [24, 30, 30],
    '30 project frames are rescaled into each source clock native frame domain',
  );
  for (const reference of atOneSecond) {
    for (const follower of atOneSecond) {
      assert.equal(
        sourceClockOffsetInTimelineFrames(reference, follower, 30),
        0,
        'equal one-second trims at 24/30/30000÷1001 clocks remain aligned',
      );
    }
  }
  assert.equal(
    Object.is(sourceClockOffsetInTimelineFrames(atOneSecond[2]!, atOneSecond[0]!, 30), -0),
    false,
    'public offset canonicalizes rounded negative zero for stable JSON/UI equality',
  );
}

{
  const reference = clockAtItemIn(clock(24), 30, 30);
  const follower30 = clockAtItemIn(clock(30), 60, 30);
  const followerDrop = clockAtItemIn(clock(30_000, 1_001, true), 60, 30);
  assert.equal(sourceClockOffsetInTimelineFrames(reference, follower30, 30), 30);
  assert.equal(sourceClockOffsetInTimelineFrames(reference, followerDrop, 30), 30);
  assert.equal(sourceClockOffsetInTimelineFrames(follower30, reference, 30), -30);
}

{
  const projectRate = { numerator: 30_000, denominator: 1_001 } as const;
  const atOneProjectSecond = clocks.map((sourceClock) => clockAtItemIn(sourceClock, 30, projectRate));
  assert.deepEqual(
    atOneProjectSecond.map(({ frameCount }) => frameCount),
    [24, 30, 30],
    'rational project rates use deterministic nearest-native-frame rounding',
  );
}

assert.equal(
  isSourceClockMetadata({ frameCount: 100, frameRate: { numerator: 24, denominator: 1 }, dropFrame: false }),
  true,
  'legacy persisted clock metadata remains readable without new fields',
);

console.log('timecode.verify: ok (project/native frame-domain conversion + rational/drop-frame clocks)');
