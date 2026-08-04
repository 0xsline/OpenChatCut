import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { historyReduce, projectReduce } from './reduce';
import { timelineItemAssetId, usedMediaAssetIds } from './mediaAssetUsage';
import { sourceRevisionForTimelineItem } from './mediaSourceRevision';
import { resolveTimelineRenderPlan } from './sequenceGraph';
import { remainingSourceFrames } from './sourceLimit';
import type { MediaAsset, MediaAssetRelinkPatch, ProjectDoc, Timeline, TimelineItem } from './types';

const assetA: MediaAsset = {
  id: 'asset-a', name: 'A.mp4', kind: 'video', src: '/media/shared.mp4', durationInFrames: 90, sourceRevision: 'rev-a',
};
const assetB: MediaAsset = {
  id: 'asset-b', name: 'B.mp4', kind: 'video', src: '/media/shared.mp4', durationInFrames: 180, sourceRevision: 'rev-b',
};
const otherAsset: MediaAsset = {
  id: 'asset-c', name: 'C.mp4', kind: 'video', src: '/media/other.mp4', durationInFrames: 90,
};
const clip = (id: string, name: string, src: string, sourceAssetId?: string): TimelineItem => ({
  id,
  track: 'V1',
  startFrame: 0,
  durationInFrames: 90,
  kind: 'video',
  name,
  src,
  sourceAssetId,
});
const linkedA = clip('linked-a', assetA.name, assetA.src, assetA.id);
const legacyA = clip('legacy-a', assetA.name, assetA.src);
const linkedB = clip('linked-b', assetB.name, assetB.src, assetB.id);
const other = clip('other', otherAsset.name, otherAsset.src, otherAsset.id);

const doc: ProjectDoc = {
  version: 3,
  assets: [assetA, assetB, otherAsset],
  mediaFolders: [],
  activeTimelineId: 'timeline-1',
  timelines: [
    {
      id: 'timeline-1',
      name: 'Main',
      order: 0,
      fps: 30,
      width: 1080,
      height: 1920,
      items: [linkedA, legacyA, linkedB, other],
      tracks: { V1: { kind: 'video', locked: true } },
      trackOrder: ['V1'],
      transitions: [{
        id: 'transition-a-b',
        type: 'cross-dissolve',
        durationInFrames: 12,
        outgoingItemId: linkedA.id,
        incomingItemId: linkedB.id,
        trackId: 'V1',
      }],
      linkGroups: [{
        id: 'linked-pair',
        itemIds: [linkedA.id, linkedB.id, other.id],
        anchorItemId: linkedA.id,
        mode: 'sync-lock',
      }],
      selectedId: linkedA.id,
      selectedIds: [linkedA.id, linkedB.id],
    },
    {
      id: 'timeline-2',
      name: 'Second',
      order: 1,
      fps: 30,
      width: 1080,
      height: 1920,
      items: [clip('linked-a-2', assetA.name, assetA.src, assetA.id)],
      tracks: { V1: { kind: 'video' } },
      trackOrder: ['V1'],
      selectedId: null,
    },
  ],
};

assert.equal(timelineItemAssetId(linkedA, doc.assets), assetA.id);
assert.equal(timelineItemAssetId(legacyA, doc.assets), assetA.id, 'legacy clips may resolve only when source and name are unambiguous');
assert.equal(timelineItemAssetId(clip('ambiguous', 'unknown', assetA.src), doc.assets), undefined);
assert.deepEqual([...usedMediaAssetIds(doc)].sort(), [assetA.id, assetB.id, otherAsset.id]);
assert.equal(sourceRevisionForTimelineItem(linkedA, [assetB, assetA, otherAsset]), 'rev-a');
assert.equal(remainingSourceFrames(linkedA, 30, [assetB, assetA, otherAsset]), 60);
assert.deepEqual(
  [...resolveTimelineRenderPlan(doc, 'timeline-1').assetIds].sort(),
  [assetA.id, assetB.id, otherAsset.id],
  'sequence/export dependency collection must not collapse duplicate source URLs',
);

const relinked = projectReduce(doc, {
  type: 'pool.relinkAsset',
  id: assetA.id,
  src: '/media/relinked.mp4',
  name: 'Relinked.mp4',
});
assert.equal(relinked.timelines[0]!.items.find((item) => item.id === linkedA.id)?.src, '/media/relinked.mp4');
assert.equal(relinked.timelines[0]!.items.find((item) => item.id === legacyA.id)?.sourceAssetId, assetA.id);
assert.equal(relinked.timelines[0]!.items.find((item) => item.id === linkedB.id)?.src, assetB.src, 'same-source duplicate must remain independent');

type TimelineRelinkItem = TimelineItem & Pick<MediaAssetRelinkPatch, 'sourceSize' | 'sourceModifiedAt'> & {
  sourceTimecode?: MediaAsset['sourceTimecode'];
  captureClock?: MediaAsset['captureClock'];
};
const sourceClock = {
  frameCount: 900,
  frameRate: { numerator: 30, denominator: 1 },
  dropFrame: false,
};
const clipBeforeRelink = {
  ...clip('clip-before-relink', 'Before.mp4', '/media/before.mp4', 'missing-pool-master'),
  startFrame: 30,
  durationInFrames: 30,
  width: 1920,
  height: 1080,
  sourceRevision: 'clip-revision-before',
  sourceSize: 100,
  sourceModifiedAt: 200,
  sourceFilename: 'original-before.mp4',
  originalFilePath: '/Users/editor/original-before.mp4',
  sourceTimecode: sourceClock,
  captureClock: sourceClock,
  denoisedSrc: '/media/before-denoised.wav',
  denoiseStrength: 75,
  transcript: [{ text: 'retained words', start: 0, end: 1_000 }],
  transcriptStale: false,
  props: { retained: 'top-level relink must not write here' },
} satisfies TimelineRelinkItem;
const clipBeforeRelinkPrior = {
  ...clip('clip-before-relink-prior', 'Prior.mp4', '/media/prior.mp4'),
  durationInFrames: 30,
};
const clipOnlyDoc: ProjectDoc = {
  ...doc,
  activeTimelineId: 'clip-only-timeline',
  timelines: [{
    ...doc.timelines[0]!,
    id: 'clip-only-timeline',
    items: [clipBeforeRelinkPrior, clipBeforeRelink],
    tracks: { V1: { kind: 'video' } },
    transitions: [{
      id: 'clip-only-transition',
      type: 'cross-dissolve',
      durationInFrames: 12,
      outgoingItemId: clipBeforeRelinkPrior.id,
      incomingItemId: clipBeforeRelink.id,
      trackId: 'V1',
    }],
    linkGroups: undefined,
    selectedId: clipBeforeRelink.id,
    selectedIds: [clipBeforeRelink.id],
  }],
};
const clipOnlyRelinkAction = {
  type: 'relinkTimelineItem',
  id: clipBeforeRelink.id,
  src: '/media/after.mp4',
  name: 'After.mp4',
  durationInFrames: 5,
  sourceRevision: 'clip-revision-after',
  sourceSize: 300,
  sourceModifiedAt: 400,
  originalFilePath: undefined,
} as const;
const clipOnlyRelinked = projectReduce(clipOnlyDoc, clipOnlyRelinkAction);
const clipAfterRelink = clipOnlyRelinked.timelines[0]!.items.find(
  (item) => item.id === clipBeforeRelink.id,
) as TimelineRelinkItem;
assert.equal(clipAfterRelink.src, '/media/after.mp4');
assert.equal(clipAfterRelink.name, 'After.mp4');
assert.equal(clipAfterRelink.durationInFrames, 5);
assert.equal(clipAfterRelink.sourceRevision, 'clip-revision-after');
assert.equal(clipAfterRelink.sourceSize, 300);
assert.equal(clipAfterRelink.sourceModifiedAt, 400);
assert.equal(clipAfterRelink.sourceAssetId, undefined, 'clip-only relink must detach the former pool master');
assert.equal(clipAfterRelink.denoisedSrc, undefined, 'clip-only relink must invalidate denoised audio');
assert.equal(clipAfterRelink.denoiseStrength, undefined, 'clip-only relink must invalidate denoise settings');
assert.equal(clipAfterRelink.sourceTimecode, undefined, 'clip-only relink must discard the old source timecode');
assert.equal(clipAfterRelink.captureClock, undefined, 'clip-only relink must discard the old capture clock');
assert.equal(clipAfterRelink.transcript, clipBeforeRelink.transcript, 'relink retains the transcript for review');
assert.equal(clipAfterRelink.transcriptStale, true, 'a retained transcript must be marked stale');
assert.deepEqual(clipAfterRelink.props, clipBeforeRelink.props, 'media fields must not be written into item props');
assert.equal(clipAfterRelink.width, 1920, 'omitted width must preserve the current value');
assert.equal(clipAfterRelink.height, 1080, 'omitted height must preserve the current value');
assert.equal(clipAfterRelink.kind, 'video', 'omitted kind must preserve the current value');
assert.equal(clipAfterRelink.sourceFilename, 'original-before.mp4', 'omitted source filename must be preserved');
assert.equal(clipAfterRelink.originalFilePath, undefined, 'explicitly undefined source metadata must be cleared');
assert.equal(clipAfterRelink.id, clipBeforeRelink.id);
assert.equal(clipAfterRelink.track, clipBeforeRelink.track);
assert.equal(clipAfterRelink.startFrame, clipBeforeRelink.startFrame);
assert.equal(
  clipOnlyRelinked.timelines[0]!.transitions?.[0]?.durationInFrames,
  5,
  'duration-changing relinks must reconcile transition handles',
);

const clipOnlyHistory = historyReduce(
  { past: [], present: clipOnlyDoc, future: [] },
  clipOnlyRelinkAction,
);
assert.equal(clipOnlyHistory.past.length, 1, 'one relink must create one undo step');
assert.equal(clipOnlyHistory.past[0], clipOnlyDoc);
assert.equal(historyReduce(clipOnlyHistory, { type: 'undo' }).present, clipOnlyDoc);

const lockedClipOnlyDoc: ProjectDoc = {
  ...clipOnlyDoc,
  timelines: clipOnlyDoc.timelines.map((timeline) => ({
    ...timeline,
    tracks: { ...timeline.tracks, V1: { ...timeline.tracks?.V1, kind: 'video', locked: true } },
  })),
};
assert.deepEqual(
  projectReduce(lockedClipOnlyDoc, clipOnlyRelinkAction),
  lockedClipOnlyDoc,
  'clip-only relink must no-op on a locked track',
);
assert.deepEqual(
  projectReduce(clipOnlyDoc, { ...clipOnlyRelinkAction, id: 'missing-item' }),
  clipOnlyDoc,
  'clip-only relink must no-op when the item is missing',
);

const renamed = projectReduce(doc, {
  type: 'pool.updateAsset', id: assetA.id, patch: { name: 'Renamed.mp4' },
});
assert.equal(renamed.timelines[0]!.items.find((item) => item.id === linkedA.id)?.name, 'Renamed.mp4');
assert.equal(renamed.timelines[0]!.items.find((item) => item.id === legacyA.id)?.name, 'Renamed.mp4');
assert.equal(renamed.timelines[0]!.items.find((item) => item.id === linkedB.id)?.name, assetB.name);
assert.equal(renamed.timelines[1]!.items[0]?.name, 'Renamed.mp4');

const removed = projectReduce(renamed, { type: 'pool.removeAsset', id: assetA.id });
assert.deepEqual(removed.timelines[0]!.items.map((item) => item.id), [linkedB.id, other.id]);
assert.equal(removed.timelines[1]!.items.length, 0, 'removal must cover every timeline');
assert.deepEqual(removed.timelines[0]!.transitions, [], 'transitions referencing removed clips must be removed');
assert.deepEqual(removed.timelines[0]!.linkGroups?.[0]?.itemIds, [linkedB.id, other.id]);
assert.equal(removed.timelines[0]!.linkGroups?.[0]?.anchorItemId, linkedB.id);
assert.deepEqual(removed.timelines[0]!.selectedIds, [linkedB.id]);
assert.equal(removed.timelines[0]!.selectedId, linkedB.id);

const targetAngleA = {
  ...clip('multicam-a', assetA.name, assetA.src, assetA.id),
  durationInFrames: 45,
  multicamGroupId: 'multicam-target',
  multicamAngleId: 'target-angle-a',
};
const targetAngleB = {
  ...clip('multicam-b', assetB.name, assetB.src, assetB.id),
  durationInFrames: 45,
  multicamGroupId: 'multicam-target',
  multicamAngleId: 'target-angle-b',
};
const targetAngleBSplit = {
  ...targetAngleB,
  id: 'multicam-b-split',
  startFrame: 45,
};
const independentAngleB = {
  ...clip('independent-b', assetB.name, assetB.src, assetB.id),
  multicamGroupId: 'multicam-independent',
  multicamAngleId: 'independent-angle-b',
};
const independentAngleC = {
  ...clip('independent-c', otherAsset.name, otherAsset.src, otherAsset.id),
  multicamGroupId: 'multicam-independent',
  multicamAngleId: 'independent-angle-c',
};
const multicamTimeline: Timeline = {
  ...doc.timelines[0]!,
  id: 'multicam-timeline',
  items: [targetAngleA, targetAngleB, targetAngleBSplit, independentAngleB, independentAngleC],
  multicamGroups: [
    {
      id: 'multicam-target',
      referenceAngleId: 'target-angle-a',
      masterAngleId: 'target-angle-a',
      angles: [
        {
          id: 'target-angle-a',
          itemId: targetAngleA.id,
          source: targetAngleA,
          label: 'Camera A',
          offsetFrames: 0,
          confidence: 1,
        },
        {
          id: 'target-angle-b',
          itemId: targetAngleB.id,
          source: targetAngleB,
          label: 'Camera B',
          offsetFrames: 0,
          confidence: 1,
        },
      ],
      syncMethod: 'audio' as const,
      evidence: [],
    },
    {
      id: 'multicam-independent',
      referenceAngleId: 'independent-angle-b',
      masterAngleId: 'independent-angle-b',
      angles: [
        {
          id: 'independent-angle-b',
          itemId: independentAngleB.id,
          source: independentAngleB,
          label: 'Independent B',
          offsetFrames: 0,
          confidence: 1,
        },
        {
          id: 'independent-angle-c',
          itemId: independentAngleC.id,
          source: independentAngleC,
          label: 'Independent C',
          offsetFrames: 0,
          confidence: 1,
        },
      ],
      syncMethod: 'audio' as const,
      evidence: [],
    },
  ],
};
const removedMulticam = projectReduce(
  {
    ...doc,
    activeTimelineId: multicamTimeline.id,
    timelines: [multicamTimeline],
  },
  { type: 'pool.removeAsset', id: assetA.id },
).timelines[0]!;
assert.equal(
  removedMulticam.items.some((item) => item.id === targetAngleA.id),
  false,
  'the deleted asset angle must be removed from the timeline',
);
assert.deepEqual(
  removedMulticam.multicamGroups?.map((group) => group.id),
  ['multicam-independent'],
  'deleting one angle from a two-angle group must collapse only that group',
);
for (const id of [targetAngleB.id, targetAngleBSplit.id]) {
  const survivor = removedMulticam.items.find((item) => item.id === id);
  assert.equal(survivor?.multicamGroupId, undefined, 'collapsed group membership must be removed from survivors');
  assert.equal(survivor?.multicamAngleId, undefined, 'collapsed angle membership must be removed from split descendants');
}
assert.equal(
  removedMulticam.items.find((item) => item.id === independentAngleB.id)?.multicamGroupId,
  'multicam-independent',
  'unrelated multicam membership must be preserved',
);
const survivingMulticamGroupIds = new Set(removedMulticam.multicamGroups?.map((group) => group.id) ?? []);
for (const item of removedMulticam.items) {
  assert.ok(
    !item.multicamGroupId || survivingMulticamGroupIds.has(item.multicamGroupId),
    `timeline item ${item.id} must not reference a missing multicam group`,
  );
}

const [storeSource, poolSource] = await Promise.all([
  readFile(new URL('./store.ts', import.meta.url), 'utf8'),
  readFile(new URL('../media/MediaPoolPanel.tsx', import.meta.url), 'utf8'),
]);
assert.match(storeSource, /sourceAssetId:\s*asset\.id/, 'new timeline clips must retain their pool-master identity');
assert.match(poolSource, /usedAssetIds/, 'the media pool must receive used-asset state');
assert.match(poolSource, /此素材正在剪辑中，确定删除吗？/, 'deleting an in-use asset must explain the destructive cascade');

console.log('mediaAssetUsage.verify: ok');
