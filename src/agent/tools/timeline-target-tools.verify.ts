import assert from 'node:assert/strict';
import type { AgentContext } from '../context';
import { makeDraft } from '../../editor/store';
import type { ProjectDoc, Timeline } from '../../editor/types';
import { execFramesTool, FRAMES_TOOL_SCHEMAS } from './frames-tool';
import { execMarkersTool, MARKERS_TOOL_SCHEMAS } from './markers-tools';
import { execMgVideoTool, MG_VIDEO_TOOL_SCHEMAS } from './mg-video-tools';

const current: Timeline = {
  id: 'timeline_current',
  name: 'Current',
  order: 0,
  fps: 30,
  width: 1920,
  height: 1080,
  selectedId: null,
  trackOrder: ['track_current'],
  tracks: { track_current: { kind: 'video' } },
  items: [{
    id: 'current_clip', track: 'track_current', startFrame: 0, durationInFrames: 30,
    name: 'Current clip', kind: 'motion-graphic', templateId: 'asset_current',
  }],
  markers: [{ id: 'marker_current', scope: 'project', fromFrame: 3, durationFrames: 0, note: 'current', color: 'blue' }],
};

const target: Timeline = {
  ...current,
  id: 'timeline_target',
  name: 'Target',
  order: 1,
  trackOrder: ['track_target'],
  tracks: { track_target: { kind: 'video' } },
  items: [{
    id: 'target_clip', track: 'track_target', startFrame: 0, durationInFrames: 45,
    name: 'Target clip', kind: 'motion-graphic', templateId: 'asset_target',
  }],
  markers: [{ id: 'marker_target', scope: 'project', fromFrame: 7, durationFrames: 0, note: 'target', color: 'green' }],
};

const doc: ProjectDoc = {
  version: 3,
  assets: [],
  mediaFolders: [],
  timelines: [current, target],
  activeTimelineId: current.id,
};
const draft = makeDraft(doc);
const ctx: AgentContext = {
  commands: draft.commands,
  getState: draft.getState,
  getDoc: draft.getDoc,
  getCreativeMode: () => null,
  templates: [],
  audio: [],
};

const currentBefore = structuredClone(draft.getDoc().timelines[0]);
const targetList = execMarkersTool('manage_markers', { action: 'list', timelineId: 'timeline_tar' }, ctx) as {
  timeline: { id: string };
  markers: { id: string }[];
};
assert.equal(targetList.timeline.id, target.id);
assert.deepEqual(targetList.markers.map((marker) => marker.id), ['marker_target']);

const created = execMarkersTool('manage_markers', {
  action: 'create', timelineId: target.id, fromFrame: 12, note: 'new target marker',
}, ctx) as { created: string[] };
assert.equal(created.created.length, 1);
assert.equal(draft.getDoc().activeTimelineId, current.id);
assert.deepEqual(draft.getDoc().timelines[0], currentBefore);
assert.equal(draft.getDoc().timelines[1]?.markers?.length, 2);

const failedBatch = execMarkersTool('manage_markers', {
  action: 'create',
  timelineId: target.id,
  markers: [{ fromFrame: 20, note: 'would be partial' }, { note: 'missing position' }],
}, ctx) as { error: string };
assert.match(failedBatch.error, /requires fromFrame/);
assert.equal(draft.getDoc().timelines[1]?.markers?.length, 2, 'failed marker batches must not partially apply');

execMarkersTool('manage_markers', {
  action: 'update', timelineId: target.id, markerId: created.created[0], note: 'updated',
}, ctx);
assert.equal(draft.getDoc().timelines[1]?.markers?.find((marker) => marker.id === created.created[0])?.note, 'updated');
execMarkersTool('manage_markers', {
  action: 'delete', timelineId: target.id, markerId: created.created[0],
}, ctx);
assert.equal(draft.getDoc().timelines[1]?.markers?.some((marker) => marker.id === created.created[0]), false);

for (const result of [
  execMarkersTool('manage_markers', { action: 'list', timelineId: 'missing' }, ctx),
  await execFramesTool('view_timeline_frames', { frames: [0], timelineId: 'missing' }, ctx),
  await execMgVideoTool('export_motion_graphic_prores', { itemId: 'target_clip', timelineId: 'missing' }, ctx),
]) {
  assert.match((result as { error: string }).error, /timeline not found: missing/);
}

const originalFetch = globalThis.fetch;
let renderedTimelineId = '';
let exportedItemId = '';
globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
  const body = JSON.parse(String(init?.body ?? '{}')) as { state?: Timeline; frames?: number[] };
  if (body.frames) {
    renderedTimelineId = body.state?.id ?? '';
    return new Response(JSON.stringify({
      frames: [{ frame: body.frames[0] ?? 0, base64: 'data:image/jpeg;base64,AA==' }],
      renderedBy: 'test',
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  exportedItemId = body.state?.items[0]?.id ?? '';
  return new Response(new Blob(['mov']), { status: 200 });
}) as typeof fetch;

const previousDocument = globalThis.document;
const downloads: string[] = [];
globalThis.document = {
  createElement: () => ({
    href: '',
    download: '',
    click() { downloads.push(this.download); },
    remove() {},
  }),
  body: { appendChild() {} },
} as unknown as Document;

try {
  const frameResult = await execFramesTool('view_timeline_frames', {
    frames: [10], timelineId: target.id,
  }, ctx) as { frames: number[]; renderedBy: string };
  assert.deepEqual(frameResult.frames, [10]);
  assert.equal(frameResult.renderedBy, 'test');
  assert.equal(renderedTimelineId, target.id);

  const proresResult = await execMgVideoTool('export_motion_graphic_prores', {
    itemId: 'target_clip', timelineId: target.id,
  }, ctx) as { ok: boolean; timeline: { id: string }; exported: string[] };
  assert.equal(proresResult.ok, true);
  assert.equal(proresResult.timeline.id, target.id);
  assert.equal(exportedItemId, 'target_clip');
  assert.deepEqual(downloads, ['Target clip.mov']);
} finally {
  globalThis.fetch = originalFetch;
  globalThis.document = previousDocument;
}

assert.equal(draft.getDoc().activeTimelineId, current.id);
assert.deepEqual(draft.getDoc().timelines[0], currentBefore);

for (const schema of [
  MARKERS_TOOL_SCHEMAS.find((tool) => tool.name === 'manage_markers'),
  FRAMES_TOOL_SCHEMAS.find((tool) => tool.name === 'view_timeline_frames'),
  MG_VIDEO_TOOL_SCHEMAS.find((tool) => tool.name === 'export_motion_graphic_prores'),
]) {
  assert(schema && 'timelineId' in (schema.input_schema.properties ?? {}));
}

console.log('timeline target tools check passed');

