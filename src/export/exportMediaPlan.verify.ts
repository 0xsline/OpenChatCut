import assert from 'node:assert/strict';
import { ExportFailureError } from './exportFailure';
import {
  assertExportMediaReadable,
  collectExportMediaPlan,
  immutableExportSnapshot,
} from './exportMediaPlan';

interface ProbeBodyState {
  cancels: number;
  reads: number;
}

function trackedProbeResponse(status: number, contentType: string, state: ProbeBodyState): Response {
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      state.reads += 1;
      controller.enqueue(Uint8Array.of(0));
      controller.close();
    },
    cancel() {
      state.cancels += 1;
    },
  }, { highWaterMark: 0 });
  return new Response(body, {
    status,
    headers: { 'content-type': contentType },
  });
}

const project = {
  activeTimelineId: 'main',
  timelines: [
    {
      id: 'main',
      items: [
        { id: 'video', kind: 'video', src: '/media/uploads/video.mp4', effects: [{ id: 'fx', assetId: 'lut' }] },
        { id: 'audio', kind: 'audio', src: '/audio/music.mp3' },
        { id: 'nested', kind: 'sequence', timelineId: 'sequence-a' },
      ],
      fxDefs: { lut: { cube: '/luts/look.cube' } },
      transitions: [{ outgoingItemId: 'video', maskSrc: '/media/uploads/wipe.png' }],
      captions: { sourceItemId: 'audio', backgroundImageUrl: '/media/uploads/caption.png' },
    },
    {
      id: 'sequence-a',
      items: [{ id: 'nested-video', kind: 'video', src: '/media/uploads/nested.mp4' }],
    },
  ],
};

const plan = collectExportMediaPlan(project);
assert.deepEqual(
  [...new Set(plan.references.map((reference) => reference.owner))].sort(),
  ['audio', 'caption', 'effect', 'item', 'transition'],
);
assert.ok(plan.references.some((reference) => reference.timelineId === 'sequence-a' && reference.source.endsWith('nested.mp4')));
assert.equal(plan.issues.length, 0);

const snapshot = immutableExportSnapshot(project);
project.timelines[0]!.items[0]!.src = '/media/uploads/mutated-after-submit.mp4';
assert.equal(
  collectExportMediaPlan(snapshot).references.some((reference) => reference.source.includes('mutated-after-submit')),
  false,
  'queued exports use the immutable submission snapshot',
);

let enqueued = 0;
const missing = {
  items: [{ id: 'offline', kind: 'video', src: '/media/uploads/missing.mp4' }],
};
await assert.rejects(
  async () => {
    await assertExportMediaReadable(missing, async () => new Response(null, { status: 404 }));
    enqueued += 1;
  },
  (error: unknown) => error instanceof ExportFailureError
    && error.failure.stage === 'preflight'
    && error.failure.code === 'export_media_preflight_failed'
    && error.failure.mediaIssues?.[0]?.itemId === 'offline',
);
assert.equal(enqueued, 0, 'missing media must fail before enqueue');

const htmlFallback = {
  items: [
    { id: 'html-200', kind: 'video', src: '/media/uploads/html-200.mp4' },
    { id: 'html-206', kind: 'video', src: '/media/uploads/html-206.mp4' },
  ],
};
const htmlBodyState: ProbeBodyState = { cancels: 0, reads: 0 };
const htmlRequests: Array<{ source: string; init: RequestInit }> = [];
await assert.rejects(
  () => assertExportMediaReadable(htmlFallback, async (input, init) => {
    const source = String(input);
    htmlRequests.push({ source, init: init ?? {} });
    return trackedProbeResponse(source.includes('206') ? 206 : 200, 'text/html; charset=utf-8', htmlBodyState);
  }),
  (error: unknown) => {
    if (!(error instanceof ExportFailureError) || error.failure.code !== 'export_media_preflight_failed') return false;
    const issues = error.failure.mediaIssues ?? [];
    return issues.some((issue) => issue.code === 'missing_source'
      && issue.itemId === 'html-200'
      && issue.source === '/media/uploads/html-200.mp4')
      && issues.some((issue) => issue.code === 'missing_source'
        && issue.itemId === 'html-206'
        && issue.source === '/media/uploads/html-206.mp4');
  },
);
assert.equal(htmlRequests.length, 2);
for (const request of htmlRequests) {
  assert.equal(request.init.method, 'GET');
  assert.equal(new Headers(request.init.headers).get('Range'), 'bytes=0-0');
  assert.equal(request.init.cache, 'no-store');
}
assert.equal(htmlBodyState.cancels, 2, 'HTML fallback response bodies must be canceled');
assert.equal(htmlBodyState.reads, 0, 'HTML fallback response bodies must not be read');

const readableMedia = {
  items: [
    { id: 'partial-video', kind: 'video', src: '/media/uploads/partial.mp4' },
    { id: 'image', kind: 'image', src: '/media/uploads/poster.png' },
    { id: 'remote-audio', kind: 'audio', src: 'https://cdn.example.test/audio.mp3' },
    { id: 'live-blob', kind: 'video', src: 'blob:https://app.openchatcut.test/live-video' },
    { id: 'inline-image', kind: 'image', src: 'data:image/png;base64,AA==' },
  ],
};
const successfulResponses: Record<string, { status: number; contentType: string }> = {
  '/media/uploads/partial.mp4': { status: 206, contentType: 'video/mp4' },
  '/media/uploads/poster.png': { status: 200, contentType: 'image/png' },
  'https://cdn.example.test/audio.mp3': { status: 200, contentType: 'audio/mpeg' },
  'blob:https://app.openchatcut.test/live-video': { status: 200, contentType: 'video/mp4' },
};
const successfulBodyState: ProbeBodyState = { cancels: 0, reads: 0 };
const successfulRequests: Array<{ source: string; init: RequestInit }> = [];
const readablePlan = await assertExportMediaReadable(readableMedia, async (input, init) => {
  const source = String(input);
  const response = successfulResponses[source];
  assert.ok(response, `unexpected media probe for ${source}`);
  successfulRequests.push({ source, init: init ?? {} });
  return trackedProbeResponse(response.status, response.contentType, successfulBodyState);
});
assert.equal(readablePlan.issues.length, 0);
assert.equal(successfulRequests.length, 4, 'data URLs are readable without a network probe');
for (const request of successfulRequests) {
  assert.equal(request.init.method, 'GET');
  assert.equal(new Headers(request.init.headers).get('Range'), 'bytes=0-0');
  assert.equal(request.init.cache, 'no-store');
}
assert.equal(successfulBodyState.cancels, 4, 'successful probe response bodies must be canceled');
assert.equal(successfulBodyState.reads, 0, 'successful probe response bodies must not be read');

console.log('export media preflight verification passed');
