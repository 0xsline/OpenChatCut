import assert from 'node:assert/strict';
import { execUploadTool } from './upload-tools';
import type { ReceiptRecord, UploadVerifierFixture } from './upload-tools.verify-fixture';

export async function verifyUploadMediaFailures(fixture: UploadVerifierFixture): Promise<void> {
  const { context, draft, state } = fixture;
  const videoReceipt: ReceiptRecord = { value: {
    sessionId: 'sess_video',
    assetId: 'video-asset',
    filename: 'interview.mov',
    projectId: 'project-test',
    fileKey: 'uploads/video-asset.mov',
    readUrl: '/media/uploads/video-asset.mov',
    size: 4096,
    type: 'video',
    contentType: 'video/quicktime',
    contentHash: 'ef'.repeat(32),
  } };
  state.receipts.set('receipt-video', videoReceipt);
  const claimsBeforeMissingDuration = state.receiptClaims;
  const missingDuration = await execUploadTool('finalize_uploaded_asset', {
    receipt: 'receipt-video',
    assetType: 'video',
  }, context) as { error?: string };
  assert.match(missingDuration.error ?? '', /durationInSeconds is required/);
  assert.equal(
    state.receiptClaims,
    claimsBeforeMissingDuration,
    'conditional duration validation must run before claiming the receipt',
  );

  state.failNextNormalization = true;
  const normalizationFailure = await execUploadTool('finalize_uploaded_asset', {
    receipt: 'receipt-video',
    assetType: 'video',
    durationInSeconds: 2,
    hasAudioTrack: true,
  }, context) as { error?: string };
  assert.match(normalizationFailure.error ?? '', /Video compatibility processing failed/);
  assert.equal(videoReceipt.claimId, undefined, 'normalization failure must abort the receipt claim');
  assert.equal(videoReceipt.committed, undefined);
  assert.equal(
    draft.getDoc().assets.some((asset) => asset.id === 'video-asset'),
    false,
    'normalization failure must not publish an asset',
  );

  const finalizedVideo = await execUploadTool('finalize_uploaded_asset', {
    receipt: 'receipt-video',
    assetType: 'video',
    durationInSeconds: 2,
    hasAudioTrack: true,
  }, context) as { next?: string; transcription?: string };
  assert.equal(videoReceipt.committed, true, 'successful asset commit must terminally commit the receipt');
  assert.equal(finalizedVideo.transcription, 'not_started');
  assert.match(finalizedVideo.next ?? '', /invoke transcribe_track/);
  const videoAsset = draft.getDoc().assets.find((asset) => asset.id === 'video-asset');
  assert.equal(videoAsset?.transcribeStatus, undefined, 'finalize must not enqueue or mark ASR running');
  const replayedVideo = await execUploadTool('finalize_uploaded_asset', {
    receipt: 'receipt-video',
    assetType: 'video',
    durationInSeconds: 2,
  }, context) as { error?: string };
  assert.match(replayedVideo.error ?? '', /unavailable|invalid|expired|consumed/);

  const unsafe = await execUploadTool('import_media', {
    action: 'create_session',
    assetType: 'image',
    filename: 'bad\u0001.png',
    contentType: 'image/png',
    size: 1,
  }, context) as { error?: string };
  assert.match(unsafe.error ?? '', /safe basename/);
  assert.equal(state.mintedBodies.length, 2);
  const removedLegacy = await execUploadTool('request_asset_upload_url', {}, context) as { error?: string };
  assert.match(removedLegacy.error ?? '', /unknown tool/);
}
