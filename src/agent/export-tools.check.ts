// Runnable source-contract check: `npx tsx src/agent/export-tools.check.ts`.
// fetch is stubbed — this NEVER touches the network or the dev server.
import assert from 'node:assert';
import { makeDraft } from '../editor/store';
import { docFromTimeline } from '../persist/projectStore';
import type { AgentContext } from './context';
import { execExportTool, EXPORT_TOOL_NAMES } from './export-tools';

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

// registry sanity — the names the integrator wires into tools.ts.
assert.ok(EXPORT_TOOL_NAMES.has('submit_render_job'));
assert.ok(EXPORT_TOOL_NAMES.has('track_export'));

globalThis.fetch = originalFetch;
console.log('export-tools.check: ok');
