import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { projectReduce } from './reduce';
import { timelineItemAssetId, usedMediaAssetIds } from './mediaAssetUsage';
import { sourceRevisionForTimelineItem } from './mediaSourceRevision';
import { resolveTimelineRenderPlan } from './sequenceGraph';
import { remainingSourceFrames } from './sourceLimit';
import type { MediaAsset, ProjectDoc, Timeline, TimelineItem } from './types';

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
