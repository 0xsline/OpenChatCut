import assert from 'node:assert/strict';
import type { ProjectDoc, Timeline } from '../../editor/types';
import { collectExportMediaPlan } from '../../export/exportMediaPlan';
import { prepareBrowserRenderSnapshots } from './renderSnapshotMedia';

const blobA = 'blob:http://localhost/preview-a';
const blobB = 'blob:http://localhost/preview-b';
const timeline = {
  id: 'timeline-preview',
  name: 'Preview',
  fps: 30,
  width: 640,
  height: 360,
  items: [
    { id: 'item-a', kind: 'video', src: blobA, track: 'V1', startFrame: 0, durationInFrames: 30, name: 'a.mp4' },
    { id: 'item-b', kind: 'video', src: blobB, track: 'V1', startFrame: 30, durationInFrames: 30, name: 'b.mp4' },
    { id: 'item-a-copy', kind: 'video', src: blobA, track: 'V1', startFrame: 60, durationInFrames: 30, name: 'a-copy.mp4' },
  ],
  tracks: {},
  transitions: [],
} as unknown as Timeline;
const project = {
  id: 'project-preview',
  name: 'Preview',
  activeTimelineId: timeline.id,
  assets: [],
  timelines: [timeline],
} as unknown as ProjectDoc;

const uploaded: string[] = [];
const deleted: string[] = [];
const prepared = await prepareBrowserRenderSnapshots({
  state: timeline,
  project,
  timelineId: timeline.id,
}, {
  ensureLocalMedia: async () => undefined,
  fetcher: async (input, init) => {
    const source = String(input);
    if (source === blobA || source === blobB) {
      return new Response(Uint8Array.of(1, 2, 3), {
        status: 200,
        headers: { 'content-type': 'video/mp4' },
      });
    }
    if (source.startsWith('/upload?')) {
      const name = new URL(source, 'http://localhost').searchParams.get('name') ?? 'preview.mp4';
      if (init?.method === 'DELETE') {
        deleted.push(name);
        return Response.json({ ok: true });
      }
      uploaded.push(name);
      return Response.json({ path: `/media/uploads/${name}` });
    }
    throw new Error(`unexpected fetch: ${source}`);
  },
});

assert.equal(uploaded.length, 2, 'each distinct blob source uploads once');
assert.equal(prepared.state.items.every((item) => item.src?.startsWith('/media/uploads/')), true);
assert.equal(prepared.project?.timelines[0]?.items.every((item) => item.src?.startsWith('/media/uploads/')), true);
assert.equal(timeline.items[0]?.src, blobA, 'preview preparation must not mutate live state');
assert.equal(collectExportMediaPlan(prepared.project!).issues.length, 0);
await prepared.cleanup();
assert.equal(deleted.length, 2, 'temporary preview uploads are removed after rendering');

console.log('render snapshot media verify: browser blob sources are publishable and cleaned up');
