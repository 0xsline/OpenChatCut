import assert from 'node:assert/strict';
import { makeDraft } from '../../editor/store';
import type { TimelineState } from '../../editor/types';
import { safeSourceFilename } from '../../media/sourceFilename';
import { docFromTimeline } from '../../persist/projectStore';
import type { AgentContext } from '../context';
import { execUploadTool } from './upload-tools';

interface UploadSlot {
  assetId: string;
  existingAsset: boolean;
  filename: string;
  fileKey: string;
  uploadUrl: string;
  size: number;
}

interface ImportSession {
  sessionId: string;
  state: string;
  slots: UploadSlot[];
  note: string;
}

interface ReceiptValue {
  sessionId: string;
  assetId: string;
  filename: string;
  projectId: string;
  fileKey: string;
  readUrl: string;
  size: number;
  type: 'image';
  contentType: string;
  contentHash: string;
}

const originalFetch = globalThis.fetch;
const originalLocation = Object.getOwnPropertyDescriptor(globalThis, 'location');
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
Object.defineProperty(globalThis, 'location', {
  configurable: true,
  value: { origin: 'http://editor.test' },
});
Object.defineProperty(globalThis, 'window', {
  configurable: true,
  value: {
    openChatCutDesktop: {
      editorCredentials: async () => ({
        credential: 'editor-test-credential',
        mcpToken: 'mcp-test-token',
      }),
    },
  },
});

let mintedTickets = 0;
const mintedBodies: Array<Record<string, unknown>> = [];
const receipts = new Map<string, ReceiptValue>();
globalThis.fetch = async (input, init) => {
  const url = String(input);
  const headers = new Headers(init?.headers);
  assert.equal(headers.get('X-OpenChatCut-Editor-Credential'), 'editor-test-credential');
  if (url === '/api/external-agent/import-token') {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    mintedBodies.push(body);
    assert.equal(body.projectId, 'project-test');
    assert.equal(body.method, 'POST');
    const query = new URLSearchParams({
      name: String(body.filename),
      sessionId: String(body.sessionId),
      assetId: String(body.assetId),
      assetType: String(body.assetType),
      projectId: String(body.projectId),
      handoff: `ticket-${mintedTickets += 1}`,
    });
    return Response.json({
      uploadUrl: `/upload?${query.toString()}`,
      expiresAt: Date.now() + 300_000,
      expiresInSeconds: 300,
      allowedMethods: ['POST'],
    }, { status: 201 });
  }
  if (url === '/api/external-agent/upload-receipt') {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    const receipt = typeof body.receipt === 'string' ? body.receipt : '';
    const value = receipts.get(receipt);
    if (!value || body.projectId !== value.projectId) {
      return Response.json({ error: 'invalid receipt' }, { status: 409 });
    }
    receipts.delete(receipt);
    return Response.json(value);
  }
  throw new Error(`unexpected fetch target: ${url}`);
};

assert.equal(safeSourceFilename('/Users/editor/素材/采访.最终版.001.MOV'), '采访.最终版.001.MOV');
assert.equal(safeSourceFilename('D:\\capture\\采访.最终版.001.MOV'), '采访.最终版.001.MOV');
assert.equal(safeSourceFilename('\\\\server\\share\\采访.最终版.001.MOV'), '采访.最终版.001.MOV');
assert.equal(safeSourceFilename('literal%2Fname.final.mov'), 'literal%2Fname.final.mov');
for (const invalid of ['', ' ', '.', '..', '/tmp/', 'bad\u0001.mov', 42, null]) {
  assert.equal(safeSourceFilename(invalid), undefined);
}

const state: TimelineState = {
  fps: 30,
  width: 1920,
  height: 1080,
  selectedId: null,
  items: [],
};
const draft = makeDraft(docFromTimeline(state));
const context: AgentContext = {
  commands: draft.commands,
  getState: draft.getState,
  getDoc: draft.getDoc,
  getProjectId: () => 'project-test',
  getCreativeMode: () => null,
  templates: [],
  audio: [],
};

const incomplete = await execUploadTool('import_media', {
  action: 'create_session',
}, context) as { error?: string };
assert.match(incomplete.error ?? '', /assetType/);
assert.equal(mintedTickets, 0);
const mismatchedMediaType = await execUploadTool('import_media', {
  action: 'create_session',
  assetType: 'image',
  filename: 'payload.html',
  contentType: 'text/html',
  size: 32,
}, context) as { error?: string };
assert.match(mismatchedMediaType.error ?? '', /supported media pair/);
assert.equal(mintedTickets, 0, 'unsupported MIME pairs are rejected before minting a credential');

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
assert.equal(slot.fileKey, `uploads/${slot.assetId}.png`);
assert.match(slot.uploadUrl, /^http:\/\/editor\.test\/upload\?/);
const slotUrl = new URL(slot.uploadUrl);
assert.equal(slotUrl.searchParams.get('sessionId'), session.sessionId);
assert.equal(slotUrl.searchParams.get('projectId'), 'project-test');
assert.equal(draft.getDoc().assets.length, 0, 'an import slot does not publish a placeholder asset');

const firstHash = 'ab'.repeat(32);
receipts.set('receipt-new', {
  sessionId: session.sessionId,
  assetId: slot.assetId,
  filename: slot.filename,
  projectId: 'project-test',
  fileKey: `uploads/${slot.assetId}.png`,
  readUrl: `/media/uploads/${slot.assetId}.png`,
  size: slot.size,
  type: 'image',
  contentType: 'image/png',
  contentHash: firstHash,
});
const created = await execUploadTool('finalize_uploaded_asset', {
  receipt: 'receipt-new',
  assetId: 'client-spoof-is-ignored',
  readUrl: '/media/uploads/client-spoof.png',
}, context) as { assetId: string; sourceRevision: string; sourceContentHash: string };
assert.equal(created.assetId, slot.assetId);
const createdAsset = draft.getDoc().assets.find((asset) => asset.id === slot.assetId);
assert.equal(createdAsset?.sourceFilename, slot.filename);
assert.equal(createdAsset?.sourceContentHash, firstHash);
assert.equal(created.sourceRevision, `source-sha256-${firstHash}`);
assert.equal(created.sourceContentHash, firstHash);
const reused = await execUploadTool('finalize_uploaded_asset', {
  receipt: 'receipt-new',
}, context) as { error?: string };
assert.match(reused.error ?? '', /invalid|expired|consumed/);

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
receipts.set('receipt-replace', {
  sessionId: replacement.sessionId,
  assetId: slot.assetId,
  filename: replacementSlot.filename,
  projectId: 'project-test',
  fileKey: `uploads/${slot.assetId}.jpg`,
  readUrl: `/media/uploads/${slot.assetId}.jpg`,
  size: replacementSlot.size,
  type: 'image',
  contentType: 'image/jpeg',
  contentHash: replacementHash,
});
await execUploadTool('finalize_uploaded_asset', { receipt: 'receipt-replace' }, context);
const replacedAsset = draft.getDoc().assets.find((asset) => asset.id === slot.assetId);
assert.equal(replacedAsset?.name, '替换后.jpg');
assert.equal(replacedAsset?.sourceContentHash, replacementHash);
assert.equal(replacedAsset?.sourceRevision, `source-sha256-${replacementHash}`);

const unsafe = await execUploadTool('import_media', {
  action: 'create_session',
  assetType: 'image',
  filename: 'bad\u0001.png',
  contentType: 'image/png',
  size: 1,
}, context) as { error?: string };
assert.match(unsafe.error ?? '', /safe basename/);
assert.equal(mintedBodies.length, 2);
const removedLegacy = await execUploadTool('request_asset_upload_url', {}, context) as { error?: string };
assert.match(removedLegacy.error ?? '', /unknown tool/);

globalThis.fetch = originalFetch;
if (originalLocation) Object.defineProperty(globalThis, 'location', originalLocation);
else Reflect.deleteProperty(globalThis, 'location');
if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
else Reflect.deleteProperty(globalThis, 'window');

console.log('upload import session verify: ok');
