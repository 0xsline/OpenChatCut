// Runnable check for the propose→apply engine: `npx tsx src/editor/proposal.check.ts`.
import assert from 'node:assert';
import { makeDraft, replayActions, reduce } from './store';
import type { TimelineState } from './types';

const base: TimelineState = { fps: 30, width: 1920, height: 1080, items: [], selectedId: null };

// the draft records actions + applies to a scratch copy WITHOUT touching base
const d = makeDraft(base);
d.commands.addTextClip();
d.commands.addTextClip();
const acts = d.takeActions();
assert.strictEqual(acts.length, 2, 'two add actions recorded');
assert.strictEqual(d.getState().items.length, 2, 'draft has 2 items');
assert.strictEqual(base.items.length, 0, 'base timeline untouched during proposal');

// replaying the recorded actions on base reproduces the draft result (atomic apply)
const applied = replayActions(base, acts);
assert.strictEqual(applied.items.length, 2, 'replay applies both ops');
assert.deepStrictEqual(applied.items.map((i) => i.id), d.getState().items.map((i) => i.id), 'replay yields the same item ids as the draft');

// per-op deselect: replay only the first operation's actions
const subset = replayActions(base, acts.slice(0, 1));
assert.strictEqual(subset.items.length, 1, 'subset apply commits only selected ops');

// setFullState is the atomic one-step commit target
assert.strictEqual(reduce(base, { type: 'setFullState', state: applied }), applied, 'setFullState commits the whole state');

console.log('proposal.check OK');
