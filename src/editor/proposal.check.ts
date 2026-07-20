// Runnable check for the propose→apply engine (project-level draft):
// `npx tsx src/editor/proposal.check.ts`.
import assert from 'node:assert';
import { makeDraft, replayActions, projectReduce } from './store';
import { historyReduce } from './reduce';
import { activeTimeline, type ProjectDoc, type Timeline } from './types';
import { buildOperation, buildProposal, isProposalStale, partitionProposalActions } from '../agent/proposal';
import { resolveAgentReferences, type AgentContext } from '../agent/context';

const tl = (id: string, name: string, order: number): Timeline =>
  ({ fps: 30, width: 1920, height: 1080, items: [], selectedId: null, id, name, order });

const base: ProjectDoc = { version: 2, assets: [], mediaFolders: [], timelines: [tl('tl_a', '序列 1', 0)], activeTimelineId: 'tl_a' };

// the draft records actions + applies to a scratch copy WITHOUT touching base
const d = makeDraft(base);
d.commands.addTextClip();
d.commands.addTextClip();
const acts = d.takeActions();
assert.strictEqual(acts.length, 2, 'two add actions recorded');
assert.strictEqual(d.getState().items.length, 2, 'draft active timeline has 2 items');
assert.strictEqual(activeTimeline(base).items.length, 0, 'base project untouched during proposal');

// replaying the recorded actions on base reproduces the draft result (atomic apply)
const applied = replayActions(base, acts);
assert.strictEqual(activeTimeline(applied).items.length, 2, 'replay applies both ops');
assert.deepStrictEqual(
  activeTimeline(applied).items.map((i) => i.id),
  d.getState().items.map((i) => i.id),
  'replay yields the same item ids as the draft',
);

// per-op deselect: replay only the first operation's actions
const subset = replayActions(base, acts.slice(0, 1));
assert.strictEqual(activeTimeline(subset).items.length, 1, 'subset apply commits only selected ops');

// Generated assets survive proposal rejection, while timeline placement remains
// reviewable. The two action classes must never be committed as one draft op.
const generatedAsset = { id: 'asset_generated', name: 'Generated', kind: 'image' as const, src: '/generated.png', durationInFrames: 90 };
const partitioned = partitionProposalActions([{ type: 'addAsset', asset: generatedAsset }, acts[0]]);
assert.deepStrictEqual(partitioned.persistent.map((action) => action.type), ['addAsset']);
assert.deepStrictEqual(partitioned.proposed.map((action) => action.type), ['add']);
const assetCommitted = replayActions(base, partitioned.persistent);
assert.strictEqual(assetCommitted.assets[0], generatedAsset, 'generated asset is committed independently');
assert.strictEqual(activeTimeline(assetCommitted).items.length, 0, 'timeline stays unchanged until proposal apply');

// @ references are resolved by stable id into compact structured context; the
// display name alone is never trusted as the lookup key.
const referenceCtx: AgentContext = {
  commands: d.commands,
  getState: () => activeTimeline(assetCommitted),
  getDoc: () => assetCommitted,
  getCreativeMode: () => null,
  templates: [{ id: 'tpl_1', name: 'Chart', category: 'data', width: 1920, height: 1080, fps: 30, durationInFrames: 90, props: {}, propSchema: [], thumb: null, code: '' }],
  audio: [],
};
const contextEntries = resolveAgentReferences(referenceCtx, [
  { id: generatedAsset.id, name: 'wrong display name', kind: 'image' },
  { id: 'tpl_1', name: 'wrong display name', kind: 'template' },
  { id: generatedAsset.id, name: generatedAsset.name, kind: 'image' },
]);
assert.deepStrictEqual(contextEntries.map((entry) => [entry.type, entry.id, entry.name]), [
  ['asset', generatedAsset.id, generatedAsset.name],
  ['template', 'tpl_1', 'Chart'],
]);

// proposals are valid only against the exact immutable project snapshot used
// to build them; any manual edit while the proposal is pending makes it stale.
const proposal = buildProposal([buildOperation('add_text', {}, acts)], 'add text', base, d.getState());
assert.strictEqual(isProposalStale(proposal, base), false, 'original snapshot remains applicable');
assert.strictEqual(isProposalStale(proposal, applied), true, 'a changed project invalidates the proposal');
// After IDB rehydrate, baseDoc is a deep clone (new reference, same content).
const rehydrated = { ...proposal, baseDoc: JSON.parse(JSON.stringify(base)) as typeof base };
assert.strictEqual(isProposalStale(rehydrated, base), false, 'structurally equal clone is still applicable');

// attaching a transcript is an editing operation and therefore gets its own
// undo snapshot (previously it silently bypassed history).
const transcriptItemId = activeTimeline(applied).items[0].id;
const withTranscript = historyReduce(
  { past: [], present: applied, future: [] },
  { type: 'setItemTranscript', id: transcriptItemId, words: [{ text: 'hello', start: 0, end: 500 }] },
);
assert.strictEqual(withTranscript.past.length, 1, 'transcript attachment creates an undo step');
const transcriptUndone = historyReduce(withTranscript, { type: 'undo' });
assert.strictEqual(activeTimeline(transcriptUndone.present).items[0].transcript, undefined, 'undo removes the attached transcript');

// Snapshot history is intentionally bounded so long editing sessions do not
// retain an unlimited number of whole ProjectDoc graphs.
let boundedHistory = { past: [] as ProjectDoc[], present: base, future: [] as ProjectDoc[] };
for (let i = 0; i < 110; i++) boundedHistory = historyReduce(boundedHistory, { type: 'tl.rename', id: 'tl_a', name: `序列 ${i}` });
assert.strictEqual(boundedHistory.past.length, 100, 'history retains only the newest 100 snapshots');

// ── manage_timelines through the draft: create → switch routing → replay ──
const d2 = makeDraft(applied);
const newId = d2.commands.createTimeline({ name: '竖屏', width: 1080, height: 1920 }); // activates it
d2.commands.addTextClip(); // must land in the NEW active timeline
const acts2 = d2.takeActions();
assert.strictEqual(d2.getDoc().timelines.length, 2, 'draft has 2 timelines');
assert.strictEqual(d2.getDoc().activeTimelineId, newId, 'create activates the new timeline');
assert.strictEqual(d2.getState().items.length, 1, 'clip landed in the new timeline');
assert.strictEqual(applied.timelines.length, 1, 'base project untouched by timeline ops');

const applied2 = replayActions(applied, acts2);
assert.strictEqual(applied2.timelines.length, 2, 'replay recreates the timeline');
assert.strictEqual(activeTimeline(applied2).items.length, 1, 'replay routes the clip to the new timeline');
assert.strictEqual(activeTimeline(applied2).width, 1080, 'new timeline keeps its 9:16 canvas');
assert.strictEqual(applied2.timelines[0].items.length, 2, 'original timeline untouched by the second proposal');

// switch back is recorded and replayable (navigation composes into the apply)
const d3 = makeDraft(applied2);
d3.commands.switchTimeline('tl_a');
d3.commands.addTextClip();
const applied3 = replayActions(applied2, d3.takeActions());
assert.strictEqual(applied3.activeTimelineId, 'tl_a', 'switch replays');
assert.strictEqual(applied3.timelines[0].items.length, 3, 'clip followed the switch to 序列 1');

// tl.setDoc is the atomic one-step commit target
assert.strictEqual(projectReduce(base, { type: 'tl.setDoc', doc: applied2 }), applied2, 'tl.setDoc commits the whole project');

// last-visible guard: the only visible timeline can't be hidden
const guarded = projectReduce(base, { type: 'tl.setHidden', id: 'tl_a', hidden: true });
assert.strictEqual(guarded, base, 'cannot hide the last visible timeline');

console.log('proposal.check OK');
