import assert from 'node:assert/strict';
import type { MulticamGroup, TimelineItem, TimelineState } from '../editor/types';
import { planPersistentCamSwitch, type PersistentCamSwitchPlan } from './changeCam';
import { makeId, timeline, video } from './professionalMulticam.fixtures';

export const verifyProfessionalMulticamSwitches = (): void => {
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
};
