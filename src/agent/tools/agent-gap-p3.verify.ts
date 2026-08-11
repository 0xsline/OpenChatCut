import assert from 'node:assert/strict';
import { makeDraft } from '../../editor/store';
import type { TimelineItem } from '../../editor/types';
import { docFromTimeline } from '../../persist/projectStore';
import type { AgentContext } from '../context';
import { execCaptionsTool } from './captions-tools';
import { execTrackTool } from './track-tools';
import { execTranscriptTool } from './transcript-tools';
import { applyGeneric, validateGenericUpdate, validateMediaSourceUpdate } from './edit-item-generic';

const words = [
  { text: 'one', start: 0, end: 200, speaker: 'A' },
  { text: 'two', start: 300, end: 500, speaker: 'A' },
  { text: 'three', start: 600, end: 900, speaker: 'A' },
];

const a1: TimelineItem = {
  id: 'clip_a',
  kind: 'audio',
  track: 'A1',
  startFrame: 0,
  durationInFrames: 60,
  name: 'a',
  src: '/media/uploads/a.wav',
  transcript: words,
};
const v1: TimelineItem = {
  id: 'clip_v1',
  kind: 'video',
  track: 'V1',
  startFrame: 0,
  durationInFrames: 30,
  name: 'v1',
  src: '/media/uploads/v1.mp4',
  keyframes: { opacity: [{ frame: 0, value: 1 }, { frame: 15, value: 0 }] },
};
const v2: TimelineItem = {
  id: 'clip_v2',
  kind: 'video',
  track: 'V1',
  startFrame: 40,
  durationInFrames: 30,
  name: 'v2',
  src: '/media/uploads/v2.mp4',
};

const draft = makeDraft(docFromTimeline({
  fps: 30,
  width: 1920,
  height: 1080,
  selectedId: null,
  assets: [],
  items: [a1, v1, v2],
  trackOrder: ['V1', 'A1'],
  tracks: { V1: { kind: 'video' }, A1: { kind: 'audio' } },
  captions: { enabled: true, template: 'plain', pacing: 'phrase' },
}));

const ctx: AgentContext = {
  commands: draft.commands,
  getState: draft.getState,
  getDoc: draft.getDoc,
  getCreativeMode: () => null,
  templates: [],
  audio: [],
};

// captions hide/show overlay
const hidden = await execCaptionsTool('edit_captions', { action: 'hide_overlay' }, ctx) as {
  ok?: boolean;
  captionsHidden?: boolean;
};
assert.equal(hidden.ok, true, JSON.stringify(hidden));
assert.equal(hidden.captionsHidden, true);
assert.equal(draft.getState().captionsHidden, true);
const shown = await execCaptionsTool('edit_captions', { action: 'show_overlay' }, ctx) as { ok?: boolean };
assert.equal(shown.ok, true);
assert.equal(draft.getState().captionsHidden, false);

// track reorder_items (alias V1 resolves to the stable track id used by items)
const reordered = await execTrackTool(
  'edit_track',
  { action: 'reorder_items', trackId: 'V1', json: JSON.stringify({ itemIds: ['clip_v2', 'clip_v1'] }) },
  ctx,
) as { ok?: boolean; orderedIds?: string[] };
assert.equal(reordered.ok, true, JSON.stringify(reordered));
assert.deepEqual(reordered.orderedIds, ['clip_v2', 'clip_v1']);
const starts = Object.fromEntries(
  draft.getState().items.filter((i) => i.id === 'clip_v1' || i.id === 'clip_v2').map((i) => [i.id, i.startFrame]),
);
assert.ok(starts.clip_v2! < starts.clip_v1!, `v2 should pack first: ${JSON.stringify(starts)}`);

// transcript set_play_order
const play = await execTranscriptTool(
  'manage_transcript',
  { action: 'set_play_order', itemId: 'clip_a', playOrder: [2, 0, 1] },
  ctx,
) as { ok?: boolean; playOrder?: number[] };
assert.equal(play.ok, true, JSON.stringify(play));
assert.deepEqual(draft.getState().items.find((i) => i.id === 'clip_a')?.transcriptPlayOrder, [2, 0, 1]);
const cleared = await execTranscriptTool(
  'manage_transcript',
  { action: 'set_play_order', itemId: 'clip_a', clearPlayOrder: true },
  ctx,
) as { ok?: boolean };
assert.equal(cleared.ok, true);
assert.equal(draft.getState().items.find((i) => i.id === 'clip_a')?.transcriptPlayOrder, undefined);

// clear keyframes + relink media via generic commit surface
const clearPlan = validateGenericUpdate(draft.getState(), {
  type: 'video', itemId: 'clip_v1', clearKeyframes: true,
});
assert.equal(clearPlan.error, undefined, String(clearPlan.error));
applyGeneric(clearPlan, draft.commands);
assert.equal(draft.getState().items.find((i) => i.id === 'clip_v1')?.keyframes, undefined);

const relinkPlan = validateMediaSourceUpdate(draft.getState(), {
  operation: 'relink_media',
  itemId: 'clip_v1',
  src: '/media/uploads/v1-restored.mp4',
  name: 'v1-restored.mp4',
});
assert.equal(relinkPlan.plan, 'relinkMedia');
applyGeneric(relinkPlan, draft.commands);
const relinked = draft.getState().items.find((i) => i.id === 'clip_v1')!;
assert.equal(relinked.src, '/media/uploads/v1-restored.mp4');
assert.equal(relinked.name, 'v1-restored.mp4');
assert.equal(relinked.sourceAssetId, undefined);

const lockedRelinkDraft = makeDraft(docFromTimeline({
  fps: 30,
  width: 1920,
  height: 1080,
  selectedId: null,
  assets: [],
  items: [v1],
  trackOrder: ['V1'],
  tracks: { V1: { kind: 'video', locked: true } },
}));
const lockedRelinkPlan = validateMediaSourceUpdate(lockedRelinkDraft.getState(), {
  operation: 'relink_media',
  itemId: v1.id,
  src: '/media/uploads/locked-restored.mp4',
});
assert.equal(lockedRelinkPlan.plan, 'relinkMedia');
const lockedRelinkResult = applyGeneric(lockedRelinkPlan, lockedRelinkDraft.commands);
assert.equal(lockedRelinkResult?.ok, false, JSON.stringify(lockedRelinkResult));
assert.equal(lockedRelinkResult?.code, 'no-document-change');
assert.match(String(lockedRelinkResult?.error), /did not change/);
assert.equal(lockedRelinkDraft.getState().items[0]?.src, v1.src, 'locked-track Agent relink must not mutate');
assert.equal(lockedRelinkDraft.takeActions().length, 0, 'locked-track Agent relink must not settle an edit action');

console.log('agent-gap-p3.verify: ok');
