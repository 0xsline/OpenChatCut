// Runnable check for ripple insert/delete (gap-closing) math:
//   npx tsx src/editor/ripple.check.ts
import assert from 'node:assert';
import { reduce } from './reduce';
import type { TimelineItem, TimelineState } from './types';

const clip = (id: string, startFrame: number, durationInFrames: number, track: TimelineItem['track'] = 'V1'): TimelineItem =>
  ({ id, track, startFrame, durationInFrames, kind: 'text', name: id });

const base: TimelineState = {
  fps: 30, width: 1920, height: 1080, selectedId: null,
  items: [clip('a', 0, 30), clip('b', 30, 30), clip('c', 60, 30)],
};
const at = (s: TimelineState, id: string) => s.items.find((i) => i.id === id);

// ── ripple delete: remove b (30..60) → c closes the gap to 30..60, a untouched
const del = reduce(base, { type: 'remove', id: 'b', ripple: true });
assert.strictEqual(at(del, 'b'), undefined, 'b removed');
assert.strictEqual(at(del, 'a')!.startFrame, 0, 'a stays');
assert.strictEqual(at(del, 'c')!.startFrame, 30, 'c shifted left by b.duration (gap closed)');

// plain delete leaves the gap
const plain = reduce(base, { type: 'remove', id: 'b' });
assert.strictEqual(at(plain, 'c')!.startFrame, 60, 'plain delete: c not moved');

// only same-track clips ripple
const cross: TimelineState = { ...base, items: [...base.items, clip('x', 60, 30, 'V2')] };
const delX = reduce(cross, { type: 'remove', id: 'b', ripple: true });
assert.strictEqual(at(delX, 'x')!.startFrame, 60, 'other-track clip unaffected');

// ── ripple insert: add a 20f clip at frame 30 → b,c pushed right by 20
const ins = reduce(base, { type: 'add', ripple: true, startFrame: 30, item: clip('n', 0, 20) as Omit<TimelineItem, 'startFrame'> });
assert.strictEqual(at(ins, 'n')!.startFrame, 30, 'new clip at insertion point');
assert.strictEqual(at(ins, 'b')!.startFrame, 50, 'b pushed right by new duration');
assert.strictEqual(at(ins, 'c')!.startFrame, 80, 'c pushed right by new duration');
assert.strictEqual(at(ins, 'a')!.startFrame, 0, 'a before insertion point unmoved');

// plain add overwrites/overlaps (no shift)
const insPlain = reduce(base, { type: 'add', startFrame: 30, item: clip('n', 0, 20) as Omit<TimelineItem, 'startFrame'> });
assert.strictEqual(at(insPlain, 'b')!.startFrame, 30, 'plain add: b not moved');

console.log('ripple.check: OK');
