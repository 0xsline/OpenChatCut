// Runnable contract check: `npx tsx src/agent/mg-video-tools.check.ts`.
// Covers register_converted_video's schema (required=['mgAssetId'];
// renderId preferred, outputUrl fallback). fetch is stubbed — no network.
import assert from 'node:assert';
import { makeDraft } from '../../editor/store';
import { docFromTimeline } from '../../persist/projectStore';
import type { AgentContext } from '../context';
import { execMgVideoTool, MG_VIDEO_TOOL_SCHEMAS, MG_VIDEO_TOOL_NAMES } from './mg-video-tools';

const draft = makeDraft(docFromTimeline({
  fps: 30, width: 1920, height: 1080, selectedId: null,
  // motion-graphic pool assets must carry a code string to pass isMediaAsset validation
  assets: [{ id: 'mg_source_1', name: 'Title Card', kind: 'motion-graphic', src: 'tpl:title', durationInFrames: 120, code: 'export default () => null;' }],
  items: [{ id: 'it_1', track: 'V1', startFrame: 0, durationInFrames: 90, name: 'Lower Third', kind: 'motion-graphic', templateId: 'tpl_lower3' }],
}));
const ctx: AgentContext = { commands: draft.commands, getState: draft.getState, getDoc: draft.getDoc, getCreativeMode: () => null, templates: [], audio: [] };

// ── Schema requires mgAssetId and exposes renderId + outputUrl ─────────────
{
  const schema = MG_VIDEO_TOOL_SCHEMAS.find((t) => t.name === 'register_converted_video')!;
  const s = schema.input_schema as { required?: string[]; properties: Record<string, unknown> };
  assert.deepStrictEqual(s.required, ['mgAssetId'], 'required is mgAssetId (NOT outputUrl)');
  assert.ok('renderId' in s.properties, 'schema has renderId (preferred)');
  assert.ok('outputUrl' in s.properties, 'schema has outputUrl (fallback)');
  assert.ok(MG_VIDEO_TOOL_NAMES.has('register_converted_video'));
}

// ── mgAssetId is required: outputUrl alone no longer suffices ──
{
  const r = await execMgVideoTool('register_converted_video', { outputUrl: '/media/uploads/x.mp4' }, ctx) as { error?: string };
  assert.ok(r.error?.includes('mgAssetId'), 'missing mgAssetId errors even with outputUrl');
}

// ── unknown mgAssetId → clear error ──
{
  const r = await execMgVideoTool('register_converted_video', { mgAssetId: 'nope', outputUrl: '/media/uploads/x.mp4' }, ctx) as { error?: string };
  assert.ok(r.error?.includes('nope'), 'unknown mgAssetId errors');
}

// ── neither renderId nor outputUrl → guidance error naming both ──
{
  const r = await execMgVideoTool('register_converted_video', { mgAssetId: 'mg_source_1' }, ctx) as { error?: string };
  assert.ok(r.error?.includes('renderId') && r.error?.includes('outputUrl'), 'asks for renderId (preferred) or outputUrl');
}

// ── outputUrl fallback path: registers a video asset with MG-derived defaults ──
const viaUrl = await execMgVideoTool(
  'register_converted_video',
  { mgAssetId: 'mg_sou', outputUrl: '/media/uploads/render-1.webm' }, // prefix id resolution
  ctx,
) as { ok?: boolean; assetId?: string; videoAssetId?: string; mgAssetId?: string; name?: string; durationInFrames?: number };
assert.strictEqual(viaUrl.ok, true);
assert.strictEqual(viaUrl.mgAssetId, 'mg_source_1', 'mg prefix resolved');
assert.strictEqual(viaUrl.name, 'Title Card (video)', 'name derived from the MG source');
assert.strictEqual(viaUrl.durationInFrames, 120, 'duration defaults to the MG length');
assert.strictEqual(viaUrl.videoAssetId, viaUrl.assetId, 'videoAssetId returned');
const stored = draft.getDoc().assets.find((a) => a.id === viaUrl.assetId);
assert.strictEqual(stored?.kind, 'video');
assert.strictEqual(stored?.src, '/media/uploads/render-1.webm');

// ── deterministic dedupe: re-running with the same output resolves to the SAME asset ──
{
  const again = await execMgVideoTool(
    'register_converted_video',
    { mgAssetId: 'mg_source_1', outputUrl: '/media/uploads/render-1.webm' },
    ctx,
  ) as { ok?: boolean; assetId?: string; deduped?: boolean };
  assert.strictEqual(again.ok, true);
  assert.strictEqual(again.assetId, viaUrl.assetId, 're-run dedupes to the same asset id');
  assert.strictEqual(again.deduped, true);
}

// ── invalid outputUrl scheme rejected ──
{
  const r = await execMgVideoTool('register_converted_video', { mgAssetId: 'mg_source_1', outputUrl: 'ftp://x/y.mp4' }, ctx) as { error?: string };
  assert.ok(r.error, 'non-http(s)/non-same-origin outputUrl rejected');
}

// ── renderId preferred path: completed job → backend-resolved output, no URL passed ──
const originalFetch = globalThis.fetch;
globalThis.fetch = (async (url: RequestInfo | URL) => {
  const id = String(url).split('/').pop()!;
  if (id === 'r-done') {
    return new Response(JSON.stringify({ id, status: 'succeeded', progress: 100, params: {}, result: { path: '/media/uploads/r-done.mp4', name: 'mg.mp4', sizeBytes: 9, codec: 'h264' } }), { status: 200 });
  }
  if (id === 'r-running') {
    return new Response(JSON.stringify({ id, status: 'running', progress: 30, params: {} }), { status: 200 });
  }
  return new Response(JSON.stringify({ error: 'render job not found' }), { status: 404 });
}) as typeof fetch;

const viaRender = await execMgVideoTool(
  'register_converted_video',
  { mgAssetId: 'tpl_lower3', renderId: 'r-done' }, // item templateId resolution
  ctx,
) as { ok?: boolean; assetId?: string; mgAssetId?: string; name?: string; durationInFrames?: number };
assert.strictEqual(viaRender.ok, true, 'renderId path registers without outputUrl');
assert.strictEqual(viaRender.mgAssetId, 'tpl_lower3', 'mg resolved via placed clip templateId');
assert.strictEqual(viaRender.name, 'Lower Third (video)');
assert.strictEqual(viaRender.durationInFrames, 90, 'duration from the placed MG clip');
assert.strictEqual(draft.getDoc().assets.find((a) => a.id === viaRender.assetId)?.src, '/media/uploads/r-done.mp4', 'src resolved from the render job record');

// renderId not complete yet → error pointing back at track_export (nothing registered)
{
  const before = draft.getDoc().assets.length;
  const r = await execMgVideoTool('register_converted_video', { mgAssetId: 'mg_source_1', renderId: 'r-running' }, ctx) as { error?: string };
  assert.ok(r.error?.includes('track_export'), 'incomplete render points at track_export');
  assert.strictEqual(draft.getDoc().assets.length, before, 'no asset registered on incomplete render');
}

// unknown renderId → clean error from the job store
{
  const r = await execMgVideoTool('register_converted_video', { mgAssetId: 'mg_source_1', renderId: 'r-ghost' }, ctx) as { error?: string };
  assert.ok(r.error, 'unknown renderId errors cleanly');
}

globalThis.fetch = originalFetch;
console.log('mg-video-tools.check: ok');
