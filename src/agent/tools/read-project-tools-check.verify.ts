// Runnable: `npx tsx src/agent/read-project-tools.check.ts`
import assert from 'node:assert';
import { makeDraft } from '../../editor/store';
import { docFromTimeline } from '../../persist/projectStore';
import type { AgentContext } from '../context';
import { execReadProjectTool, READ_PROJECT_TOOL_NAMES } from './read-project-tools';

assert.ok(READ_PROJECT_TOOL_NAMES.has('read_project'));

const base = docFromTimeline({
  fps: 30,
  width: 1920,
  height: 1080,
  items: [{
    id: 'clip1',
    track: 'track_v1',
    startFrame: 0,
    durationInFrames: 90,
    name: 'A',
    kind: 'video',
    src: '/media/uploads/a.mp4',
  }],
  selectedId: null,
  assets: [],
  trackOrder: ['track_v1'],
  tracks: { track_v1: { kind: 'video' } },
  markers: [{
    id: 'm1', scope: 'project', fromFrame: 10, durationFrames: 0, note: 'hit', color: 'red',
  }],
});
base.assets.push({
  id: 'asset1', name: 'photo.png', kind: 'image', src: '/media/uploads/p.png', durationInFrames: 90,
});
const draft = makeDraft(base);
const ctx: AgentContext = {
  commands: draft.commands,
  getState: draft.getState,
  getDoc: draft.getDoc,
  getCreativeMode: () => null,
  templates: [],
  audio: [],
  getProjectId: () => 'p1',
};

const full = await execReadProjectTool('read_project', {}, ctx) as {
  ok: boolean;
  timeline: { items: unknown[]; markers: unknown[]; selectedIds: unknown[]; selectedId: string | null };
  mediaPool: { assets: unknown[] };
  projectId: string;
};
assert.strictEqual(full.ok, true);
assert.strictEqual(full.projectId, 'p1');
assert.strictEqual(full.timeline.items.length, 1);
assert.deepEqual(full.timeline.selectedIds, []);
assert.equal(full.timeline.selectedId, null);
assert.strictEqual(full.timeline.markers.length, 1);
assert.strictEqual(full.mediaPool.assets.length, 1);

const assetsOnly = await execReadProjectTool('read_project', { view: 'assets' }, ctx) as {
  timeline?: unknown;
  mediaPool: { assets: unknown[] };
};
assert.strictEqual(assetsOnly.timeline, undefined);
assert.strictEqual(assetsOnly.mediaPool.assets.length, 1);

const filtered = await execReadProjectTool('read_project', {
  view: 'timeline', fromFrame: 100, toFrame: 200,
}, ctx) as { timeline: { items: unknown[] } };
assert.strictEqual(filtered.timeline.items.length, 0);

const projectionDoc = docFromTimeline({
  fps: 30, width: 1920, height: 1080, selectedId: null,
  trackOrder: ['V1'], tracks: { V1: { kind: 'video' } },
  items: [
    { id: 'linked', track: 'V1', startFrame: 0, durationInFrames: 30, srcInFrame: 5, playbackRate: 2, name: 'linked', kind: 'video', src: '/media/a.mp4', sourceAssetId: 'asset-a', volume: 0.5, fadeInFrames: 3, fadeOutFrames: 4, transform: { scale: 1.2 }, filters: { blur: 2 }, keyframes: { opacity: [{ frame: 0, value: 1, easing: 'easeIn' }] } },
    { id: 'missing', track: 'V1', startFrame: 30, durationInFrames: 30, name: 'missing', kind: 'video', src: '/media/missing.mp4', sourceAssetId: 'gone' },
    { id: 'ambiguous', track: 'V1', startFrame: 60, durationInFrames: 30, name: 'ambiguous', kind: 'video', src: '/media/dup.mp4' },
    { id: 'legacy', track: 'V1', startFrame: 90, durationInFrames: 30, name: 'legacy', kind: 'video', src: '/media/legacy.mp4' },
  ],
});
projectionDoc.assets.push(
  { id: 'asset-a', name: 'a', kind: 'video', src: '/media/a.mp4', durationInFrames: 30 },
  { id: 'dup-a', name: 'one', kind: 'video', src: '/media/dup.mp4', durationInFrames: 30 },
  { id: 'dup-b', name: 'two', kind: 'video', src: '/media/dup.mp4', durationInFrames: 30 },
  { id: 'asset-legacy', name: 'legacy', kind: 'video', src: '/media/legacy.mp4', durationInFrames: 30 },
);
const projectionDraft = makeDraft(projectionDoc);
const projectionCtx = { ...ctx, commands: projectionDraft.commands, getState: projectionDraft.getState, getDoc: projectionDraft.getDoc };
const projection = await execReadProjectTool('read_project', { view: 'timeline' }, projectionCtx) as { timeline: { items: Array<Record<string, unknown>> } };
const byId = (id: string) => projection.timeline.items.find((item) => item.id === id)!;
assert.deepEqual(
  { sourceAssetId: byId('linked').sourceAssetId, resolvedSourceAssetId: byId('linked').resolvedSourceAssetId, linkStatus: byId('linked').linkStatus },
  { sourceAssetId: 'asset-a', resolvedSourceAssetId: 'asset-a', linkStatus: 'linked' },
  'read_project reports explicit and resolved pool linkage',
);
assert.equal(byId('missing').linkStatus, 'missing', 'read_project exposes missing pool links');
assert.equal(byId('ambiguous').linkStatus, 'ambiguous', 'read_project exposes ambiguous legacy src matches');
assert.deepEqual(
  { sourceAssetId: byId('legacy').sourceAssetId, resolvedSourceAssetId: byId('legacy').resolvedSourceAssetId, linkStatus: byId('legacy').linkStatus },
  { sourceAssetId: null, resolvedSourceAssetId: 'asset-legacy', linkStatus: 'linked' },
  'read_project distinguishes explicit identity from a unique legacy source match',
);
assert.deepEqual(byId('linked').keyframes, { opacity: [{ frame: 0, value: 1, easing: 'easeIn' }] }, 'read_project includes keyframes');
assert.deepEqual(byId('linked').transform, { scale: 1.2 }, 'read_project includes transforms');
assert.deepEqual(byId('linked').filters, { blur: 2 }, 'read_project includes filters');
assert.equal(byId('linked').volume, 0.5, 'read_project includes volume');
assert.equal(byId('linked').fadeInFrames, 3, 'read_project includes fades');
assert.deepEqual(
  {
    sourceStartFrame: byId('linked').sourceStartFrame,
    sourceDurationInFrames: byId('linked').sourceDurationInFrames,
    sourceEndFrameExclusive: byId('linked').sourceEndFrameExclusive,
  },
  { sourceStartFrame: 5, sourceDurationInFrames: 60, sourceEndFrameExclusive: 65 },
  'read_project exposes the exact source window',
);

const selectedDoc = docFromTimeline({
  fps: 30, width: 1920, height: 1080, selectedId: 'clip1', selectedIds: ['clip1'],
  trackOrder: ['track_v1'], tracks: { track_v1: { kind: 'video' } },
  items: [{
    id: 'clip1', track: 'track_v1', startFrame: 0, durationInFrames: 90, name: 'A', kind: 'video', src: '/media/uploads/a.mp4',
  }],
});
const selectedDraft = makeDraft(selectedDoc);
const selectedCtx: AgentContext = {
  commands: selectedDraft.commands,
  getState: selectedDraft.getState,
  getDoc: selectedDraft.getDoc,
  getCreativeMode: () => null,
  templates: [],
  audio: [],
  getProjectId: () => 'p1',
};
const selectedFull = await execReadProjectTool('read_project', { view: 'timeline' }, selectedCtx) as {
  timeline: { selectedId: string | null; selectedIds: string[]; selected: { id: string; track: string }[]; items: { selected?: boolean }[] };
};
assert.strictEqual(selectedFull.timeline.selectedId, 'clip1');
assert.deepEqual(selectedFull.timeline.selectedIds, ['clip1']);
assert.strictEqual(selectedFull.timeline.selected[0]?.track, 'V1');
assert.strictEqual(selectedFull.timeline.items[0]?.selected, true);

console.log('read-project-tools.check: ok');
