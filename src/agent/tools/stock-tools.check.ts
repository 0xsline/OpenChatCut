// Runnable contract check: `npx tsx src/agent/stock-tools.check.ts`.
// No DOM under tsx, so media probe skips straight to the fallback duration
// (see the `typeof document === 'undefined'` guard). /api/import-url is
// unavailable → materialize falls back to remote URL as asset.src.
import assert from 'node:assert';
import { makeDraft } from '../../editor/store';
import { docFromTimeline } from '../../persist/projectStore';
import type { AgentContext } from '../context';
import { execStockTool, STOCK_TOOL_NAMES, STOCK_TOOL_SCHEMAS } from './stock-tools';

const names = STOCK_TOOL_SCHEMAS.map((t) => t.name).sort();
assert.deepStrictEqual(
  names,
  ['download_media', 'import_url_asset', 'push_asset', 'search_stock_media'].sort(),
);
for (const n of names) assert.ok(STOCK_TOOL_NAMES.has(n));

const base = docFromTimeline({ fps: 30, width: 1920, height: 1080, items: [], selectedId: null, assets: [] });
const draft = makeDraft(base);
const ctx: AgentContext = {
  commands: draft.commands,
  getState: draft.getState,
  getDoc: draft.getDoc,
  getCreativeMode: () => null,
  templates: [],
  audio: [],
};

// non-http(s) URLs are rejected
const ftp = await execStockTool('import_url_asset', { url: 'ftp://example.com/a.mp4' }, ctx) as { error?: string };
assert.ok(ftp.error, 'ftp:// url should be rejected');
const relative = await execStockTool('import_url_asset', { url: '/local/clip.mp4' }, ctx) as { error?: string };
assert.ok(relative.error, 'relative path should be rejected');

// legacy import_url_asset still returns { ok, asset }
const imported = await execStockTool(
  'import_url_asset',
  { url: 'https://cdn.example.com/videos/ocean-waves.mp4' },
  ctx,
) as { ok: boolean; asset: { id: string; name: string; kind: string; durationInFrames: number } };
assert.strictEqual(imported.ok, true);
assert.strictEqual(imported.asset.kind, 'video');
assert.strictEqual(imported.asset.name, 'ocean-waves.mp4');
assert.strictEqual(imported.asset.durationInFrames, 150);
const stored = draft.getDoc().assets.find((a) => a.id === imported.asset.id);
assert.ok(stored, 'addAsset should have registered the asset on the doc');
assert.strictEqual(stored!.src, 'https://cdn.example.com/videos/ocean-waves.mp4');

// image kind falls back to 3s @ 30fps = 90 frames
const image = await execStockTool(
  'import_url_asset',
  { url: 'https://cdn.example.com/photo.jpg' },
  ctx,
) as { asset: { durationInFrames: number; kind: string } };
assert.strictEqual(image.asset.kind, 'image');
assert.strictEqual(image.asset.durationInFrames, 90);

// unrecognized extension without an explicit kind arg is rejected
const unknown = await execStockTool('import_url_asset', { url: 'https://cdn.example.com/mystery' }, ctx) as { error?: string };
assert.ok(unknown.error);

// download_media batch shape.
const dl = await execStockTool(
  'download_media',
  {
    url: [
      'https://cdn.example.com/a.mp4',
      'https://cdn.example.com/b.png',
    ],
  },
  ctx,
) as {
  failed: number;
  succeeded: number;
  results: Array<{ success: boolean; assetId?: string; type?: string; error?: string }>;
};
assert.strictEqual(dl.succeeded, 2);
assert.strictEqual(dl.failed, 0);
assert.strictEqual(dl.results.length, 2);
assert.ok(dl.results.every((r) => r.success));
assert.strictEqual(dl.results[0]!.type, 'video');
assert.strictEqual(dl.results[1]!.type, 'image');

// download_media accepts either one URL string or an array.
const dlSingle = await execStockTool(
  'download_media',
  { url: 'https://cdn.example.com/solo.mp4', name: 'Solo Clip' },
  ctx,
) as { succeeded: number; results: Array<{ success: boolean; name?: string }> };
assert.strictEqual(dlSingle.succeeded, 1, 'single string url works');
assert.strictEqual(dlSingle.results[0]!.name, 'Solo Clip', 'name honored for single url');

// download_media rejects more than four URLs instead of truncating.
const tooMany = await execStockTool(
  'download_media',
  { url: [1, 2, 3, 4, 5].map((n) => `https://cdn.example.com/${n}.mp4`) },
  ctx,
) as { error?: string; results?: unknown[] };
assert.ok(tooMany.error, '5 urls should error');
assert.ok(tooMany.error!.includes('4'), 'error names the 4-url cap');
assert.strictEqual(tooMany.results, undefined, 'nothing downloaded on over-limit batch');

// download_media — name is IGNORED for batch (>1 url): display names come from the URL basename
const dlNamed = await execStockTool(
  'download_media',
  { url: ['https://cdn.example.com/first.mp4', 'https://cdn.example.com/second.png'], name: 'Should Be Ignored' },
  ctx,
) as { succeeded: number; results: Array<{ success: boolean; name?: string }> };
assert.strictEqual(dlNamed.succeeded, 2);
assert.deepStrictEqual(dlNamed.results.map((r) => r.name), ['first.mp4', 'second.png'], 'batch ignores name override');

// download_media schema — url declared as anyOf string | string[] (source field shape)
{
  const dlSchema = STOCK_TOOL_SCHEMAS.find((t) => t.name === 'download_media')!;
  const urlProp = (dlSchema.input_schema as { properties: Record<string, { anyOf?: unknown[] }> }).properties.url;
  assert.ok(Array.isArray(urlProp.anyOf) && urlProp.anyOf.length === 2, 'url schema is anyOf [string, string[]]');
  assert.deepStrictEqual((dlSchema.input_schema as { required?: string[] }).required, ['url']);
}

// push_asset — same ≤4 batch cap
const pushMany = await execStockTool(
  'push_asset',
  { filePath: [1, 2, 3, 4, 5].map((n) => `https://cdn.example.com/${n}.mp4`) },
  ctx,
) as { error?: string };
assert.ok(pushMany.error, 'push_asset also errors on >4');

// push_asset — single filePath + name override
const push = await execStockTool(
  'push_asset',
  { filePath: 'https://cdn.example.com/clip.webm', name: 'My Clip' },
  ctx,
) as {
  succeeded: number;
  results: Array<{ success: boolean; name?: string; assetId?: string }>;
};
assert.strictEqual(push.succeeded, 1);
assert.strictEqual(push.results[0]!.name, 'My Clip');

// push_asset motion-graphic with duration
const mg = await execStockTool(
  'push_asset',
  {
    filePath: 'https://cdn.example.com/mg-placeholder.bin',
    type: 'motion-graphic',
    duration: 2,
    name: 'MG Card',
  },
  ctx,
) as {
  succeeded: number;
  results: Array<{ success: boolean; type?: string; assetId?: string }>;
};
assert.strictEqual(mg.succeeded, 1);
assert.strictEqual(mg.results[0]!.type, 'motion-graphic');
const mgAsset = draft.getDoc().assets.find((a) => a.id === mg.results[0]!.assetId);
assert.ok(mgAsset);
assert.strictEqual(mgAsset!.kind, 'motion-graphic');
assert.strictEqual(mgAsset!.durationInFrames, 60); // 2s @ 30fps

// push_asset rejects effect type
const fx = await execStockTool(
  'push_asset',
  { filePath: 'https://cdn.example.com/fx.json', type: 'effect' },
  ctx,
) as { failed: number; results: Array<{ success: boolean; error?: string }> };
assert.strictEqual(fx.failed, 1);
assert.ok(fx.results[0]!.error?.includes('effect'));

// search_stock_media degrades gracefully
const originalFetch = globalThis.fetch;
globalThis.fetch = (async () => { throw new Error('network down'); }) as typeof fetch;
const failed = await execStockTool('search_stock_media', { query: 'ocean waves' }, ctx) as { error?: string; results: unknown[] };
assert.ok(failed.error);
assert.deepStrictEqual(failed.results, []);

globalThis.fetch = (async () => new Response(null, { status: 500 })) as typeof fetch;
const notOk = await execStockTool('search_stock_media', { query: 'ocean waves' }, ctx) as { error?: string; results: unknown[] };
assert.ok(notOk.error);
assert.deepStrictEqual(notOk.results, []);

globalThis.fetch = (async () => new Response(JSON.stringify({ configured: false, results: [] }), { status: 200 })) as typeof fetch;
const unconfigured = await execStockTool('search_stock_media', { query: 'ocean waves' }, ctx) as { error?: string; results: unknown[] };
assert.ok(unconfigured.error?.includes('download_media') || unconfigured.error?.includes('push_asset'));
assert.deepStrictEqual(unconfigured.results, []);
globalThis.fetch = originalFetch;

console.log('stock-tools.check: ok');
