import assert from 'node:assert/strict';
import { CURRENT_PROJECT_VERSION } from '../../shared/project-version';
import type { MediaAsset, ProjectDoc } from './types';
import { findCanonicalMediaAsset } from './mediaContentIdentity';
import { projectReduce } from './reduce';
import {
  createMediaSourceRevision,
  revisionAfterRelink,
  sourceRevisionOf,
  withMediaSourceRevision,
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
const contentHash = 'ab'.repeat(32);
const contentRevision = createMediaSourceRevision({
  ...legacyAsset,
  sourceContentHash: contentHash.toUpperCase(),
});

assert.equal(contentRevision, `source-sha256-${contentHash}`, 'valid uppercase SHA-256 is normalized');
assert.equal(
  sourceRevisionOf({
    ...legacyAsset,
    sourceRevision: 'source-v1-conflicting-legacy-revision',
    sourceContentHash: contentHash,
  }),
  contentRevision,
  'a valid content hash overrides a conflicting persisted legacy revision',
);
assert.equal(
  revisionAfterRelink(legacyAsset, {
    ...legacyAsset,
    sourceRevision: 'source-v1-conflicting-relink-revision',
    sourceContentHash: contentHash,
  }),
  contentRevision,
  'relink normalization cannot override valid content identity with a stale explicit revision',
);
assert.equal(
  createMediaSourceRevision({
    ...legacyAsset,
    src: '/media/uploads/interview.compatibility.webm',
    sourceContentHash: contentHash,
  }),
  contentRevision,
  'compatibility proxies retain the imported master byte identity rather than claiming a proxy-byte hash',
);
assert.equal(
  contentRevision,
  createMediaSourceRevision({ ...legacyAsset, sourceContentHash: contentHash, sourceModifiedAt: 999 }),
  'content identity takes precedence over mutable file metadata',
);
assert.notEqual(
  contentRevision,
  createMediaSourceRevision({ ...legacyAsset, sourceContentHash: 'cd'.repeat(32) }),
  'changed source bytes produce a different revision',
);
assert.equal(
  createMediaSourceRevision({ ...legacyAsset, sourceContentHash: `${contentHash}0` }),
  createMediaSourceRevision(legacyAsset),
  'malformed digests retain the legacy metadata fallback',
);
const canonicalAsset = withMediaSourceRevision({
  ...legacyAsset,
  sourceContentHash: contentHash.toUpperCase(),
  sourceRevision: undefined,
});
assert.equal(canonicalAsset.sourceContentHash, contentHash, 'persisted source hashes are canonical lowercase');
assert.equal(canonicalAsset.sourceRevision, contentRevision);
assert.notEqual(
  sourceRevisionOf(legacyAsset),
  revisionAfterRelink(legacyAsset, { ...legacyAsset, sourceRevision: undefined }),
  'explicit relink invalidates sparse same-path metadata',
);

const poolCanonical: MediaAsset = {
  ...legacyAsset,
  id: 'asset_canonical',
  name: 'Canonical interview.mov',
  sourceFilename: 'Canonical interview.mov',
  sourceContentHash: contentHash,
  transcript: [{ id: 'word_existing', text: 'existing transcript', start: 0, end: 100 }],
  transcriptGenerationId: 'generation_existing',
  transcribeStatus: 'done',
};
const renamedPlaceholder: MediaAsset = {
  ...legacyAsset,
  id: 'asset_placeholder',
  name: 'Renamed copy.mov',
  sourceFilename: 'Renamed copy.mov',
  src: 'blob:https://openchatcut.local/renamed-copy',
};
const sameNameDifferentBytes: MediaAsset = {
  ...poolCanonical,
  id: 'asset_replacement',
  sourceContentHash: 'cd'.repeat(32),
};
assert.strictEqual(
  findCanonicalMediaAsset([poolCanonical, renamedPlaceholder], contentHash.toUpperCase(), renamedPlaceholder.id),
  poolCanonical,
  'renamed imports resolve to the existing pool master by authoritative bytes',
);
assert.equal(
  findCanonicalMediaAsset([poolCanonical], sameNameDifferentBytes.sourceContentHash),
  undefined,
  'the same filename with different bytes does not content-dedupe',
);
assert.equal(
  findCanonicalMediaAsset([poolCanonical], 'not-a-sha256'),
  undefined,
  'invalid hashes retain legacy conflict behavior',
);

const docWithDuplicate: ProjectDoc = {
  version: CURRENT_PROJECT_VERSION,
  assets: [poolCanonical, renamedPlaceholder],
  mediaFolders: [],
  timelines: [{
    id: 'timeline_identity',
    name: 'Identity',
    order: 0,
    fps: 30,
    width: 1920,
    height: 1080,
    selectedId: null,
    trackOrder: ['track_identity_video'],
    tracks: { track_identity_video: { kind: 'video' } },
    items: [{
      id: 'item_placeholder',
      track: 'track_identity_video',
      startFrame: 0,
      durationInFrames: 120,
      name: 'User-trimmed duplicate',
      kind: 'video',
      sourceAssetId: renamedPlaceholder.id,
      src: renamedPlaceholder.src,
      sourceRevision: sourceRevisionOf(renamedPlaceholder),
    }],
  }],
  activeTimelineId: 'timeline_identity',
};
const deduped = projectReduce(docWithDuplicate, {
  type: 'pool.canonicalizeAsset',
  duplicateId: renamedPlaceholder.id,
  canonicalId: poolCanonical.id,
});
assert.deepEqual(deduped.assets.map((asset) => asset.id), [poolCanonical.id]);
assert.equal(deduped.assets[0]?.name, poolCanonical.name, 'byte dedupe never overwrites canonical metadata');
assert.equal(deduped.timelines[0]?.items[0]?.sourceAssetId, poolCanonical.id);
assert.equal(
  deduped.assets.some((asset) => asset.id === deduped.timelines[0]?.items[0]?.sourceAssetId),
  true,
  'deduped placements always retain a live pool id',
);
assert.equal(deduped.timelines[0]?.items[0]?.transcript?.[0]?.text, 'existing transcript');
assert.equal(deduped.timelines[0]?.items[0]?.transcript?.[0]?.id, 'word_existing');
assert.equal(deduped.timelines[0]?.items[0]?.transcriptGenerationId, 'generation_existing');
assert.equal(deduped.timelines[0]?.items[0]?.durationInFrames, 120, 'dedupe preserves timeline trims');
assert.equal(deduped.timelines[0]?.items[0]?.name, 'User-trimmed duplicate', 'dedupe preserves clip labels');

console.log('mediaContentIdentity.verify: SHA-256 identity canonicalization and precedence OK');
