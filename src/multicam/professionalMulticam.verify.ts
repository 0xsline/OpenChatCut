import assert from 'node:assert/strict';
import { CURRENT_PROJECT_VERSION } from '../../shared/project-version';
import { projectReduce } from '../editor/reduce';
import type { MediaAsset, MulticamGroup, ProjectDoc, TimelineItem, TimelineState } from '../editor/types';
import { sourceFrameAt } from '../editor/sourceLimit';
import { planPersistentCamSwitch, type PersistentCamSwitchPlan } from './changeCam';
import { persistMulticamGroup } from './groups';
import { runMulticamSync } from './sync';
import { clockSyncPlacement } from './timecodeSync';

const video = (id: string, track: string, startFrame: number, src: string): TimelineItem => ({
  id,
  track,
  startFrame,
  durationInFrames: 120,
  name: id,
  kind: 'video',
  src,
  srcInFrame: 0,
});

const timeline = (items: TimelineItem[]): TimelineState => ({
  fps: 30,
  width: 1920,
  height: 1080,
  items,
  trackOrder: ['v1', 'v2'],
  tracks: { v1: { kind: 'video' }, v2: { kind: 'video' } },
  selectedId: null,
  selectedIds: [],
});

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

let sequence = 0;
const makeId = () => `generated_${++sequence}`;

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


// Switching back into a previously removed angle restores its immutable source,
// replaces the overlapping decision, and still commits as one complete state.
{
  const sourceA = { ...video('cam-a', 'v1', 0, '/media/a.mov'), multicamGroupId: 'group', multicamAngleId: 'angle-a' };
  const sourceB = { ...video('cam-b', 'v2', 0, '/media/b.mov'), multicamGroupId: 'group', multicamAngleId: 'angle-b' };
  const group: MulticamGroup = {
    id: 'group',
    referenceAngleId: 'angle-a',
    masterAngleId: 'angle-a',
    syncMethod: 'audio',
    angles: [
      { id: 'angle-a', itemId: 'cam-a', source: sourceA, label: 'A', offsetFrames: 0, confidence: 0.9 },
      { id: 'angle-b', itemId: 'cam-b', source: sourceB, label: 'B', offsetFrames: 0, confidence: 0.85 },
    ],
    evidence: [
      { angleId: 'angle-a', method: 'audio', confidence: 0.9, offsetFrames: 0, lagSeconds: 0 },
      { angleId: 'angle-b', method: 'audio', confidence: 0.85, offsetFrames: 0, lagSeconds: 0 },
    ],
  };
  const initial: TimelineState = { ...timeline([sourceA, sourceB]), multicamGroups: [group] };
  const first = planPersistentCamSwitch({
    state: initial,
    groupId: group.id,
    angleId: 'angle-a',
    fromFrame: 0,
    toFrame: 60,
    makeId,
  });
  assert.equal('error' in first, false);
  if ('error' in first) throw new Error(first.error);
  assert.deepEqual(
    first.nextState.items.filter((item) => item.multicamAngleId === 'angle-b')
      .map((item) => [item.startFrame, item.startFrame + item.durationInFrames]),
    [[60, 120]],
  );

  const second = planPersistentCamSwitch({
    state: first.nextState,
    groupId: group.id,
    angleId: 'angle-b',
    fromFrame: 30,
    toFrame: 60,
    makeId,
  });
  assert.equal('error' in second, false);
  if ('error' in second) throw new Error(second.error);
  assert(second.restoredItemIds.length > 0);
  assert(second.nextState.items.some((item) => item.multicamAngleId === 'angle-b'
    && item.startFrame === 30 && item.durationInFrames === 30));
  assert.deepEqual(
    second.group.decisions?.map((decision) => [decision.fromFrame, decision.toFrame, decision.angleId]),
    [[0, 30, 'angle-a'], [30, 60, 'angle-b']],
  );

  const failed = planPersistentCamSwitch({
    state: second.nextState,
    groupId: group.id,
    angleId: 'angle-b',
    fromFrame: 0,
    toFrame: 150,
    makeId,
  });
  assert.match('error' in failed ? failed.error : '', /does not cover/);
}

// Switch planning follows the live fragment tracks, rejects every no-op/coverage failure atomically,
// and reports removals only after the corresponding timeline edits have actually applied.
{
  const sourceA = { ...video('track-cam-a', 'v1', 0, '/media/track-a.mov'), multicamGroupId: 'track-group', multicamAngleId: 'track-angle-a' };
  const sourceB = { ...video('track-cam-b', 'v2', 0, '/media/track-b.mov'), multicamGroupId: 'track-group', multicamAngleId: 'track-angle-b' };
  const group: MulticamGroup = {
    id: 'track-group',
    referenceAngleId: 'track-angle-a',
    masterAngleId: 'track-angle-a',
    syncMethod: 'audio',
    angles: [
      { id: 'track-angle-a', itemId: sourceA.id, source: sourceA, label: 'A', offsetFrames: 0, confidence: 0.9 },
      { id: 'track-angle-b', itemId: sourceB.id, source: sourceB, label: 'B', offsetFrames: 0, confidence: 0.9 },
    ],
    evidence: [
      { angleId: 'track-angle-a', method: 'audio', confidence: 0.9, offsetFrames: 0 },
      { angleId: 'track-angle-b', method: 'audio', confidence: 0.9, offsetFrames: 0 },
    ],
  };
  const stateWithThirdTrack = (items: TimelineItem[], locked: boolean): TimelineState => ({
    ...timeline(items),
    items,
    trackOrder: ['v1', 'v2', 'v3'],
    tracks: {
      v1: { kind: 'video' },
      v2: { kind: 'video' },
      v3: { kind: 'video', locked },
    },
    multicamGroups: [group],
  });
  const assertAtomicFailure = (
    state: TimelineState,
    snapshot: string,
    result: PersistentCamSwitchPlan,
    message: RegExp,
  ) => {
    assert.match('error' in result ? result.error : '', message);
    assert.equal('nextState' in result, false);
    assert.equal('removed' in result, false);
    assert.equal(JSON.stringify(state), snapshot);
  };

  const movedB = { ...sourceB, track: 'v3' };
  const lockedActualTrack = stateWithThirdTrack([sourceA, movedB], true);
  const lockedSnapshot = JSON.stringify(lockedActualTrack);
  const lockedResult = planPersistentCamSwitch({
    state: lockedActualTrack,
    groupId: group.id,
    angleId: 'track-angle-a',
    fromFrame: 0,
    toFrame: 60,
    makeId,
  });
  assertAtomicFailure(lockedActualTrack, lockedSnapshot, lockedResult, /locked/);

  const unlockedActualTrack = stateWithThirdTrack([sourceA, movedB], false);
  const unlockedResult = planPersistentCamSwitch({
    state: unlockedActualTrack,
    groupId: group.id,
    angleId: 'track-angle-a',
    fromFrame: 0,
    toFrame: 60,
    makeId,
  });
  assert.equal('error' in unlockedResult, false);
  if ('error' in unlockedResult) throw new Error(unlockedResult.error);
  assert.deepEqual(unlockedResult.removed, [{ itemId: sourceB.id, fromFrame: 0, toFrame: 60 }]);
  assert.deepEqual(
    unlockedResult.nextState.items.filter((item) => item.multicamAngleId === 'track-angle-b')
      .map((item) => [item.startFrame, item.startFrame + item.durationInFrames, item.track]),
    [[60, 120, 'v3']],
  );

  const restoredB = {
    ...sourceB,
    id: 'restored-track-cam-b',
    track: 'v3',
    startFrame: 30,
    durationInFrames: 30,
    srcInFrame: 30,
  };
  const lockedRestoredTrack = stateWithThirdTrack([sourceA, restoredB], true);
  const restoredSnapshot = JSON.stringify(lockedRestoredTrack);
  const restoredResult = planPersistentCamSwitch({
    state: lockedRestoredTrack,
    groupId: group.id,
    angleId: 'track-angle-a',
    fromFrame: 30,
    toFrame: 60,
    makeId,
  });
  assertAtomicFailure(lockedRestoredTrack, restoredSnapshot, restoredResult, /locked/);

  const staleDuplicate = { ...sourceB, startFrame: 90, durationInFrames: 30 };
  const activeDuplicate = { ...sourceB };
  const noOpState: TimelineState = {
    ...timeline([sourceA, staleDuplicate, activeDuplicate]),
    multicamGroups: [group],
  };
  const noOpSnapshot = JSON.stringify(noOpState);
  const noOpResult = planPersistentCamSwitch({
    state: noOpState,
    groupId: group.id,
    angleId: 'track-angle-a',
    fromFrame: 30,
    toFrame: 60,
    makeId,
  });
  assertAtomicFailure(noOpState, noOpSnapshot, noOpResult, /failed to apply planned multicam removal/);

  const untaggedSourceA = video('track-cam-a', 'v1', 0, '/media/track-a.mov');
  const restoredGroup: MulticamGroup = {
    ...group,
    angles: group.angles.map((entry) =>
      entry.id === 'track-angle-a' ? { ...entry, source: untaggedSourceA } : entry),
  };
  const restoreState: TimelineState = {
    ...timeline([sourceB]),
    multicamGroups: [restoredGroup],
  };
  const restoredSwitch = planPersistentCamSwitch({
    state: restoreState,
    groupId: restoredGroup.id,
    angleId: 'track-angle-a',
    fromFrame: 0,
    toFrame: 60,
    makeId,
  });
  assert.equal('error' in restoredSwitch, false);
  if ('error' in restoredSwitch) throw new Error(restoredSwitch.error);
  const restoredAngleA = restoredSwitch.nextState.items.find((item) =>
    restoredSwitch.restoredItemIds.includes(item.id));
  assert(restoredAngleA);
  assert.equal(restoredAngleA.multicamGroupId, restoredGroup.id);
  assert.equal(restoredAngleA.multicamAngleId, 'track-angle-a');

  const restoredOnLockedTrack: TimelineState = {
    ...restoredSwitch.nextState,
    items: restoredSwitch.nextState.items.map((item) =>
      item.id === restoredAngleA.id ? { ...item, track: 'v3' } : item),
    trackOrder: [...(restoredSwitch.nextState.trackOrder ?? []), 'v3'],
    tracks: {
      ...restoredSwitch.nextState.tracks,
      v3: { kind: 'video', locked: true },
    },
  };
  const generatedRestoredSnapshot = JSON.stringify(restoredOnLockedTrack);
  const generatedRestoredResult = planPersistentCamSwitch({
    state: restoredOnLockedTrack,
    groupId: restoredGroup.id,
    angleId: 'track-angle-b',
    fromFrame: 0,
    toFrame: 30,
    makeId,
  });
  assertAtomicFailure(
    restoredOnLockedTrack,
    generatedRestoredSnapshot,
    generatedRestoredResult,
    /locked/,
  );

  const ambiguousTarget = { ...sourceA, multicamAngleId: 'track-angle-b' };
  const coverageState: TimelineState = {
    ...timeline([ambiguousTarget]),
    multicamGroups: [group],
  };
  const coverageSnapshot = JSON.stringify(coverageState);
  const coverageResult = planPersistentCamSwitch({
    state: coverageState,
    groupId: group.id,
    angleId: 'track-angle-a',
    fromFrame: 0,
    toFrame: 60,
    makeId,
  });
  assertAtomicFailure(
    coverageState,
    coverageSnapshot,
    coverageResult,
    /selected multicam angle does not cover/,
  );
}

// Re-sync translates the immutable source placement without replacing its media window
// with a sliced live fragment, and invalidates decisions anchored to the old placement.
{
  const originalA = {
    ...video('resync-cam-a', 'v1', 100, '/media/resync-a.mov'),
    srcInFrame: 12,
    sourceRevision: 'resync-revision-a',
  };
  const originalB = {
    ...video('resync-cam-b', 'v2', 100, '/media/resync-b.mov'),
    sourceRevision: 'resync-revision-b',
  };
  const initial = persistMulticamGroup(
    timeline([originalA, originalB]),
    originalA.id,
    [
      {
        itemId: originalA.id,
        startFrame: 100,
        offsetFrames: 0,
        confidence: 0.9,
        method: 'audio',
        evidence: { method: 'audio', confidence: 0.9, offsetFrames: 0, lagSeconds: 0 },
      },
      {
        itemId: originalB.id,
        startFrame: 100,
        offsetFrames: 0,
        confidence: 0.85,
        method: 'audio',
        evidence: { method: 'audio', confidence: 0.85, offsetFrames: 0, lagSeconds: 0 },
      },
    ],
    { groupId: 'resync-group', makeId },
  );
  assert(initial);
  const initialAngleA = initial.group.angles.find((angle) => angle.itemId === originalA.id);
  const initialAngleB = initial.group.angles.find((angle) => angle.itemId === originalB.id);
  assert(initialAngleA);
  assert(initialAngleB);
  const syncedA = initial.state.items.find((item) => item.id === originalA.id);
  assert(syncedA);
  const slicedA = {
    ...syncedA,
    id: 'resync-fragment-a',
    durationInFrames: 60,
  };
  const stateWithSlice: TimelineState = {
    ...initial.state,
    items: initial.state.items.map((item) => item.id === originalA.id ? slicedA : item),
    multicamGroups: [{
      ...initial.group,
      decisions: [{
        id: 'stale-resync-decision',
        fromFrame: 100,
        toFrame: 160,
        angleId: initialAngleB.id,
      }],
    }],
  };
  const resynced = persistMulticamGroup(
    stateWithSlice,
    slicedA.id,
    [
      {
        itemId: slicedA.id,
        startFrame: 120,
        offsetFrames: 0,
        confidence: 0.95,
        method: 'audio',
        evidence: { method: 'audio', confidence: 0.95, offsetFrames: 0, lagSeconds: 0 },
      },
      {
        itemId: originalB.id,
        startFrame: 120,
        offsetFrames: 0,
        confidence: 0.9,
        method: 'audio',
        evidence: { method: 'audio', confidence: 0.9, offsetFrames: 0, lagSeconds: 0 },
      },
    ],
    { groupId: initial.group.id, makeId },
  );
  assert(resynced);
  const resyncedA = resynced.group.angles.find((angle) => angle.id === initialAngleA.id);
  assert(resyncedA);
  assert.equal(resyncedA.itemId, originalA.id);
  assert.equal(resyncedA.source.startFrame, 120);
  assert.equal(resyncedA.source.track, slicedA.track);
  assert.equal(resyncedA.source.src, originalA.src);
  assert.equal(resyncedA.source.srcInFrame, 12);
  assert.equal(resyncedA.source.durationInFrames, 120);
  assert.equal(resyncedA.source.sourceRevision, originalA.sourceRevision);
  assert.equal(
    resynced.state.items.find((item) => item.id === slicedA.id)?.durationInFrames,
    60,
  );
  assert.equal(
    resynced.state.items.find((item) => item.id === slicedA.id)?.srcInFrame,
    12,
  );
  assert.equal(resynced.group.decisions, undefined);

  const switchedAway = planPersistentCamSwitch({
    state: resynced.state,
    groupId: resynced.group.id,
    angleId: initialAngleB.id,
    fromFrame: 120,
    toFrame: 180,
    makeId,
  });
  assert.equal('error' in switchedAway, false);
  if ('error' in switchedAway) throw new Error(switchedAway.error);
  const switchedBack = planPersistentCamSwitch({
    state: switchedAway.nextState,
    groupId: resynced.group.id,
    angleId: initialAngleA.id,
    fromFrame: 120,
    toFrame: 180,
    makeId,
  });
  assert.equal('error' in switchedBack, false);
  if ('error' in switchedBack) throw new Error(switchedBack.error);
  const restoredA = switchedBack.nextState.items.find((item) =>
    switchedBack.restoredItemIds.includes(item.id));
  assert(restoredA);
  assert.equal(restoredA.startFrame, 120);
  assert.equal(restoredA.src, originalA.src);
  assert.equal(restoredA.srcInFrame, 12);
  assert.equal(restoredA.sourceRevision, originalA.sourceRevision);
  assert(
    switchedBack.group.decisions?.every((decision) =>
      decision.fromFrame >= resyncedA.source.startFrame
      && decision.toFrame <= resyncedA.source.startFrame + resyncedA.source.durationInFrames),
  );
}

// A relink updates the immutable multicam source as well as live pool/timeline state,
// so switching back cannot resurrect bytes or derivatives from the previous revision.
{
  const oldSrc = '/media/relink-angle-old.mov';
  const newSrc = '/media/relink-angle-new.mov';
  const oldRevision = 'source-revision-old';
  const newRevision = 'source-revision-new';
  const sourceClock = {
    frameCount: 0,
    frameRate: { numerator: 30, denominator: 1 },
    dropFrame: false,
  };
  const sourceA = {
    ...video('relink-cam-a', 'v1', 0, oldSrc),
    sourceRevision: oldRevision,
    width: 640,
    height: 360,
    transcript: [{ text: 'old source', start: 0, end: 1_000 }],
    denoisedSrc: '/media/relink-angle-old-denoised.wav',
    denoiseStrength: 75,
    sourceTimecode: sourceClock,
    captureClock: sourceClock,
  };
  const sourceB = {
    ...video('relink-cam-b', 'v2', 0, '/media/relink-angle-b.mov'),
    sourceRevision: 'source-revision-b',
  };
  const assetA: MediaAsset = {
    id: 'relink-asset-a',
    name: 'Relink A',
    kind: 'video',
    src: oldSrc,
    durationInFrames: 120,
    sourceRevision: oldRevision,
    width: 640,
    height: 360,
    transcript: [{ text: 'old source', start: 0, end: 1_000 }],
    sourceTimecode: sourceClock,
    captureClock: sourceClock,
  };
  const assetB: MediaAsset = {
    id: 'relink-asset-b',
    name: 'Relink B',
    kind: 'video',
    src: sourceB.src!,
    durationInFrames: 120,
    sourceRevision: 'source-revision-b',
    sourceTimecode: sourceClock,
  };
  const synced = await runMulticamSync({
    state: { ...timeline([sourceA, sourceB]), assets: [assetA, assetB] },
    itemIds: [sourceA.id, sourceB.id],
    referenceItemId: sourceA.id,
    makeId,
  });
  assert.equal(synced.status, 'already_synced');
  assert(synced.nextState);
  const syncedGroup = synced.nextState.multicamGroups?.[0];
  assert(syncedGroup);
  const angleA = syncedGroup.angles.find((entry) => entry.itemId === sourceA.id);
  const angleB = syncedGroup.angles.find((entry) => entry.itemId === sourceB.id);
  assert(angleA);
  assert(angleB);

  const switchedAway = planPersistentCamSwitch({
    state: synced.nextState,
    groupId: syncedGroup.id,
    angleId: angleB.id,
    fromFrame: 0,
    toFrame: 120,
    makeId,
  });
  assert.equal('error' in switchedAway, false);
  if ('error' in switchedAway) throw new Error(switchedAway.error);
  assert.equal(
    switchedAway.nextState.items.some((item) => item.multicamAngleId === angleA.id),
    false,
  );

  const timelineId = 'relink-multicam-timeline';
  const doc: ProjectDoc = {
    version: CURRENT_PROJECT_VERSION,
    assets: [assetA, assetB],
    mediaFolders: [],
    timelines: [{
      ...switchedAway.nextState,
      id: timelineId,
      name: 'Relink Multicam',
      order: 0,
    }],
    activeTimelineId: timelineId,
  };
  const relinked = projectReduce(doc, {
    type: 'pool.relinkAsset',
    id: assetA.id,
    src: newSrc,
    name: 'Relink A New',
    durationInFrames: 150,
    width: 1920,
    height: 1080,
    sourceRevision: newRevision,
    sourceSize: 4_096,
    sourceModifiedAt: 999_999,
  });
  const relinkedAsset = relinked.assets.find((asset) => asset.id === assetA.id);
  const relinkedTimeline = relinked.timelines.find((entry) => entry.id === timelineId);
  const relinkedGroup = relinkedTimeline?.multicamGroups?.find((entry) => entry.id === syncedGroup.id);
  const relinkedAngleA = relinkedGroup?.angles.find((entry) => entry.id === angleA.id);
  const untouchedAngleB = relinkedGroup?.angles.find((entry) => entry.id === angleB.id);
  assert(relinkedAsset);
  assert(relinkedTimeline);
  assert(relinkedGroup);
  assert(relinkedAngleA);
  assert.equal(untouchedAngleB, switchedAway.group.angles.find((entry) => entry.id === angleB.id));
  assert.equal(relinkedAngleA.source.src, relinkedAsset.src);
  assert.equal(relinkedAngleA.source.sourceRevision, relinkedAsset.sourceRevision);
  assert.equal(relinkedAngleA.source.name, relinkedAsset.name);
  assert.equal(relinkedAngleA.source.width, relinkedAsset.width);
  assert.equal(relinkedAngleA.source.height, relinkedAsset.height);
  assert.equal(relinkedAngleA.source.durationInFrames, relinkedAsset.durationInFrames);
  assert.equal(relinkedAngleA.source.denoisedSrc, undefined);
  assert.equal(relinkedAngleA.source.denoiseStrength, undefined);
  assert.equal(relinkedAngleA.source.transcriptStale, true);
  assert.equal(relinkedAsset.sourceTimecode, undefined);
  assert.equal(relinkedAsset.captureClock, undefined);
  const relinkedSourceWithClocks = relinkedAngleA.source as TimelineItem & {
    sourceTimecode?: unknown;
    captureClock?: unknown;
  };
  assert.equal(relinkedSourceWithClocks.sourceTimecode, undefined);
  assert.equal(relinkedSourceWithClocks.captureClock, undefined);

  const switchedBack = planPersistentCamSwitch({
    state: relinkedTimeline,
    groupId: relinkedGroup.id,
    angleId: relinkedAngleA.id,
    fromFrame: 0,
    toFrame: 120,
    makeId,
  });
  assert.equal('error' in switchedBack, false);
  if ('error' in switchedBack) throw new Error(switchedBack.error);
  const restoredA = switchedBack.nextState.items.find((item) =>
    switchedBack.restoredItemIds.includes(item.id));
  assert(restoredA);
  assert.equal(restoredA.src, newSrc);
  assert.equal(restoredA.sourceRevision, newRevision);
  assert.equal(restoredA.width, 1920);
  assert.equal(restoredA.height, 1080);
  assert.equal(restoredA.denoisedSrc, undefined);
  assert.equal(restoredA.denoiseStrength, undefined);
  assert.equal(restoredA.transcriptStale, true);
  const restoredWithClocks = restoredA as TimelineItem & {
    sourceTimecode?: unknown;
    captureClock?: unknown;
  };
  assert.equal(restoredWithClocks.sourceTimecode, undefined);
  assert.equal(restoredWithClocks.captureClock, undefined);
}

console.log('professionalMulticam.verify: ok (persistent evidence + replaceable range switches)');
