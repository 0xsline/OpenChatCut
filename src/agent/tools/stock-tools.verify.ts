import assert from 'node:assert/strict';
import { makeDraft } from '../../editor/store';
import type { TimelineState } from '../../editor/types';
import { docFromTimeline } from '../../persist/projectStore';
import type { AgentContext } from '../context';
import { execStockTool } from './stock-tools';

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

const originalFetch = globalThis.fetch;
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
Object.defineProperty(globalThis, 'window', {
  configurable: true,
  value: {
    openChatCutDesktop: {
      editorCredentials: async () => ({
        editorToken: 'stock-tool-test',
        mcpToken: 'stock-tool-test',
      }),
    },
  },
});
const importRequests: Array<Record<string, unknown>> = [];
globalThis.fetch = async (_input, init) => {
  const request = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
  importRequests.push(request);
  const url = typeof request.url === 'string' ? request.url : '';
  if (url.includes('fallback')) {
    return Response.json({ ok: false, error: 'materializer unavailable' });
  }
  if (url.includes('legacy')) {
    return Response.json({
      ok: true,
      path: '/media/uploads/legacy-uuid.wav',
      filename: 'Original Voice Note.wav',
    });
  }
  return Response.json({
    ok: true,
    path: '/media/uploads/download-uuid.mov',
    filename: 'C:\\camera\\Camera Original.MOV',
  });
};

try {
  const downloaded = await execStockTool('download_media', {
    url: 'https://cdn.example.test/camera-source.mov',
    name: 'Edited interview title',
  }, context) as { succeeded: number; results: Array<{ assetId: string }> };
  assert.equal(downloaded.succeeded, 1);
  const downloadedAsset = draft.getDoc().assets.find((asset) => asset.id === downloaded.results[0]?.assetId);
  assert.equal(downloadedAsset?.sourceFilename, 'Camera Original.MOV',
    'materializer response filenames are reduced to a safe basename');
  assert.equal(downloadedAsset?.name, 'Edited interview title');
  assert.equal(Object.hasOwn(importRequests[0] ?? {}, 'name'), false,
    'display override is never forwarded as a materialized filename hint');
  assert.equal(downloadedAsset?.originalFilePath, undefined);

  draft.commands.renameMediaAsset(downloadedAsset!.id, 'Second display name');
  const renamed = draft.getDoc().assets.find((asset) => asset.id === downloadedAsset!.id);
  assert.equal(renamed?.name, 'Second display name');
  assert.equal(renamed?.sourceFilename, 'Camera Original.MOV', 'display renames preserve the imported basename');

  const pushed = await execStockTool('push_asset', {
    filePath: 'https://cdn.example.test/fallback/private%2F%E6%B5%B7%E6%8A%A5%2001.png?token=secret',
    name: '宣传图显示名',
  }, context) as { succeeded: number; results: Array<{ assetId: string }> };
  assert.equal(pushed.succeeded, 1);
  const pushedAsset = draft.getDoc().assets.find((asset) => asset.id === pushed.results[0]?.assetId);
  assert.equal(pushedAsset?.sourceFilename, '海报 01.png', 'remote fallback keeps only the decoded URL basename');
  assert.equal(pushedAsset?.name, '宣传图显示名');
  assert.equal(pushedAsset?.originalFilePath, undefined);

  const legacy = await execStockTool('import_url_asset', {
    url: 'https://cdn.example.test/legacy/voice.wav',
  }, context) as { ok: boolean; asset: { id: string } };
  assert.equal(legacy.ok, true);
  const legacyAsset = draft.getDoc().assets.find((asset) => asset.id === legacy.asset.id);
  assert.equal(legacyAsset?.sourceFilename, 'Original Voice Note.wav');
  assert.equal(legacyAsset?.originalFilePath, undefined);
} finally {
  globalThis.fetch = originalFetch;
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
  else Reflect.deleteProperty(globalThis, 'window');
}

console.log('stock source identity verify: ok');
