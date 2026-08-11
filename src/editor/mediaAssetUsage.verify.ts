import { CURRENT_PROJECT_VERSION } from '../../shared/project-version';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { historyReduce, projectReduce } from './reduce';
import { makeDraft } from './store';
import { timelineItemAssetId, usedMediaAssetIds } from './mediaAssetUsage';
import { verifyMulticamAssetRemoval } from './mediaAssetUsageMulticam.verify-support';
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
  version: CURRENT_PROJECT_VERSION,
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
  sourceContentHash: 'aa'.repeat(32),
});
assert.equal(relinked.timelines[0]!.items.find((item) => item.id === linkedA.id)?.src, '/media/relinked.mp4');
assert.equal(relinked.timelines[0]!.items.find((item) => item.id === legacyA.id)?.sourceAssetId, assetA.id);
assert.equal(
  relinked.timelines[0]!.items.find((item) => item.id === linkedA.id)?.sourceContentHash,
  'aa'.repeat(32),
  'pool relink must copy content identity to linked timeline snapshots',
);
const preservedHash = projectReduce(relinked, {
  type: 'pool.relinkAsset',
  id: assetA.id,
  src: '/media/relinked.mp4',
  name: 'Renamed without replacing bytes.mp4',
});
assert.equal(
  preservedHash.assets.find((item) => item.id === assetA.id)?.sourceContentHash,
  'aa'.repeat(32),
  'omitting sourceContentHash must preserve the current byte identity',
);
const clearedHash = projectReduce(relinked, {
  type: 'pool.relinkAsset',
  id: assetA.id,
  src: '/media/relinked-without-server-hash.mp4',
  sourceContentHash: undefined,
});
assert.equal(
  clearedHash.assets.find((item) => item.id === assetA.id)?.sourceContentHash,
  undefined,
  'explicit undefined must clear stale identity for a legacy replacement',
);
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
  sourceContentHash: 'bb'.repeat(32),
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
assert.equal(clipAfterRelink.sourceContentHash, 'bb'.repeat(32));
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

const replacementOneFrameLonger: MediaAssetRelinkPatch = {
  src: '/media/relinked-31.mp4',
  name: 'Relinked 31.mp4',
  durationInFrames: 31,
  sourceRevision: 'replacement-31-revision',
};
const backToBackAsset: MediaAsset = {
  id: 'asset-back-to-back',
  name: 'Back to back.mp4',
  kind: 'video',
  src: '/media/back-to-back.mp4',
  durationInFrames: 30,
  sourceRevision: 'back-to-back-revision',
};
const backToBackTimeline = (id: string, linked: boolean): Timeline => ({
  id,
  name: id,
  order: id === 'linked-timeline-a' ? 0 : 1,
  fps: 30,
  width: 1920,
  height: 1080,
  items: [
    {
      id: `${id}-first`,
      track: 'V1',
      startFrame: 0,
      durationInFrames: 30,
      kind: 'video',
      name: linked ? backToBackAsset.name : 'Detached.mp4',
      src: linked ? backToBackAsset.src : '/media/detached.mp4',
      sourceAssetId: linked ? backToBackAsset.id : undefined,
      srcInFrame: 0,
    },
    {
      id: `${id}-second`,
      track: 'V1',
      startFrame: 30,
      durationInFrames: 30,
      kind: 'video',
      name: linked ? backToBackAsset.name : 'Neighbor.mp4',
      src: linked ? backToBackAsset.src : '/media/neighbor.mp4',
      sourceAssetId: linked ? backToBackAsset.id : undefined,
      srcInFrame: 0,
    },
  ],
  tracks: { V1: { kind: 'video' } },
  trackOrder: ['V1'],
  selectedId: null,
});
const assertBackToBack = (timeline: Timeline, message: string) => {
  const [first, second] = timeline.items.toSorted((left, right) => left.startFrame - right.startFrame);
  assert.equal(first?.durationInFrames, 30, `${message}: first clip must retain its authored duration`);
  assert.equal(second?.durationInFrames, 30, `${message}: second clip must retain its authored duration`);
  assert.ok(
    (first?.startFrame ?? 0) + (first?.durationInFrames ?? 0) <= (second?.startFrame ?? 0),
    `${message}: relink must not create an overlap`,
  );
};

const linkedBackToBackDoc: ProjectDoc = {
  version: CURRENT_PROJECT_VERSION,
  assets: [backToBackAsset],
  mediaFolders: [],
  activeTimelineId: 'linked-timeline-a',
  timelines: [
    backToBackTimeline('linked-timeline-a', true),
    backToBackTimeline('linked-timeline-b', true),
  ],
};
const linkedDraft = makeDraft(linkedBackToBackDoc);
const linkedRelinkResult = linkedDraft.commands.relinkMediaAsset(
  backToBackAsset.id,
  replacementOneFrameLonger,
);
assert.deepEqual(linkedRelinkResult, { ok: true, changed: true });
for (const timeline of linkedDraft.getDoc().timelines) {
  assertBackToBack(timeline, `pool relink in ${timeline.id}`);
}
assert.equal(
  linkedDraft.getDoc().assets[0]?.durationInFrames,
  31,
  'the pool master records the replacement source duration without expanding timeline slots',
);
const linkedRelinkActions = linkedDraft.takeActions();
assert.equal(linkedRelinkActions.length, 1, 'pool relink must dispatch one atomic action');
assert.equal(
  historyReduce(
    { past: [], present: linkedBackToBackDoc, future: [] },
    linkedRelinkActions[0]!,
  ).past.length,
  1,
  'pool relink must create one undo step',
);

const detachedTimeline = backToBackTimeline('detached-timeline', false);
const detachedDoc: ProjectDoc = {
  version: CURRENT_PROJECT_VERSION,
  assets: [],
  mediaFolders: [],
  activeTimelineId: detachedTimeline.id,
  timelines: [detachedTimeline],
};
const detachedDraft = makeDraft(detachedDoc);
const detachedRelinkResult = detachedDraft.commands.relinkTimelineItem(
  detachedTimeline.items[0]!.id,
  replacementOneFrameLonger,
);
assert.deepEqual(detachedRelinkResult, { ok: true, changed: true });
assertBackToBack(detachedDraft.getDoc().timelines[0]!, 'detached relink');
assert.equal(detachedDraft.takeActions().length, 1, 'detached relink must dispatch one atomic action');

const lockedDetachedDoc: ProjectDoc = {
  ...detachedDoc,
  timelines: detachedDoc.timelines.map((timeline) => ({
    ...timeline,
    tracks: { V1: { kind: 'video', locked: true } },
  })),
};
const rejectedDraft = makeDraft(lockedDetachedDoc);
const rejectedBefore = rejectedDraft.getDoc();
assert.deepEqual(
  rejectedDraft.commands.relinkTimelineItem(
    lockedDetachedDoc.timelines[0]!.items[0]!.id,
    replacementOneFrameLonger,
  ),
  { ok: false, changed: false, reason: 'no-document-change' },
  'a rejected relink must report that the document did not change',
);
assert.equal(rejectedDraft.getDoc(), rejectedBefore, 'a rejected relink must remain atomic');
assert.equal(rejectedDraft.takeActions().length, 0, 'a rejected relink must not create a false undo step');

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

verifyMulticamAssetRemoval({ doc, assetA, assetB, otherAsset, clip });

const [storeSource, poolSource, timelineMediaActionsSource] = await Promise.all([
  readFile(new URL('./storeCommandBuilder.ts', import.meta.url), 'utf8'),
  readFile(new URL('../media/MediaPoolPanel.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../components/timeline/useTimelineMediaActions.ts', import.meta.url), 'utf8'),
]);
assert.match(storeSource, /sourceAssetId:\s*asset\.id/, 'new timeline clips must retain their pool-master identity');
assert.match(poolSource, /usedAssetIds/, 'the media pool must receive used-asset state');
assert.match(poolSource, /此素材正在剪辑中，确定删除吗？/, 'deleting an in-use asset must explain the destructive cascade');
assert.match(
  timelineMediaActionsSource,
  /if\s*\(!result\.changed\)/,
  'the timeline must not show relink success when the document was unchanged',
);

console.log('mediaAssetUsage.verify: ok');
