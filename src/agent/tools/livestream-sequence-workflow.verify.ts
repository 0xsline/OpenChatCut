import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { makeDraft } from '../../editor/store';
import { docFromTimeline } from '../../persist/projectStore';
import type { AgentContext } from '../context';
import { validateGenericAdd } from './edit-item-generic';
import { execTimelineTool } from './timeline-tools';

const source = {
  id: 'long-live',
  name: 'long-live.mp4',
  kind: 'video' as const,
  src: '/media/uploads/long-live.mp4',
  durationInFrames: 108_000,
  width: 1920,
  height: 1080,
};
const draft = makeDraft(docFromTimeline({
  fps: 30,
  width: 1920,
  height: 1080,
  items: [],
  selectedId: null,
  assets: [source],
}));
const ctx: AgentContext = {
  commands: draft.commands,
  getState: draft.getState,
  getDoc: draft.getDoc,
  getCreativeMode: () => null,
  templates: [],
  audio: [],
};

const created = await execTimelineTool('manage_timelines', {
  action: 'create',
  timelines: [
    { name: '01-产品痛点-30秒-9:16', ratio: '9:16' },
    { name: '02-功能演示-45秒-9:16', ratio: '9:16' },
  ],
}, ctx) as { ok?: boolean; created?: Array<{ id: string; name: string }> };
assert.equal(created.ok, true);
assert.equal(created.created?.length, 2);

const ranges = [
  { sourceStartFrame: 3_000, sourceDurationInFrames: 900 },
  { sourceStartFrame: 9_000, sourceDurationInFrames: 1_350 },
];
for (const [index, timeline] of created.created!.entries()) {
  const switched = await execTimelineTool('manage_timelines', {
    action: 'switch',
    timelineId: timeline.id,
  }, ctx) as { ok?: boolean };
  assert.equal(switched.ok, true);
  const added = validateGenericAdd(ctx.getState(), ctx.getDoc().assets, {
    type: 'video', assetId: source.id, track: 'V1', startFrame: 0, ...ranges[index],
  });
  assert.equal(added.ok, true);
  const itemId = draft.commands.addMediaItem(source, {
    track: String(added.track),
    startFrame: Number(added.startFrame ?? 0),
    srcInFrame: Number(added.srcInFrame),
  });
  draft.commands.setItemTiming(itemId, { durationInFrames: Number(added.durationInFrames) });
}

const doc = draft.getDoc();
assert.equal(doc.assets.length, 1, 'the long recording is referenced once, not copied per clip');
for (const [index, createdTimeline] of created.created!.entries()) {
  const timeline = doc.timelines.find((candidate) => candidate.id === createdTimeline.id)!;
  assert.equal(timeline.name, createdTimeline.name);
  assert.deepEqual({ width: timeline.width, height: timeline.height }, { width: 1080, height: 1920 });
  assert.equal(timeline.items.length, 1);
  assert.equal(timeline.items[0]?.sourceAssetId, source.id);
  assert.equal(timeline.items[0]?.srcInFrame, ranges[index]?.sourceStartFrame);
  assert.equal(timeline.items[0]?.durationInFrames, ranges[index]?.sourceDurationInFrames);
}

const [skill, exportSkill] = await Promise.all([
  readFile(new URL('../skills/livestream-to-clips/SKILL.md', import.meta.url), 'utf8'),
  readFile(new URL('../skills/export/SKILL.md', import.meta.url), 'utf8'),
]);
assert.match(skill, /automatically materialize every approved Sequence into My Media/);
assert.match(skill, /submit_render_job` with `saveToMediaPool:true/);
assert.match(skill, /draft Sequences only/);
assert.match(exportSkill, /active workflow explicitly defaults to automatic materialization/);

console.log('livestream multi-sequence workflow checks passed');
