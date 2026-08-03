import assert from 'node:assert/strict';
import { CURRENT_PROJECT_VERSION } from '../../shared/project-version';
import { migrateProjectDoc } from '../persist/projectStore';
import type { AgentContext } from '../agent/context';
import { execReadTranscript } from '../agent/tools/transcript-read';
import { resolveCaptionWords } from '../captions/resolve';
import { timelineToFcpxml } from '../export/fcpxml';
import { buildModel } from '../script/serialize';
import { hasOperationalTranscript } from '../transcript/types';
import { planInspectorBatch } from './inspectorBatch';
import { projectReduce } from './reduce';
import { planSlip } from './slip';
import { activeTimeline, type MediaAsset, type ProjectDoc } from './types';
import {
  commitDerivedArtifactIfCurrent,
  captureTimelineItemSource,
  createMediaSourceRevision,
  revisionAfterRelink,
  sourceRevisionOf,
  validateTimelineItemSourceBatch,
} from './mediaSourceRevision';

const legacyAsset: MediaAsset = {
  id: 'asset_1',
  name: 'interview.mov',
  kind: 'video',
  src: '/media/uploads/interview.mov',
  durationInFrames: 300,
  sourceSize: 1_024,
  sourceModifiedAt: 123_456,
};

assert.equal(sourceRevisionOf(legacyAsset), sourceRevisionOf({ ...legacyAsset }), 'source fingerprint is deterministic');
assert.notEqual(
  createMediaSourceRevision(legacyAsset),
  createMediaSourceRevision({ ...legacyAsset, sourceModifiedAt: legacyAsset.sourceModifiedAt! + 1 }),
  'mtime changes source identity',
);
assert.notEqual(
  sourceRevisionOf(legacyAsset),
  revisionAfterRelink(legacyAsset, { ...legacyAsset, sourceRevision: undefined }),
  'explicit relink invalidates sparse same-path metadata',
);

const doc: ProjectDoc = {
  version: CURRENT_PROJECT_VERSION,
  assets: [{
    ...legacyAsset,
    transcript: [{ text: 'old', start: 0, end: 100 }],
  }],
  mediaFolders: [],
  timelines: [{
    id: 'timeline_1',
    name: 'Sequence 1',
    order: 0,
    fps: 30,
    width: 1920,
    height: 1080,
    selectedId: null,
    items: [{
      id: 'clip_1',
      track: 'V1',
      startFrame: 0,
      durationInFrames: 300,
      name: 'Interview',
      kind: 'video',
      src: legacyAsset.src,
      transcript: [{ text: 'old', start: 0, end: 100 }],
      denoisedSrc: '/media/uploads/interview-denoised.wav',
      denoiseStrength: 80,
    }],
  }],
  activeTimelineId: 'timeline_1',
};

const normalized = migrateProjectDoc(doc);
assert.ok(normalized?.assets[0]?.sourceRevision, 'old ProjectDoc assets without revision remain readable and receive a default');

const nextRevision = createMediaSourceRevision({ ...legacyAsset, sourceModifiedAt: 999_999 });
const relinked = projectReduce(doc, {
  type: 'pool.relinkAsset',
  id: legacyAsset.id,
  src: legacyAsset.src,
  sourceRevision: nextRevision,
  sourceSize: legacyAsset.sourceSize,
  sourceModifiedAt: 999_999,
});
assert.equal(relinked.assets[0]?.sourceRevision, nextRevision);
assert.equal(relinked.assets[0]?.transcriptStale, true, 'asset transcript is retained but marked stale');
assert.equal(relinked.timelines[0]?.items[0]?.transcriptStale, true, 'clip transcript is retained but marked stale');
assert.equal(relinked.timelines[0]?.items[0]?.denoisedSrc, undefined, 'source-bound denoise output is invalidated');
const retranscribed = projectReduce(relinked, {
  type: 'pool.setTranscription',
  id: legacyAsset.id,
  patch: { transcript: [{ text: 'fresh', start: 0, end: 100 }], transcribeStatus: 'done' },
});
assert.equal(retranscribed.assets[0]?.transcriptStale, false);
assert.equal(
  retranscribed.assets[0]?.transcriptSourceRevision,
  nextRevision,
  'a fresh transcript records the exact source revision it describes',
);

// Source relinking distinguishes an omitted metadata key (preserve) from an
// explicitly undefined desktop path (clear after a Web/Agent replacement).
{
  const sourceDoc: ProjectDoc = {
    ...doc,
    assets: doc.assets.map((asset) => ({
      ...asset,
      sourceFilename: 'original-interview.mov',
      originalFilePath: '/Users/editor/original-interview.mov',
    })),
    timelines: doc.timelines.map((timeline) => ({
      ...timeline,
      items: timeline.items.map((item) => ({
        ...item,
        sourceFilename: 'original-interview.mov',
        originalFilePath: '/Users/editor/original-interview.mov',
      })),
    })),
  };
  const preserved = projectReduce(sourceDoc, {
    type: 'pool.relinkAsset',
    id: legacyAsset.id,
    src: '/media/uploads/relinked-local.mov',
    sourceRevision: 'relinked-local-revision',
  });
  assert.equal(preserved.assets[0]?.sourceFilename, 'original-interview.mov');
  assert.equal(preserved.assets[0]?.originalFilePath, '/Users/editor/original-interview.mov');
  assert.equal(preserved.timelines[0]?.items[0]?.originalFilePath, '/Users/editor/original-interview.mov');

  const cleared = projectReduce(preserved, {
    type: 'pool.relinkAsset',
    id: legacyAsset.id,
    src: '/media/uploads/relinked-web.mov',
    sourceFilename: 'relinked-web.mov',
    originalFilePath: undefined,
    sourceRevision: 'relinked-web-revision',
  });
  assert.equal(cleared.assets[0]?.sourceFilename, 'relinked-web.mov');
  assert.equal(cleared.assets[0]?.originalFilePath, undefined);
  assert.equal(cleared.timelines[0]?.items[0]?.sourceFilename, 'relinked-web.mov');
  assert.equal(cleared.timelines[0]?.items[0]?.originalFilePath, undefined);
}

// A relinked audio clip retains old words for review, but every operational
// consumer treats it as continuous media until current-source ASR replaces it.
{
  const oldAudioRevision = 'audio-revision-old';
  const newAudioRevision = 'audio-revision-new';
  const oldWords = [
    { text: 'old-a', start: 0, end: 1_000 },
    { text: 'old-b', start: 1_000, end: 2_000 },
    { text: 'old-c', start: 2_000, end: 3_000 },
  ];
  const audioAsset: MediaAsset = {
    id: 'asset_audio',
    name: 'voice.wav',
    kind: 'audio',
    src: '/media/uploads/voice-old.wav',
    durationInFrames: 300,
    sourceRevision: oldAudioRevision,
    transcript: oldWords,
  };
  const audioDoc: ProjectDoc = {
    version: CURRENT_PROJECT_VERSION,
    assets: [audioAsset],
    mediaFolders: [],
    timelines: [{
      id: 'timeline_audio',
      name: 'Audio',
      order: 0,
      fps: 30,
      width: 1920,
      height: 1080,
      selectedId: 'clip_audio',
      selectedIds: ['clip_audio'],
      trackOrder: ['A1'],
      tracks: { A1: { kind: 'audio' } },
      items: [{
        id: 'clip_audio',
        track: 'A1',
        startFrame: 0,
        durationInFrames: 30,
        name: 'Voice',
        kind: 'audio',
        src: audioAsset.src,
        srcInFrame: 10,
        playbackRate: 2,
        sourceRevision: oldAudioRevision,
        transcript: oldWords,
        deletedWordIdx: [1],
        silenceFrames: 8,
        gapCapsMs: { 2: 0 },
        transcriptPlayOrder: [2, 0],
        cutPadFrames: 6,
        variants: [{ id: 'old-variant', lang: 'en', kind: 'corrected', label: 'Old', words: [{ i: 0, text: 'obsolete' }] }],
      }],
    }],
    activeTimelineId: 'timeline_audio',
  };
  const relinkedAudio = projectReduce(audioDoc, {
    type: 'pool.relinkAsset',
    id: audioAsset.id,
    src: '/media/uploads/voice-new.wav',
    sourceRevision: newAudioRevision,
  });
  const staleTimeline = activeTimeline(relinkedAudio);
  const staleItem = staleTimeline.items[0]!;
  const staleState = { ...staleTimeline, assets: relinkedAudio.assets };
  assert.equal(staleItem.transcriptStale, true);
  assert.equal(staleItem.transcript?.[0]?.text, 'old-a', 'old transcript remains available for stale-review UI');
  assert.equal(hasOperationalTranscript(staleItem), false);
  const staleSlip = planSlip(staleState, staleItem.id, 20);
  assert.equal(staleSlip.ok, true);
  if (staleSlip.ok) {
    assert.equal(staleSlip.sourceDomain, 'media');
    assert.equal(staleSlip.srcInFrame, 50, 'stale transcript audio uses 2x continuous-media slip bounds');
  }
  assert.deepEqual(
    resolveCaptionWords(
      { enabled: true, template: 'plain', pacing: 'phrase', sourceItemId: staleItem.id, words: oldWords },
      staleTimeline.items,
      staleTimeline.fps,
    ),
    [],
    'stale anchored captions do not fall back to retained words',
  );
  assert.equal(buildModel(staleState)[0]?.regions[0]?.rows[0]?.kind, 'clip', 'read_script copies stale audio as a raw clip, not transcript rows');
  assert.equal((timelineToFcpxml(staleState).match(/<asset-clip\b/g) ?? []).length, 1, 'stale transcript exports as one continuous raw audio clip');

  assert.strictEqual(
    projectReduce(relinkedAudio, { type: 'deleteWords', id: staleItem.id, idxs: [0] }),
    relinkedAudio,
    'word-edit actions reject retained stale transcript state',
  );
  const staleTranscriptRead = execReadTranscript({}, { getState: () => staleState } as unknown as AgentContext);
  assert.ok(
    typeof staleTranscriptRead === 'object'
      && staleTranscriptRead !== null
      && 'error' in staleTranscriptRead,
    'read_transcript rejects retained stale words',
  );
  const freshWords = [
    { text: 'fresh-a', start: 0, end: 1_000 },
    { text: 'fresh-b', start: 1_000, end: 2_000 },
    { text: 'fresh-c', start: 2_000, end: 3_000 },
  ];
  const refreshed = projectReduce(relinkedAudio, { type: 'setItemTranscript', id: staleItem.id, words: freshWords });
  const freshTimeline = activeTimeline(refreshed);
  const freshItem = freshTimeline.items[0]!;
  assert.equal(hasOperationalTranscript(freshItem), true);
  assert.equal(freshItem.transcript?.[0]?.text, 'fresh-a');
  assert.equal(freshItem.srcInFrame, 0);
  assert.deepEqual(freshItem.deletedWordIdx, []);
  assert.equal(freshItem.silenceFrames, undefined);
  assert.equal(freshItem.gapCapsMs, undefined);
  assert.equal(freshItem.transcriptPlayOrder, undefined);
  assert.equal(freshItem.cutPadFrames, undefined);
  assert.equal(freshItem.variants, undefined);
  const freshSlip = planSlip({ ...freshTimeline, assets: refreshed.assets }, freshItem.id, 20);
  assert.equal(freshSlip.ok, true);
  if (freshSlip.ok) {
    assert.equal(freshSlip.sourceDomain, 'edited-stream');
    assert.equal(freshSlip.srcInFrame, 20, 'fresh current-source transcript starts in, and slips through, the new edited stream');
  }
  assert.ok(resolveCaptionWords(
    { enabled: true, template: 'plain', pacing: 'phrase', sourceItemId: freshItem.id },
    freshTimeline.items,
    freshTimeline.fps,
  ).length > 0, 'fresh current-source transcript restores caption generation');
}

// A derivative captures the revision when it starts. Relinking before completion
// prevents its final writer from running; work started on the current revision commits.
{
  let current = { ...legacyAsset, sourceRevision: sourceRevisionOf(legacyAsset) };
  let writes = 0;
  const staleKey = {
    assetId: current.id,
    sourceRevision: current.sourceRevision,
    artifactKind: 'waveform',
    algorithmVersion: 'verify-v1',
  };
  current = { ...current, sourceRevision: nextRevision };
  const stale = await commitDerivedArtifactIfCurrent(staleKey, () => current, async () => { writes += 1; });
  assert.equal(stale.status, 'stale');
  assert.equal(writes, 0, 'stale derivative never reaches persistent writer');

  const committed = await commitDerivedArtifactIfCurrent(
    { ...staleKey, sourceRevision: nextRevision },
    () => current,
    async () => { writes += 1; return 'stored'; },
  );
  assert.deepEqual(committed, { status: 'committed', value: 'stored' });
  assert.equal(writes, 1);
}

// Inspector voice isolation is an atomic batch: if one clip is relinked while
// its request is pending, neither the stale result nor its still-current peers commit.
{
  interface IsolationResult {
    itemId: string;
    path: string;
    sourceRevision: string;
    strength: number;
  }
  const deferredIsolation = () => {
    let resolve!: (result: IsolationResult) => void;
    const promise = new Promise<IsolationResult>((done) => { resolve = done; });
    return { promise, resolve };
  };
  const firstRevision = 'source-batch-first';
  const secondRevision = 'source-batch-second';
  const secondAsset: MediaAsset = {
    id: 'asset_2',
    name: 'guest.wav',
    kind: 'audio',
    src: '/media/uploads/guest.wav',
    durationInFrames: 300,
    sourceRevision: secondRevision,
  };
  const batchDoc: ProjectDoc = {
    ...doc,
    assets: [{ ...legacyAsset, sourceRevision: firstRevision }, secondAsset],
    timelines: [{
      ...doc.timelines[0]!,
      items: [
        {
          id: 'clip_1',
          track: 'V1',
          startFrame: 0,
          durationInFrames: 300,
          name: 'Interview',
          kind: 'video',
          src: legacyAsset.src,
          sourceRevision: firstRevision,
        },
        {
          id: 'clip_2',
          track: 'A1',
          startFrame: 0,
          durationInFrames: 300,
          name: 'Guest',
          kind: 'audio',
          src: secondAsset.src,
          sourceRevision: secondRevision,
        },
      ],
    }],
  };
  const ids = ['clip_1', 'clip_2'];
  const snapshots = activeTimeline(batchDoc).items.map((item) => captureTimelineItemSource(item, batchDoc.assets));
  const first = deferredIsolation();
  const second = deferredIsolation();
  const pendingResults = Promise.all([first.promise, second.promise]);
  const relinkedBatchDoc = projectReduce(batchDoc, {
    type: 'pool.relinkAsset',
    id: legacyAsset.id,
    src: legacyAsset.src,
    sourceRevision: 'source-batch-relinked',
  });
  first.resolve({
    itemId: 'clip_1',
    path: '/media/uploads/interview-isolated.wav',
    sourceRevision: firstRevision,
    strength: 70,
  });
  second.resolve({
    itemId: 'clip_2',
    path: '/media/uploads/guest-isolated.wav',
    sourceRevision: secondRevision,
    strength: 70,
  });
  const results = await pendingResults;
  const resultById = new Map(results.map((result) => [result.itemId, result]));
  const staleValidation = validateTimelineItemSourceBatch(
    snapshots,
    activeTimeline(relinkedBatchDoc).items,
    relinkedBatchDoc.assets,
    resultById,
  );
  const stalePlan = staleValidation.status === 'current'
    ? planInspectorBatch(
      activeTimeline(relinkedBatchDoc),
      ids,
      (item) => {
        const result = resultById.get(item.id);
        return result
          ? { type: 'setItemDenoise' as const, id: item.id, denoisedSrc: result.path, strength: result.strength }
          : null;
      },
    )
    : { ok: false, actions: [] };
  assert(staleValidation.status === 'stale', 'relinked batch must be stale');
  assert.deepEqual(staleValidation.staleItems.map((entry) => entry.itemId), ['clip_1']);
  assert.equal(staleValidation.staleItems[0]?.reason, 'source_revision_changed');
  assert.equal(staleValidation.staleItems[0]?.sourceRevision, firstRevision);
  assert.equal(staleValidation.staleItems[0]?.currentSourceRevision, 'source-batch-relinked');
  assert.equal(staleValidation.staleItems[0]?.resultSourceRevision, firstRevision);
  assert.deepEqual(stalePlan.actions, [], 'one stale result prevents every batch mutation');
  assert.equal(activeTimeline(relinkedBatchDoc).items[0]?.denoisedSrc, undefined);
  assert.equal(activeTimeline(relinkedBatchDoc).items[1]?.denoisedSrc, undefined);

  const currentValidation = validateTimelineItemSourceBatch(
    snapshots,
    activeTimeline(batchDoc).items,
    batchDoc.assets,
    resultById,
  );
  assert.equal(currentValidation.status, 'current', 'unrelinked batch remains committable');
  const currentPlan = planInspectorBatch(
    activeTimeline(batchDoc),
    ids,
    (item) => {
      const result = resultById.get(item.id);
      return result
        ? { type: 'setItemDenoise' as const, id: item.id, denoisedSrc: result.path, strength: result.strength }
        : null;
    },
  );
  assert.equal(currentPlan.ok, true);
  assert.equal(currentPlan.actions.length, 2);

  const mismatchedServerValidation = validateTimelineItemSourceBatch(
    snapshots,
    activeTimeline(batchDoc).items,
    batchDoc.assets,
    new Map([
      ['clip_1', { sourceRevision: firstRevision }],
      ['clip_2', { sourceRevision: 'source-server-mismatch' }],
    ]),
  );
  assert(mismatchedServerValidation.status === 'stale');
  assert.deepEqual(mismatchedServerValidation.staleItems.map((entry) => entry.itemId), ['clip_2']);
  assert.equal(mismatchedServerValidation.staleItems[0]?.reason, 'result_revision_mismatch');
}

console.log('mediaSourceRevision.verify: legacy defaults, relink invalidation, stale commit guard, and atomic batch guard OK');
