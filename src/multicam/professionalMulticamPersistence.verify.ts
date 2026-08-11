import assert from 'node:assert/strict';
import { CURRENT_PROJECT_VERSION } from '../../shared/project-version';
import { projectReduce } from '../editor/reduce';
import type { MediaAsset, ProjectDoc, TimelineItem, TimelineState } from '../editor/types';
import { planPersistentCamSwitch } from './changeCam';
import { persistMulticamGroup } from './groups';
import { runMulticamSync } from './sync';
import { makeId, timeline, video } from './professionalMulticam.fixtures';

export const verifyProfessionalMulticamPersistence = async (): Promise<void> => {
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
  assert.equal(relinkedAngleA.source.durationInFrames, 120, 'relink preserves the authored multicam source window');
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
};
