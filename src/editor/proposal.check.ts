// Runnable check for the propose→apply engine (project-level draft):
// `npx tsx src/editor/proposal.check.ts`.
import assert from 'node:assert';
import { makeDraft, replayActions, projectReduce } from './store';
import { activeTimeline, type ProjectDoc, type Timeline } from './types';

const tl = (id: string, name: string, order: number): Timeline =>
  ({ fps: 30, width: 1920, height: 1080, items: [], selectedId: null, id, name, order });

const base: ProjectDoc = { timelines: [tl('tl_a', '序列 1', 0)], activeTimelineId: 'tl_a' };

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
