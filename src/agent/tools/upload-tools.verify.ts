import assert from 'node:assert/strict';
import { makeDraft } from '../../editor/store';
import type { TimelineState } from '../../editor/types';
import { safeSourceFilename } from '../../media/sourceFilename';
import { docFromTimeline } from '../../persist/projectStore';
import type { AgentContext } from '../context';
import { execUploadTool } from './upload-tools';

assert.equal(safeSourceFilename('/Users/editor/素材/采访.最终版.001.MOV'), '采访.最终版.001.MOV');
assert.equal(safeSourceFilename('D:\\capture\\采访.最终版.001.MOV'), '采访.最终版.001.MOV');
assert.equal(safeSourceFilename('\\\\server\\share\\采访.最终版.001.MOV'), '采访.最终版.001.MOV');
assert.equal(safeSourceFilename('literal%2Fname.final.mov'), 'literal%2Fname.final.mov',
  'ordinary filenames keep percent sequences literal');
const invalidFilenames = [
  '', ' ', '.', '..', '/tmp/',
  'bad\u0001.mov', 'bad\uD800.mov', 'bad\uFFFE.mov',
  42, null,
];
for (const invalid of invalidFilenames) {
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
  getCreativeMode: () => null,
  templates: [],
  audio: [],
};

const placeholder = await execUploadTool('import_media', {
  action: 'register_placeholder',
  assetType: 'image',
  filename: '/Users/editor/素材/海报.最终版.png',
  contentType: 'image/png',
}, context) as { assetId: string; name: string; uploadUrl: string };
assert.equal(placeholder.name, '海报.最终版.png');
assert.ok(!decodeURIComponent(placeholder.uploadUrl).includes('/Users/editor'));
let asset = draft.getDoc().assets.find((candidate) => candidate.id === placeholder.assetId);
assert.equal(asset?.sourceFilename, '海报.最终版.png', 'placeholder stores only the POSIX basename');

await execUploadTool('finalize_uploaded_asset', {
  assetId: placeholder.assetId,
  fileKey: `uploads/${placeholder.assetId}.png`,
  filename: 'D:\\capture\\海报.重链.最终版.png',
  readUrl: asset!.src,
  size: 1024,
  type: 'image',
}, context);
asset = draft.getDoc().assets.find((candidate) => candidate.id === placeholder.assetId);
assert.equal(asset?.name, '海报.重链.最终版.png');
assert.equal(asset?.sourceFilename, '海报.重链.最终版.png', 'finalize relink sanitizes the Agent filename');

const created = await execUploadTool('finalize_uploaded_asset', {
  assetId: 'asset_from_finalize',
  fileKey: 'uploads/asset_from_finalize.png',
  filename: '\\\\server\\share\\新增.素材.001.png',
  readUrl: '/media/uploads/asset_from_finalize.png',
  size: 2048,
  type: 'image',
}, context) as { assetId: string };
const createdAsset = draft.getDoc().assets.find((candidate) => candidate.id === created.assetId);
assert.equal(createdAsset?.name, '新增.素材.001.png');
assert.equal(createdAsset?.sourceFilename, '新增.素材.001.png', 'finalize create sanitizes the UNC filename');

const uploadRequest = await execUploadTool('request_asset_upload_url', {
  assetType: 'image',
  contentType: 'image/png',
  filename: 'D:\\capture\\请求.素材.png',
}, context) as { filename: string; uploadUrl: string };
assert.equal(uploadRequest.filename, '请求.素材.png');
assert.ok(!decodeURIComponent(uploadRequest.uploadUrl).includes('D:\\capture'));

const rejected = await execUploadTool('import_media', {
  action: 'register_placeholder',
  assetType: 'image',
  filename: 'bad\u0001.png',
}, context) as { error?: string };
assert.match(rejected.error ?? '', /safe basename/);

console.log('upload source filename verify: ok');
