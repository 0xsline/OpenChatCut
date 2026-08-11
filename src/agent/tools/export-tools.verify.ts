// Runnable contract check: `npx tsx src/agent/export-tools.check.ts`.
// fetch is stubbed — this NEVER touches the network or the dev server.
import { CURRENT_PROJECT_VERSION } from '../../../shared/project-version';
import assert from 'node:assert';
import { makeDraft } from '../../editor/store';
import type { ProjectDoc } from '../../editor/types';
import { docFromTimeline } from '../../persist/projectStore';
import type { AgentContext } from '../context';
import { execExportTool, EXPORT_TOOL_NAMES, EXPORT_TOOL_SCHEMAS, __resetExportSessionJobs } from './export-tools';
import { executeGenerateCommand } from './generate-tool-handlers';

const draft = makeDraft(docFromTimeline({ fps: 30, width: 1920, height: 1080, items: [], selectedId: null, assets: [] }));
const ctx: AgentContext = { commands: draft.commands, getState: draft.getState, getDoc: draft.getDoc, getCreativeMode: () => null, templates: [], audio: [] };

const BLOB_A = 'blob:http://127.0.0.1:5199/agent-a';
const BLOB_B = 'blob:http://127.0.0.1:5199/agent-b';

function contextWithBlobSources(sources: Array<{ id: string; name: string; src: string }>): AgentContext {
  const blobDraft = makeDraft(docFromTimeline({
    fps: 30,
    width: 1920,
    height: 1080,
    items: sources.map((source, index) => ({
      ...source,
      kind: 'image' as const,
      track: 'V1',
      startFrame: index * 30,
      durationInFrames: 30,
    })),
    selectedId: null,
    assets: [],
  }));
  return {
    commands: blobDraft.commands,
    getState: blobDraft.getState,
    getDoc: blobDraft.getDoc,
    getCreativeMode: () => null,
    templates: [],
    audio: [],
  };
}

function nestedExportContext(): { ctx: AgentContext; doc: ProjectDoc } {
  const timeline = (id: string, order: number, items: ProjectDoc['timelines'][number]['items']) => ({
    id, name: id, order, fps: 30, width: 1920, height: 1080, selectedId: null, items,
  });
  const doc: ProjectDoc = {
    version: CURRENT_PROJECT_VERSION,
    assets: [{ id: 'unused', name: 'unused.png', kind: 'image', src: BLOB_B, durationInFrames: 30 }],
    mediaFolders: [],
    activeTimelineId: 'root',
    timelines: [
      timeline('root', 0, [{
        id: 'nested', name: 'nested', kind: 'sequence', timelineId: 'child',
        track: 'V1', startFrame: 0, durationInFrames: 30,
      }]),
      timeline('child', 1, [{
        id: 'child-image', name: 'child.png', kind: 'image', src: BLOB_A,
        track: 'V1', startFrame: 0, durationInFrames: 30,
      }]),
      timeline('inactive', 2, [{
        id: 'inactive-image', name: 'inactive.png', kind: 'image', src: BLOB_B,
        track: 'V1', startFrame: 0, durationInFrames: 30,
      }]),
    ],
  };
  return {
    doc,
    ctx: {
      commands: {} as AgentContext['commands'],
      getState: () => { throw new Error('export must derive state from the project snapshot'); },
      getDoc: () => doc,
      getCreativeMode: () => null,
      templates: [],
      audio: [],
    },
  };
}

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

// 2) Async Agent submission materializes its exact render snapshot before POST.
let readableJobPosts = 0;
let readablePostedState: { items?: Array<{ src?: string }> } | undefined;
globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
  const target = String(url);
  if (target === BLOB_A) {
    return new Response(new Blob([new Uint8Array([1])], { type: 'image/png' }), { status: 200 });
  }
  if (target.startsWith('/upload')) {
    const name = new URL(target, 'http://x').searchParams.get('name');
    return Response.json({ path: `/media/uploads/${name}` });
  }
  if (target === '/export/job' && init?.method === 'POST') {
    readableJobPosts += 1;
    const body = JSON.parse(String(init.body)) as { state?: { items?: Array<{ src?: string }> } };
    readablePostedState = body.state;
    return Response.json({ renderId: 'r-readable' });
  }
  throw new Error(`unexpected fetch: ${target}`);
}) as typeof fetch;
const readableSubmit = await execExportTool(
  'submit_render_job',
  { format: 'video' },
  contextWithBlobSources([{ id: 'readable', name: 'readable.png', src: BLOB_A }]),
) as { ok?: boolean; renderId?: string };
assert.strictEqual(readableSubmit.ok, true);
assert.strictEqual(readableSubmit.renderId, 'r-readable');
assert.strictEqual(readableJobPosts, 1);
assert.strictEqual(readablePostedState?.items?.[0]?.src, '/media/uploads/readable-blob.png');

// Nested sequence closure: the child blob is materialized from one immutable
// ProjectDoc snapshot, while unreachable revoked blobs never enter preflight.
const asyncNested = nestedExportContext();
type CapturedExportSubmission = {
  state?: ProjectDoc['timelines'][number];
  project?: ProjectDoc;
  timelineId?: string;
};
let asyncNestedBody: CapturedExportSubmission | undefined;
globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
  const target = String(url);
  if (target === BLOB_A) {
    return new Response(new Blob([new Uint8Array([1])], { type: 'image/png' }), { status: 200 });
  }
  if (target === BLOB_B) throw new Error('unreachable blob must not be fetched');
  if (target.startsWith('/upload')) return Response.json({ path: '/media/uploads/child-blob.png' });
  if (target === '/export/job' && init?.method === 'POST') {
    asyncNestedBody = JSON.parse(String(init.body)) as CapturedExportSubmission;
    return Response.json({ renderId: 'r-nested' });
  }
  throw new Error(`unexpected fetch: ${target}`);
}) as typeof fetch;
const asyncNestedPromise = execExportTool(
  'submit_render_job',
  { format: 'video' },
  asyncNested.ctx,
) as Promise<{ ok?: boolean }>;
asyncNested.doc.timelines[1]!.items[0]!.src = BLOB_B;
assert.strictEqual((await asyncNestedPromise).ok, true);
const postedAsyncNested = asyncNestedBody as CapturedExportSubmission;
assert.strictEqual(postedAsyncNested.timelineId, 'root');
assert.strictEqual(postedAsyncNested.state?.id, 'root');
assert.strictEqual(postedAsyncNested.project?.timelines[1]?.items[0]?.src, '/media/uploads/child-blob.png');
assert.strictEqual(postedAsyncNested.project?.timelines[2]?.items[0]?.src, BLOB_B);
assert.strictEqual(postedAsyncNested.project?.assets[0]?.src, BLOB_B);

const syncNested = nestedExportContext();
let syncNestedBody: CapturedExportSubmission | undefined;
const previousDocument = globalThis.document;
globalThis.document = {
  createElement: () => ({ href: '', download: '', click() {}, remove() {} }),
  body: { appendChild() {} },
} as unknown as Document;
try {
  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const target = String(url);
    if (target === BLOB_A) {
      return new Response(new Blob([new Uint8Array([1])], { type: 'image/png' }), { status: 200 });
    }
    if (target === BLOB_B) throw new Error('unreachable blob must not be fetched');
    if (target.startsWith('/upload')) return Response.json({ path: '/media/uploads/child-blob.png' });
    if (target === '/export' && init?.method === 'POST') {
      syncNestedBody = JSON.parse(String(init.body)) as CapturedExportSubmission;
      return new Response(new Blob(['video']), { status: 200 });
    }
    throw new Error(`unexpected fetch: ${target}`);
  }) as typeof fetch;
  const syncNestedPromise = executeGenerateCommand(
    'submit_export',
    { format: 'video', timelineId: 'root' },
    syncNested.ctx,
  ) as Promise<{ ok?: boolean }>;
  syncNested.doc.timelines[1]!.items[0]!.src = BLOB_B;
  assert.strictEqual((await syncNestedPromise).ok, true);
} finally {
  globalThis.document = previousDocument;
}
const postedSyncNested = syncNestedBody as CapturedExportSubmission;
assert.strictEqual(postedSyncNested.timelineId, 'root');
assert.strictEqual(postedSyncNested.state?.id, 'root');
assert.strictEqual(postedSyncNested.project?.timelines[1]?.items[0]?.src, '/media/uploads/child-blob.png');
assert.strictEqual(postedSyncNested.project?.timelines[2]?.items[0]?.src, BLOB_B);
assert.strictEqual(postedSyncNested.project?.assets[0]?.src, BLOB_B);

// 3) One readable plus one revoked blob blocks the Agent path with zero POSTs.
let blockedJobPosts = 0;
let partialUploads = 0;
globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
  const target = String(url);
  if (target === BLOB_A) {
    return new Response(new Blob([new Uint8Array([1])], { type: 'image/png' }), { status: 200 });
  }
  if (target === BLOB_B) return new Response(null, { status: 404 });
  if (target.startsWith('/upload')) {
    partialUploads += 1;
    const name = new URL(target, 'http://x').searchParams.get('name');
    return Response.json({ path: `/media/uploads/${name}` });
  }
  if (target === '/export/job' && init?.method === 'POST') {
    blockedJobPosts += 1;
    return Response.json({ renderId: 'must-not-exist' });
  }
  throw new Error(`unexpected fetch: ${target}`);
}) as typeof fetch;
const blockedSubmit = await execExportTool(
  'submit_render_job',
  { format: 'video' },
  contextWithBlobSources([
    { id: 'readable', name: 'readable.png', src: BLOB_A },
    { id: 'revoked', name: 'revoked.png', src: BLOB_B },
  ]),
) as { error?: string; code?: string; retryable?: boolean };
assert.strictEqual(partialUploads, 1, 'the readable source materializes while every reachable source is checked');
assert.strictEqual(blockedJobPosts, 0, 'revoked reachable media must block Agent job submission');
assert.strictEqual(blockedSubmit.code, 'export_media_not_ready');
assert.strictEqual(blockedSubmit.retryable, false);
assert.match(blockedSubmit.error ?? '', /revoked\.png/);
assert.match(blockedSubmit.error ?? '', /重新导入|re-import/);

// 4) track_export status maps a single snapshot to the tool result (no downloadUrl mid-flight).
globalThis.fetch = (async () => new Response(JSON.stringify({ id: 'r-123', status: 'running', progress: 10, params: {} }), { status: 200 })) as typeof fetch;
const status = await execExportTool('track_export', { renderId: 'r-123', action: 'status' }, ctx) as { status?: string; progress?: number; downloadUrl?: string };
assert.strictEqual(status.status, 'running');
assert.strictEqual(status.progress, 10);
assert.strictEqual(status.downloadUrl, undefined);

// 5) track_export wait polls queued → running → succeeded, then returns the downloadUrl.
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

// 6) unknown renderId (404) → clean error result, never a raw throw.
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
