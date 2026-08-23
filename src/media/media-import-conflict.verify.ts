import assert from 'node:assert/strict';
import { t } from '../i18n/locale';
import {
  findMediaNameConflict,
  isMediaImportCancelled,
  mediaImportErrorMessage,
  MediaImportCancelledError,
  normalizeMediaName,
} from './mediaImportConflict';
import type { MediaAsset } from '../editor/types';
import {
  createImportTranscriptionGate,
  createMediaAssetsChatSeed,
  readyMediaAssetsForPaste,
} from './upload';
import { uploadedMediaRelinkPatch } from './mediaAssetRelink';
import { createImportContentIdentityHooks } from './importContentIdentity';

assert.equal(normalizeMediaName('  旅行封面.PNG  '), '旅行封面.png');
assert.equal(normalizeMediaName('ＡＢＣ.mp4'), 'abc.mp4');
assert.equal(findMediaNameConflict([{ id: 'a', name: '旅行封面.PNG' }], '旅行封面.png')?.id, 'a');
assert.equal(isMediaImportCancelled(new MediaImportCancelledError()), true);
assert.equal(
  mediaImportErrorMessage(new Error('part 3 failed (503)')),
  t('上传第 {part} 个分片失败（{status}）', { part: 3, status: 503 }),
);
assert.equal(mediaImportErrorMessage(new Error('unexpected internal failure')), t('导入素材失败，请重试'));

const oldMaster: MediaAsset = {
  id: 'asset-master',
  name: 'interview.mov',
  sourceFilename: 'interview-old.mov',
  originalFilePath: '/Users/editor/interview-old.mov',
  kind: 'video',
  src: '/media/uploads/interview-old.mp4',
  durationInFrames: 300,
  sourceRevision: 'revision-old',
  transcript: [{ text: 'old words', start: 0, end: 100 }],
  transcribeStatus: 'done',
};
const asrPath = Promise.resolve('/media/uploads/interview-new-asr.wav');
const uploaded = {
  id: 'temporary-import-id',
  src: '/media/uploads/interview-new.mov',
  kind: 'video' as const,
  name: 'interview.mov',
  sourceRevision: 'revision-new',
  sourceContentHash: 'ef'.repeat(32),
  sourceSize: 4_096,
  sourceModifiedAt: 42,
  asrPath,
};
assert.deepEqual(uploadedMediaRelinkPatch(uploaded), {
  src: uploaded.src,
  name: uploaded.name,
  kind: uploaded.kind,
  sourceRevision: uploaded.sourceRevision,
  sourceContentHash: uploaded.sourceContentHash,
  sourceSize: uploaded.sourceSize,
  sourceModifiedAt: uploaded.sourceModifiedAt,
});
const replacementGate = createImportTranscriptionGate(oldMaster.id);
assert.equal(
  replacementGate.uploaded(uploaded),
  null,
  'an existing master does not start ASR while normalize/relink can still fail',
);
assert.equal(oldMaster.transcribeStatus, 'done', 'a failed replacement leaves the old ASR state untouched');
assert.equal(oldMaster.transcript?.[0]?.text, 'old words', 'a failed replacement leaves old transcript content untouched');
const readyReplacement: MediaAsset = {
  ...oldMaster,
  id: 'temporary-import-id',
  name: 'interview.mov',
  sourceFilename: 'interview.mov',
  originalFilePath: undefined,
  src: '/media/uploads/interview-new-normalized.mp4',
  sourceRevision: 'revision-new',
};
const replacementStart = replacementGate.ready(readyReplacement);
assert.equal(replacementStart?.asset.id, oldMaster.id, 'ready relink starts ASR against the existing master identity');
assert.equal(replacementStart?.asset.sourceRevision, 'revision-new');
assert.strictEqual(replacementStart?.asrPath, asrPath);
assert.equal(
  createImportTranscriptionGate().uploaded(uploaded)?.asset.id,
  uploaded.id,
  'a new master may still race ASR from onUploaded',
);

const copiedPlaceholder: MediaAsset = {
  ...readyReplacement,
  id: 'placeholder-id',
  src: 'blob:https://openchatcut.local/pending-master',
};
assert.deepEqual(
  readyMediaAssetsForPaste([copiedPlaceholder], [copiedPlaceholder]),
  [],
  'a live blob placeholder cannot become a persistent duplicate',
);
const readyMaster: MediaAsset = {
  ...copiedPlaceholder,
  src: '/media/uploads/ready-master.mp4',
  sourceFilename: 'replacement-camera.mov',
  originalFilePath: undefined,
};
assert.strictEqual(
  readyMediaAssetsForPaste([copiedPlaceholder], [readyMaster])[0],
  readyMaster,
  'a copied placeholder resolves to the authoritative live master once ready',
);
assert.equal(
  readyMediaAssetsForPaste([copiedPlaceholder], [readyMaster])[0]?.src.startsWith('blob:'),
  false,
  'the paste payload never retains the URL scheduled for revoke',
);

const secondReadyMaster: MediaAsset = {
  ...readyMaster,
  id: 'voice-master',
  name: 'voice.wav',
  sourceFilename: 'voice.wav',
  kind: 'audio',
  src: '/media/uploads/voice.wav',
};
const mediaSeed = createMediaAssetsChatSeed([readyMaster, secondReadyMaster], 42);
assert.deepEqual(mediaSeed, {
  text: '@interview.mov @voice.wav ',
  nonce: 42,
  references: [
    { id: readyMaster.id, name: readyMaster.name, kind: readyMaster.kind },
    { id: secondReadyMaster.id, name: secondReadyMaster.name, kind: secondReadyMaster.kind },
  ],
}, 'one ordered chat seed contains every selected media reference');
assert.equal(createMediaAssetsChatSeed([], 42), null, 'an empty media selection does not expand or reseed chat');

const canonicalHash = 'aa'.repeat(32);
const canonicalPoolAsset: MediaAsset = {
  ...oldMaster,
  id: 'canonical-pool-master',
  name: 'canonical.mov',
  sourceContentHash: canonicalHash,
};
let canonicalized: { canonicalId: string; duplicateId: string } | undefined;
const identityHooks = createImportContentIdentityHooks({
  getAssets: () => [canonicalPoolAsset],
  onCanonical: (canonical, duplicateId) => {
    canonicalized = { canonicalId: canonical.id, duplicateId };
  },
});
assert.strictEqual(
  identityHooks.resolveCanonicalAsset?.(canonicalHash.toUpperCase(), 'renamed-placeholder'),
  canonicalPoolAsset,
  'progressive import reuses existing bytes even when the incoming filename differs',
);
identityHooks.onCanonical?.(canonicalPoolAsset, 'renamed-placeholder');
assert.deepEqual(canonicalized, {
  canonicalId: canonicalPoolAsset.id,
  duplicateId: 'renamed-placeholder',
});
const sameNameReplacement: MediaAsset = {
  ...canonicalPoolAsset,
  id: 'same-name-new-bytes',
  sourceContentHash: 'bb'.repeat(32),
};
assert.equal(findMediaNameConflict([canonicalPoolAsset], sameNameReplacement.name)?.id, canonicalPoolAsset.id);
assert.equal(
  identityHooks.resolveCanonicalAsset?.(sameNameReplacement.sourceContentHash!, sameNameReplacement.id),
  undefined,
  'same-name different bytes remain on the explicit replacement path',
);


console.log('media-import-conflict.verify: shared conflict handling preserves asset identity');
