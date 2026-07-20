// Runnable: `npx tsx src/agent/upload-tools.check.ts`
import assert from 'node:assert';
import { makeDraft } from '../../editor/store';
import { docFromTimeline } from '../../persist/projectStore';
import type { AgentContext } from '../context';
import {
  UPLOAD_TOOL_NAMES,
  UPLOAD_TOOL_SCHEMAS,
  execUploadTool,
} from './upload-tools';

const names = UPLOAD_TOOL_SCHEMAS.map((t) => t.name).sort();
assert.deepStrictEqual(
  names,
  ['finalize_uploaded_asset', 'import_media', 'request_asset_download', 'request_asset_upload_url'].sort(),
);
for (const n of names) assert.ok(UPLOAD_TOOL_NAMES.has(n));

const draft = makeDraft(docFromTimeline({
  fps: 30, width: 1920, height: 1080, items: [], selectedId: null, assets: [],
}));
const ctx: AgentContext = {
  commands: draft.commands,
  getState: draft.getState,
  getDoc: draft.getDoc,
  getCreativeMode: () => null,
  templates: [],
  audio: [],
};

const session = await execUploadTool('import_media', { action: 'create_session' }, ctx) as {
  ok: boolean; sessionId: string; directUpload: { url: string }; slots: unknown[];
};
assert.strictEqual(session.ok, true);
assert.ok(session.sessionId);
assert.strictEqual(session.directUpload.url, '/upload');
assert.ok(session.slots.length >= 1);

const req = await execUploadTool('request_asset_upload_url', {
  assetType: 'video',
  contentType: 'video/mp4',
  filename: 'clip.mp4',
  size: 1024,
}, ctx) as {
  ok: boolean;
  localDev: boolean;
  assetId: string;
  fileKey: string;
  readUrl: string;
  presignedUrl: string;
  method: string;
};
assert.strictEqual(req.ok, true);
assert.strictEqual(req.localDev, true);
assert.ok(req.assetId);
assert.ok(req.fileKey.includes(req.assetId));
assert.ok(req.readUrl.startsWith('/media/uploads/'));
assert.ok(req.presignedUrl.includes('assetId='));
assert.ok(req.presignedUrl.includes('/upload'));

// finalize without duration fails for video
const bad = await execUploadTool('finalize_uploaded_asset', {
  assetId: req.assetId,
  fileKey: req.fileKey,
  filename: 'clip.mp4',
  readUrl: req.readUrl,
  size: 1024,
  type: 'video',
}, ctx) as { error?: string };
assert.ok(bad.error?.includes('durationInSeconds'));

const fin = await execUploadTool('finalize_uploaded_asset', {
  assetId: req.assetId,
  fileKey: req.fileKey,
  filename: 'clip.mp4',
  readUrl: req.readUrl,
  size: 1024,
  type: 'video',
  durationInSeconds: 2.5,
  width: 1280,
  height: 720,
}, ctx) as {
  ok: boolean;
  assetId: string;
  durationInFrames: number;
  src: string;
};
assert.strictEqual(fin.ok, true);
assert.strictEqual(fin.assetId, req.assetId);
assert.strictEqual(fin.durationInFrames, 75); // 2.5s @ 30fps
assert.strictEqual(fin.src, req.readUrl);
const stored = draft.getDoc().assets.find((a) => a.id === req.assetId);
assert.ok(stored);
assert.strictEqual(stored!.kind, 'video');

// double finalize → alreadyRegistered
const again = await execUploadTool('finalize_uploaded_asset', {
  assetId: req.assetId,
  fileKey: req.fileKey,
  filename: 'clip.mp4',
  readUrl: req.readUrl,
  size: 1024,
  type: 'video',
  durationInSeconds: 2.5,
}, ctx) as { alreadyRegistered?: boolean };
assert.strictEqual(again.alreadyRegistered, true);

// image finalize no duration ok
const imgReq = await execUploadTool('request_asset_upload_url', {
  assetType: 'image',
  contentType: 'image/png',
  filename: 'a.png',
}, ctx) as { assetId: string; fileKey: string; readUrl: string };
const imgFin = await execUploadTool('finalize_uploaded_asset', {
  assetId: imgReq.assetId,
  fileKey: imgReq.fileKey,
  filename: 'a.png',
  readUrl: imgReq.readUrl,
  size: 10,
  type: 'image',
  width: 100,
  height: 100,
}, ctx) as { ok: boolean; durationInFrames: number };
assert.strictEqual(imgFin.ok, true);
assert.strictEqual(imgFin.durationInFrames, 90); // 3s @ 30fps

// download
const dl = await execUploadTool('request_asset_download', {
  assetId: req.assetId,
}, ctx) as { ok: boolean; path: string; downloadUrl: string; name: string };
assert.strictEqual(dl.ok, true);
assert.strictEqual(dl.path, req.readUrl);
assert.strictEqual(dl.name, 'clip.mp4');

// prefix resolve
const prefix = req.assetId.slice(0, 8);
const dl2 = await execUploadTool('request_asset_download', { assetId: prefix }, ctx) as { ok: boolean; assetId: string };
assert.strictEqual(dl2.ok, true);
assert.strictEqual(dl2.assetId, req.assetId);

const missing = await execUploadTool('request_asset_download', { assetId: 'nope' }, ctx) as { error?: string };
assert.ok(missing.error);

console.log('upload-tools.check: ok');
