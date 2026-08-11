import assert from 'node:assert/strict';
import { safeSourceFilename } from '../../media/sourceFilename';
import { validateAgentToolInvocation } from '../execution-policy';
import { UPLOAD_TOOL_SCHEMAS } from './schemas/upload-tools';
import { execUploadTool } from './upload-tools';
import type { ImportSession, UploadVerifierFixture } from './upload-tools.verify-fixture';

export async function verifyUploadImportSession(fixture: UploadVerifierFixture): Promise<void> {
  const { context, draft, state } = fixture;

  assert.equal(safeSourceFilename('/Users/editor/素材/采访.最终版.001.MOV'), '采访.最终版.001.MOV');
  assert.equal(safeSourceFilename('D:\\capture\\采访.最终版.001.MOV'), '采访.最终版.001.MOV');
  assert.equal(safeSourceFilename('\\\\server\\share\\采访.最终版.001.MOV'), '采访.最终版.001.MOV');
  assert.equal(safeSourceFilename('literal%2Fname.final.mov'), 'literal%2Fname.final.mov');
  for (const invalid of ['', ' ', '.', '..', '/tmp/', 'bad\u0001.mov', 42, null]) {
    assert.equal(safeSourceFilename(invalid), undefined);
  }

  const finalizeSchema = UPLOAD_TOOL_SCHEMAS.find((schema) => schema.name === 'finalize_uploaded_asset');
  if (!finalizeSchema) throw new Error('finalize schema is missing');
  assert.equal(
    validateAgentToolInvocation(finalizeSchema, {
      receipt: 'schema-receipt',
      assetType: 'video',
    }, [finalizeSchema]).ok,
    false,
    'the executable schema must reject duration-less video finalization',
  );
  assert.equal(
    validateAgentToolInvocation(finalizeSchema, {
      receipt: 'schema-receipt',
      assetType: 'image',
    }, [finalizeSchema]).ok,
    true,
    'the executable schema must allow static image finalization without duration',
  );

  const incomplete = await execUploadTool('import_media', {
    action: 'create_session',
  }, context) as { error?: string };
  assert.match(incomplete.error ?? '', /assetType/);
  assert.equal(state.mintedTickets, 0);
  const mismatchedMediaType = await execUploadTool('import_media', {
    action: 'create_session',
    assetType: 'image',
    filename: 'payload.html',
    contentType: 'text/html',
    size: 32,
  }, context) as { error?: string };
  assert.match(mismatchedMediaType.error ?? '', /supported media pair/);
  assert.equal(state.mintedTickets, 0, 'unsupported MIME pairs are rejected before minting a credential');

  const session = await execUploadTool('import_media', {
    action: 'create_session',
    assetType: 'image',
    filename: '/Users/editor/素材/海报.最终版.png',
    contentType: 'image/png',
    size: 1024,
  }, context) as ImportSession;
  assert.match(session.sessionId, /^sess_/);
  assert.equal(session.state, 'awaiting_upload');
  assert.equal(session.slots.length, 1);
  const slot = session.slots[0]!;
  assert.equal(slot.filename, '海报.最终版.png');
  assert.equal(slot.existingAsset, false);
  assert.equal(slot.fileKey, `uploads/${slot.assetId}.${session.sessionId}.png`);
  assert.match(slot.uploadUrl, /^http:\/\/editor\.test\/upload\?/);
  const slotUrl = new URL(slot.uploadUrl);
  assert.equal(slotUrl.searchParams.get('sessionId'), session.sessionId);
  assert.equal(slotUrl.searchParams.get('projectId'), 'project-test');
  assert.equal(draft.getDoc().assets.length, 0, 'an import slot does not publish a placeholder asset');

  const firstHash = 'ab'.repeat(32);
  state.receipts.set('receipt-new', { value: {
    sessionId: session.sessionId,
    assetId: slot.assetId,
    filename: slot.filename,
    projectId: 'project-test',
    fileKey: slot.fileKey,
    readUrl: `/media/${slot.fileKey}`,
    size: slot.size,
    type: 'image',
    contentType: 'image/png',
    contentHash: firstHash,
  } });
  const created = await execUploadTool('finalize_uploaded_asset', {
    receipt: 'receipt-new',
    assetType: 'image',
    assetId: 'client-spoof-is-ignored',
    readUrl: '/media/uploads/client-spoof.png',
  }, context) as {
    assetId: string; sourceRevision: string; sourceContentHash: string; receiptCommit: string;
  };
  assert.equal(created.assetId, slot.assetId);
  const createdAsset = draft.getDoc().assets.find((asset) => asset.id === slot.assetId);
  assert.equal(createdAsset?.sourceFilename, slot.filename);
  assert.equal(createdAsset?.sourceContentHash, firstHash);
  assert.equal(created.sourceRevision, `source-sha256-${firstHash}`);
  assert.equal(created.sourceContentHash, firstHash);
  assert.equal(created.receiptCommit, 'committed');
  const reused = await execUploadTool('finalize_uploaded_asset', {
    receipt: 'receipt-new',
    assetType: 'image',
  }, context) as { error?: string };
  assert.match(reused.error ?? '', /unavailable|invalid|expired|consumed/);

  const replacement = await execUploadTool('import_media', {
    action: 'create_session',
    assetId: slot.assetId,
    assetType: 'image',
    filename: '替换后.jpg',
    contentType: 'image/jpeg',
    size: 2048,
  }, context) as ImportSession;
  const replacementSlot = replacement.slots[0]!;
  assert.equal(replacementSlot.assetId, slot.assetId);
  assert.equal(replacementSlot.existingAsset, true);
  const replacementHash = 'cd'.repeat(32);
  state.receipts.set('receipt-replace', { value: {
    sessionId: replacement.sessionId,
    assetId: slot.assetId,
    filename: replacementSlot.filename,
    projectId: 'project-test',
    fileKey: replacementSlot.fileKey,
    readUrl: `/media/${replacementSlot.fileKey}`,
    size: replacementSlot.size,
    type: 'image',
    contentType: 'image/jpeg',
    contentHash: replacementHash,
  } });
  await execUploadTool('finalize_uploaded_asset', {
    receipt: 'receipt-replace',
    assetType: 'image',
  }, context);
  const replacedAsset = draft.getDoc().assets.find((asset) => asset.id === slot.assetId);
  assert.equal(replacedAsset?.name, '替换后.jpg');
  assert.equal(replacedAsset?.sourceContentHash, replacementHash);
  assert.equal(replacedAsset?.sourceRevision, `source-sha256-${replacementHash}`);
}
