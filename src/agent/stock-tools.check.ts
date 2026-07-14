// Runnable source-contract check: `npx tsx src/agent/stock-tools.check.ts`.
// No DOM under tsx, so import_url_asset's probe skips straight to the
// fallback duration (see the `typeof document === 'undefined'` guard).
import assert from 'node:assert';
import { makeDraft } from '../editor/store';
import { docFromTimeline } from '../persist/projectStore';
import type { AgentContext } from './context';
import { execStockTool } from './stock-tools';

const base = docFromTimeline({ fps: 30, width: 1920, height: 1080, items: [], selectedId: null, assets: [] });
const draft = makeDraft(base);
const ctx: AgentContext = { commands: draft.commands, getState: draft.getState, getDoc: draft.getDoc, getCreativeMode: () => null, templates: [], audio: [] };

// non-http(s) URLs are rejected outright
const ftp = await execStockTool('import_url_asset', { url: 'ftp://example.com/a.mp4' }, ctx) as { error?: string };
assert.ok(ftp.error, 'ftp:// url should be rejected');
const relative = await execStockTool('import_url_asset', { url: '/local/clip.mp4' }, ctx) as { error?: string };
assert.ok(relative.error, 'relative path should be rejected');

// a valid http(s) URL builds a MediaAsset with the URL as src + a sane
// fallback duration (5s clip @ 30fps = 150 frames), and registers it via
// ctx.commands.addAsset.
const imported = await execStockTool('import_url_asset', { url: 'https://cdn.example.com/videos/ocean-waves.mp4' }, ctx) as { ok: boolean; asset: { id: string; name: string; kind: string; durationInFrames: number } };
assert.strictEqual(imported.ok, true);
assert.strictEqual(imported.asset.kind, 'video');
assert.strictEqual(imported.asset.name, 'ocean-waves.mp4');
assert.strictEqual(imported.asset.durationInFrames, 150);
const stored = draft.getDoc().assets.find((a) => a.id === imported.asset.id);
assert.ok(stored, 'addAsset should have registered the asset on the doc');
assert.strictEqual(stored!.src, 'https://cdn.example.com/videos/ocean-waves.mp4');

// image kind falls back to 3s @ 30fps = 90 frames
const image = await execStockTool('import_url_asset', { url: 'https://cdn.example.com/photo.jpg' }, ctx) as { asset: { durationInFrames: number; kind: string } };
assert.strictEqual(image.asset.kind, 'image');
assert.strictEqual(image.asset.durationInFrames, 90);

// unrecognized extension without an explicit kind arg is rejected
const unknown = await execStockTool('import_url_asset', { url: 'https://cdn.example.com/mystery' }, ctx) as { error?: string };
assert.ok(unknown.error);

// search_stock_media degrades gracefully instead of throwing when the proxy
// call fails outright (network error) ...
const originalFetch = globalThis.fetch;
globalThis.fetch = (async () => { throw new Error('network down'); }) as typeof fetch;
const failed = await execStockTool('search_stock_media', { query: 'ocean waves' }, ctx) as { error?: string; results: unknown[] };
assert.ok(failed.error);
assert.deepStrictEqual(failed.results, []);

// ... and when the proxy responds but with a non-ok status.
globalThis.fetch = (async () => new Response(null, { status: 500 })) as typeof fetch;
const notOk = await execStockTool('search_stock_media', { query: 'ocean waves' }, ctx) as { error?: string; results: unknown[] };
assert.ok(notOk.error);
assert.deepStrictEqual(notOk.results, []);

// ... and when the proxy is reachable but no API key is configured server-side.
globalThis.fetch = (async () => new Response(JSON.stringify({ configured: false, results: [] }), { status: 200 })) as typeof fetch;
const unconfigured = await execStockTool('search_stock_media', { query: 'ocean waves' }, ctx) as { error?: string; results: unknown[] };
assert.ok(unconfigured.error?.includes('import_url_asset'));
assert.deepStrictEqual(unconfigured.results, []);
globalThis.fetch = originalFetch;

console.log('stock-tools.check: ok');
