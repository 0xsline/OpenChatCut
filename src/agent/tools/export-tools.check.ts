// Runnable contract check: `npx tsx src/agent/export-tools.check.ts`.
// fetch is stubbed — this NEVER touches the network or the dev server.
import assert from 'node:assert';
import { makeDraft } from '../../editor/store';
import { docFromTimeline } from '../../persist/projectStore';
import type { AgentContext } from '../context';
import { execExportTool, EXPORT_TOOL_NAMES, EXPORT_TOOL_SCHEMAS, __resetExportSessionJobs } from './export-tools';

const draft = makeDraft(docFromTimeline({ fps: 30, width: 1920, height: 1080, items: [], selectedId: null, assets: [] }));
const ctx: AgentContext = { commands: draft.commands, getState: draft.getState, getDoc: draft.getDoc, getCreativeMode: () => null, templates: [], audio: [] };

const originalFetch = globalThis.fetch;

// 1) submit_render_job POSTs the right body to /export/job and returns renderId.
let posted: { url: string; body: Record<string, unknown> } | null = null;
globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
  posted = { url: String(url), body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown> };
  return new Response(JSON.stringify({ renderId: 'r-123' }), { status: 200 });
}) as typeof fetch;

const submit = await execExportTool('submit_render_job', { format: 'video', codec: 'h264', name: 'final.mp4', startFrame: 0, endFrameExclusive: 90 }, ctx) as { ok?: boolean; renderId?: string };
assert.strictEqual(submit.ok, true);
assert.strictEqual(submit.renderId, 'r-123');
assert.ok(posted, 'submit should have called fetch');
const rec = posted as { url: string; body: Record<string, unknown> };
assert.strictEqual(rec.url, '/export/job');
assert.strictEqual(rec.body.format, 'video');
assert.strictEqual(rec.body.codec, 'h264');
assert.strictEqual(rec.body.name, 'final.mp4');
assert.strictEqual(rec.body.startFrame, 0);
assert.strictEqual(rec.body.endFrameExclusive, 90);
assert.ok(rec.body.state, 'body must carry the timeline state');

// 2) track_export status maps a single snapshot to the tool result (no downloadUrl mid-flight).
globalThis.fetch = (async () => new Response(JSON.stringify({ id: 'r-123', status: 'running', progress: 10, params: {} }), { status: 200 })) as typeof fetch;
const status = await execExportTool('track_export', { renderId: 'r-123', action: 'status' }, ctx) as { status?: string; progress?: number; downloadUrl?: string };
assert.strictEqual(status.status, 'running');
assert.strictEqual(status.progress, 10);
assert.strictEqual(status.downloadUrl, undefined);

// 3) track_export wait polls queued → running → succeeded, then returns the downloadUrl.
const sequence: unknown[] = [
  { id: 'r-123', status: 'queued', progress: 0, params: {} },
  { id: 'r-123', status: 'running', progress: 10, params: {} },
  { id: 'r-123', status: 'succeeded', progress: 100, params: {}, result: { path: '/media/uploads/r-123.mp4', name: 'final.mp4', sizeBytes: 2048, codec: 'h264' } },
];
let calls = 0;
globalThis.fetch = (async () => new Response(JSON.stringify(sequence[Math.min(calls++, sequence.length - 1)]), { status: 200 })) as typeof fetch;
const waited = await execExportTool('track_export', { renderId: 'r-123', action: 'wait', timeoutSeconds: 5 }, ctx) as { status?: string; progress?: number; downloadUrl?: string; sizeBytes?: number };
assert.strictEqual(waited.status, 'completed');
assert.strictEqual(waited.progress, 100);
assert.strictEqual(waited.downloadUrl, '/media/uploads/r-123.mp4');
assert.strictEqual(waited.sizeBytes, 2048);
assert.ok(calls >= 3, 'wait should have polled through queued/running/succeeded');

// 4) unknown renderId (404) → clean error result, never a raw throw.
globalThis.fetch = (async () => new Response(JSON.stringify({ error: 'render job not found' }), { status: 404 })) as typeof fetch;
const missing = await execExportTool('track_export', { renderId: 'nope', action: 'status' }, ctx) as { error?: string; ok?: boolean };
assert.ok(missing.error, 'unknown renderId should return an error field');
assert.ok(!('ok' in missing), 'a transport error should not claim ok:true');

// ── Schema requires action and supports renderIds/latest/onlyActive/timelineId/timeoutSeconds ──
{
  const schema = EXPORT_TOOL_SCHEMAS.find((t) => t.name === 'track_export')!;
  const s = schema.input_schema as { required?: string[]; properties: Record<string, unknown> };
  assert.deepStrictEqual(s.required, ['action'], 'track_export requires only action (NOT renderId)');
  for (const field of ['renderIds', 'latest', 'onlyActive', 'timelineId', 'timeoutSeconds']) {
    assert.ok(field in s.properties, `track_export schema has source field ${field}`);
  }
  // missing/bogus action → clean error
  const noAction = await execExportTool('track_export', { renderIds: 'r-123' }, ctx) as { error?: string };
  assert.ok(noAction.error?.includes('action'), 'missing action errors');
}

// ── renderIds: comma-separated multi-job + session-prefix resolution ──
{
  __resetExportSessionJobs();
  // submit two jobs so the session registry knows their full ids
  let n = 0;
  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    if (String(url) === '/export/job' && init?.method === 'POST') {
      return new Response(JSON.stringify({ renderId: ['render-aaa-1', 'render-bbb-2'][n++] }), { status: 200 });
    }
    const id = String(url).split('/').pop()!;
    const done = id === 'render-aaa-1';
    return new Response(JSON.stringify({
      id, status: done ? 'succeeded' : 'running', progress: done ? 100 : 40, params: {},
      ...(done ? { result: { path: `/media/uploads/${id}.mp4`, name: 'a.mp4', sizeBytes: 1, codec: 'h264' } } : {}),
    }), { status: 200 });
  }) as typeof fetch;
  await execExportTool('submit_render_job', {}, ctx);
  await execExportTool('submit_render_job', {}, ctx);

  // comma-separated ids (one given as a prefix) → aggregated multi-job result
  const multi = await execExportTool('track_export', { action: 'status', renderIds: 'render-aaa-1, render-bbb' }, ctx) as {
    ok?: boolean; count?: number; jobs?: Array<{ renderId?: string; status?: string; downloadUrl?: string }>;
  };
  assert.strictEqual(multi.ok, true);
  assert.strictEqual(multi.count, 2, 'two jobs polled from comma-separated renderIds');
  assert.strictEqual(multi.jobs![0]!.status, 'completed');
  assert.strictEqual(multi.jobs![0]!.downloadUrl, '/media/uploads/render-aaa-1.mp4');
  assert.strictEqual(multi.jobs![1]!.renderId, 'render-bbb-2', 'prefix "render-bbb" resolved to the full session id');
  assert.strictEqual(multi.jobs![1]!.status, 'running');

  // ambiguous prefix → clear error
  const ambiguous = await execExportTool('track_export', { action: 'status', renderIds: 'render-' }, ctx) as { error?: string };
  assert.ok(ambiguous.error?.includes('ambiguous'), 'ambiguous prefix errors');

  // ── latest semantics: renderIds omitted → newest job of this session ──
  const latest = await execExportTool('track_export', { action: 'status' }, ctx) as { renderId?: string; status?: string };
  assert.strictEqual(latest.renderId, 'render-bbb-2', 'latest defaults to true and picks the newest job');
  assert.strictEqual(latest.status, 'running');

  // onlyActive=true → newest still-rendering job (render-bbb-2 is running, aaa is done)
  const active = await execExportTool('track_export', { action: 'status', onlyActive: true }, ctx) as { renderId?: string; status?: string };
  assert.strictEqual(active.renderId, 'render-bbb-2', 'onlyActive picks the rendering job');

  // latest=false → list ALL recent jobs (newest first)
  const listed = await execExportTool('track_export', { action: 'status', latest: false }, ctx) as {
    count?: number; jobs?: Array<{ renderId?: string }>;
  };
  assert.strictEqual(listed.count, 2, 'latest=false lists both session jobs');
  assert.strictEqual(listed.jobs![0]!.renderId, 'render-bbb-2', 'newest first');

  // wait respects timeoutSeconds: running job + tiny timeout returns the non-terminal snapshot
  const t0 = Date.now();
  const waited2 = await execExportTool('track_export', { action: 'wait', renderIds: 'render-bbb-2', timeoutSeconds: 0.01 }, ctx) as { status?: string };
  assert.strictEqual(waited2.status, 'running', 'wait returns latest snapshot at timeout');
  assert.ok(Date.now() - t0 < 5000, 'tiny timeout returns promptly');
}

// ── latest with an empty session registry → helpful error, no fetch guessing ──
{
  __resetExportSessionJobs();
  const none = await execExportTool('track_export', { action: 'status' }, ctx) as { error?: string };
  assert.ok(none.error?.includes('renderIds'), 'empty-session latest points at renderIds');
}

// registry sanity — the names the integrator wires into tools.ts.
assert.ok(EXPORT_TOOL_NAMES.has('submit_render_job'));
assert.ok(EXPORT_TOOL_NAMES.has('track_export'));

globalThis.fetch = originalFetch;
console.log('export-tools.check: ok');
