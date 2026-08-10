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
  timeline: { items: unknown[]; markers: unknown[] };
  mediaPool: { assets: unknown[] };
  projectId: string;
};
assert.strictEqual(full.ok, true);
assert.strictEqual(full.projectId, 'p1');
assert.strictEqual(full.timeline.items.length, 1);
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

console.log('read-project-tools.check: ok');
