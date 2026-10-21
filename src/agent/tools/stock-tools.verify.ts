import assert from 'node:assert/strict';
import { makeDraft } from '../../editor/store';
import type { TimelineState } from '../../editor/types';
import { docFromTimeline } from '../../persist/projectStore';
import type { AgentContext } from '../context';
import { execStockTool, serialBatch } from './stock-tools';

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
        credential: 'stock-tool-test',
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
  if (url.includes('forbidden')) {
    return Response.json({ ok: false, error: 'upstream HTTP 403', code: 'upstream_http' });
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

  // An origin that answers 403 is a failed row: registering it as a remote source used to
  // report success for an asset that could never play or export.
  const forbidden = await execStockTool('download_media', {
    url: ['https://cdn.example.test/forbidden/clip.mp4', 'https://cdn.example.test/ok/clip.mp4'],
  }, context) as { failed: number; succeeded: number; results: Array<{ success: boolean; error?: string; url?: string }> };
  assert.equal(forbidden.failed, 1);
  assert.equal(forbidden.succeeded, 1);
  assert.equal(forbidden.results[0]?.success, false);
  assert.match(forbidden.results[0]?.error ?? '', /403/);
  assert.equal(forbidden.results[0]?.url, 'https://cdn.example.test/forbidden/clip.mp4');
  assert.equal(draft.getDoc().assets.some((asset) => asset.src.includes('forbidden')), false,
    'a forbidden origin must not enter the media pool as a remote source');

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

// Batches have no time window: every URL runs, one at a time and in order, and a failed
// row does not stop the URLs after it.
{
  const seen: string[] = [];
  let active = 0;
  let peak = 0;
  const rows = await serialBatch(['a', 'b', 'c', 'd'], async (url) => {
    active += 1;
    peak = Math.max(peak, active);
    seen.push(url);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active -= 1;
    return url === 'b'
      ? { success: false, error: 'upstream', url }
      : { success: true, assetId: url, name: url, type: 'video', src: url, local: true };
  });
  assert.deepEqual(seen, ['a', 'b', 'c', 'd'], 'every URL starts, in order');
  assert.equal(peak, 1, 'URLs run one at a time');
  assert.deepEqual(rows.map((row) => row.success), [true, false, true, true], 'every URL gets its own row');
}

console.log('stock source identity verify: ok');
