import assert from 'node:assert/strict';
import type { MediaAsset, MulticamGroup, TimelineItem, TimelineState } from '../editor/types';
import { sourceFrameAt } from '../editor/sourceLimit';
import { runMulticamSync } from './sync';
import { clockSyncPlacement } from './timecodeSync';
import { makeId, timeline, video } from './professionalMulticam.fixtures';

export const verifyProfessionalMulticamSync = async (): Promise<void> => {
// Clock selection is deterministic: source timecode, then capture clock, then undefined for audio fallback.
{
  const reference = video('priority-a', 'v1', 0, '/media/priority-a.mov');
  const follower = video('priority-b', 'v2', 0, '/media/priority-b.mov');
  const sourceTimecode = { frameCount: 0, frameRate: { numerator: 24, denominator: 1 }, dropFrame: false };
  const captureClock = { frameCount: 48, frameRate: { numerator: 24, denominator: 1 }, dropFrame: false };
  const both = [
    { id: 'priority-a', name: 'A', kind: 'video' as const, src: reference.src!, durationInFrames: 120, sourceTimecode, captureClock },
    { id: 'priority-b', name: 'B', kind: 'video' as const, src: follower.src!, durationInFrames: 120, sourceTimecode, captureClock },
  ];
  assert.equal(clockSyncPlacement(reference, follower, both, 30)?.method, 'source-timecode');
  assert.equal(
    clockSyncPlacement(
      reference,
      follower,
      both.map(({ sourceTimecode: _sourceTimecode, ...asset }) => asset),
      30,
    )?.method,
    'capture-clock',
  );
  assert.equal(clockSyncPlacement(reference, follower, [both[0]!], 30), undefined);
}

// Source timecode wins without touching audio decode and creates queryable evidence.
{
  const reference = { ...video('cam-a', 'v1', 10, '/media/a.mov'), playbackRate: 2 };
  const follower = { ...video('cam-b', 'v2', 900, '/media/b.mov'), playbackRate: 2 };
  const state: TimelineState = {
    ...timeline([reference, follower]),
    assets: [
      {
        id: 'asset-a', name: 'A', kind: 'video', src: reference.src!, durationInFrames: 120,
        sourceTimecode: { frameCount: 2_400, frameRate: { numerator: 24, denominator: 1 }, dropFrame: false },
      },
      {
        id: 'asset-b', name: 'B', kind: 'video', src: follower.src!, durationInFrames: 120,
        sourceTimecode: { frameCount: 3_027, frameRate: { numerator: 30_000, denominator: 1_001 }, dropFrame: true },
      },
    ],
  };
  const result = await runMulticamSync({
    state,
    itemIds: [reference.id, follower.id],
    referenceItemId: reference.id,
    makeId,
  });
  assert.equal(result.status, 'applied');
  assert.equal(result.offsets[0]?.method, 'source-timecode');
  assert.equal(result.offsets[0]?.confidence, 1);
  assert.equal(result.nextState?.items.find((item) => item.id === follower.id)?.startFrame, 25);
  assert.equal(result.nextState?.multicamGroups?.[0]?.syncMethod, 'source-timecode');
  assert.equal(result.nextState?.multicamGroups?.[0]?.evidence[1]?.method, 'source-timecode');
  const alignedReference = result.nextState?.items.find((item) => item.id === reference.id);
  const alignedFollower = result.nextState?.items.find((item) => item.id === follower.id);
  assert(alignedReference);
  assert(alignedFollower);
  for (const delta of [0, 1, 37, 91]) {
    assert.equal(
      sourceFrameAt(alignedReference, delta) - sourceFrameAt(alignedReference, 0),
      sourceFrameAt(alignedFollower, delta) - sourceFrameAt(alignedFollower, 0),
      `same-rate angles retain source alignment ${delta} timeline frames after the anchor`,
    );
  }
  const clockSecondsAt = (
    item: TimelineItem,
    clock: NonNullable<MediaAsset['sourceTimecode']>,
    timelineFrame: number,
  ): number => clock.frameCount * clock.frameRate.denominator / clock.frameRate.numerator
    + (timelineFrame - item.startFrame) * (item.playbackRate ?? 1) / state.fps;
  const referenceClock = state.assets?.[0]?.sourceTimecode;
  const followerClock = state.assets?.[1]?.sourceTimecode;
  assert(referenceClock);
  assert(followerClock);
  for (const timelineFrame of [60, 91]) {
    assert(
      Math.abs(
        clockSecondsAt(alignedReference, referenceClock, timelineFrame)
        - clockSecondsAt(alignedFollower, followerClock, timelineFrame),
      ) <= (alignedReference.playbackRate ?? 1) / (2 * state.fps),
      `same-rate angles remain clock-aligned at global timeline frame ${timelineFrame}`,
    );
  }
}

// A single playback-rate mismatch rejects the complete group before clock/audio work,
// leaving every item and existing camera decision untouched.
{
  const reference = {
    ...video('rate-reference', 'v1', 10, '/media/rate-reference.mov'),
    playbackRate: 2,
    multicamGroupId: 'rate-group',
    multicamAngleId: 'rate-angle-reference',
  };
  const follower = {
    ...video('rate-follower', 'v2', 40, '/media/rate-follower.mov'),
    playbackRate: 1,
    multicamGroupId: 'rate-group',
    multicamAngleId: 'rate-angle-follower',
  };
  const decision = {
    id: 'rate-decision',
    fromFrame: 10,
    toFrame: 40,
    angleId: 'rate-angle-reference',
  };
  const group: MulticamGroup = {
    id: 'rate-group',
    referenceAngleId: 'rate-angle-reference',
    masterAngleId: 'rate-angle-reference',
    syncMethod: 'source-timecode',
    angles: [
      {
        id: 'rate-angle-reference', itemId: reference.id, source: reference,
        label: 'Reference', offsetFrames: 0, confidence: 1,
      },
      {
        id: 'rate-angle-follower', itemId: follower.id, source: follower,
        label: 'Follower', offsetFrames: 30, confidence: 1,
      },
    ],
    evidence: [
      {
        angleId: 'rate-angle-reference', method: 'source-timecode',
        confidence: 1, offsetFrames: 0,
      },
      {
        angleId: 'rate-angle-follower', method: 'source-timecode',
        confidence: 1, offsetFrames: 30,
      },
    ],
    decisions: [decision],
  };
  const state: TimelineState = {
    ...timeline([reference, follower]),
    multicamGroups: [group],
    assets: [
      {
        id: 'rate-asset-reference', name: 'Reference', kind: 'video',
        src: reference.src!, durationInFrames: 120,
        sourceTimecode: { frameCount: 0, frameRate: { numerator: 30, denominator: 1 }, dropFrame: false },
      },
      {
        id: 'rate-asset-follower', name: 'Follower', kind: 'video',
        src: follower.src!, durationInFrames: 120,
        sourceTimecode: { frameCount: 0, frameRate: { numerator: 30, denominator: 1 }, dropFrame: false },
      },
    ],
  };
  const snapshot = JSON.stringify(state);
  const result = await runMulticamSync({
    state,
    itemIds: [reference.id, follower.id],
    referenceItemId: reference.id,
    groupId: group.id,
    makeId,
  });
  assert.equal(result.status, 'failed');
  assert.equal(result.changed, false);
  assert.equal(result.nextState, undefined);
  assert.deepEqual(result.syncedItemIds, []);
  assert.deepEqual(result.skippedItemIds, [follower.id]);
  assert.match(result.message, /matching playback rates/i);
  assert.equal(JSON.stringify(state), snapshot);
  assert.deepEqual(state.multicamGroups?.[0]?.decisions, [decision]);
}
};
