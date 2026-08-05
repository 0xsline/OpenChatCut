import assert from 'node:assert/strict';
import { makeDraft } from '../../editor/store';
import type { ProjectDoc, TimelineItem } from '../../editor/types';
import { docFromTimeline } from '../../persist/projectStore';
import { listVersions, saveVersion } from '../../persist/versionStore';
import type { AgentContext } from '../context';
import { execVersionTool } from './version-tools';

const projectId = `agent-version-verify-${Date.now().toString(36)}`;

const clip = (id: string, start: number): TimelineItem => ({
  id,
  kind: 'video',
  track: 'V1',
  startFrame: start,
  durationInFrames: 30,
  name: id,
  src: `/media/uploads/${id}.mp4`,
});

const base = docFromTimeline({
  fps: 30,
  width: 1920,
  height: 1080,
  selectedId: null,
  assets: [],
  items: [clip('v1', 0)],
  trackOrder: ['V1'],
  tracks: { V1: { kind: 'video' } },
});

const draft = makeDraft(base);
const ctx: AgentContext = {
  commands: draft.commands,
  getState: draft.getState,
  getDoc: draft.getDoc,
  getCreativeMode: () => null,
  templates: [],
  audio: [],
  getProjectId: () => projectId,
};

const noProject = await execVersionTool(
  'manage_versions',
  { action: 'list' },
  { ...ctx, getProjectId: undefined },
) as { error?: string };
assert.match(noProject.error ?? '', /project id/i);

const empty = await execVersionTool('manage_versions', { action: 'list' }, ctx) as {
  ok?: boolean;
  count?: number;
};
assert.equal(empty.ok, true);
assert.equal(empty.count, 0);

const saved = await execVersionTool(
  'manage_versions',
  { action: 'save', name: '粗剪完成' },
  ctx,
) as { ok?: boolean; saved?: { id: string; name: string } };
assert.equal(saved.ok, true, JSON.stringify(saved));
assert.equal(saved.saved?.name, '粗剪完成');
assert.ok(saved.saved?.id);

// Mutate project after checkpoint.
draft.commands.addMediaItem({
  id: 'asset_extra',
  name: 'extra.mp4',
  kind: 'video',
  src: '/media/uploads/extra.mp4',
  durationInFrames: 30,
});
// Place a second clip via setFullState-like path: add asset then edit via applyDoc is heavy;
// just apply a larger doc snapshot for the "current" state.
const evolved: ProjectDoc = {
  ...draft.getDoc(),
  timelines: draft.getDoc().timelines.map((tl, i) => (
    i === 0
      ? { ...tl, items: [clip('v1', 0), clip('v2', 40)] }
      : tl
  )),
};
draft.commands.applyDoc(evolved);
assert.equal(draft.getState().items.length, 2);

const listed = await execVersionTool('manage_versions', { action: 'list' }, ctx) as {
  ok?: boolean;
  versions?: Array<{ id: string; name: string }>;
};
assert.equal(listed.versions?.length, 1);
const versionId = listed.versions![0]!.id;

const needs = await execVersionTool(
  'manage_versions',
  { action: 'restore', versionId },
  ctx,
) as { needsConfirm?: boolean };
assert.equal(needs.needsConfirm, true);
assert.equal(draft.getState().items.length, 2, 'confirm false must not restore');

const restored = await execVersionTool(
  'manage_versions',
  { action: 'restore', versionId, confirm: true },
  ctx,
) as { ok?: boolean };
assert.equal(restored.ok, true, JSON.stringify(restored));
assert.equal(draft.getState().items.length, 1);
assert.equal(draft.getState().items[0]?.id, 'v1');

const deleted = await execVersionTool(
  'manage_versions',
  { action: 'delete', versionId },
  ctx,
) as { ok?: boolean };
assert.equal(deleted.ok, true);
assert.equal((await listVersions(projectId)).length, 0);

// Direct store path still works for seed compatibility.
await saveVersion(projectId, 'manual-seed', draft.getDoc());
assert.equal((await listVersions(projectId)).length, 1);

console.log('version-tools.verify: ok');
