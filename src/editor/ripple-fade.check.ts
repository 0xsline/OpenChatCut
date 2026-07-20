// Runnable check: `npx tsx src/editor/ripple-fade.check.ts`.
// Locks the reducer behaviour now exposed to the agent (add_motion_graphic/add_audio
// ripple, remove_item ripple, set_item_timing fade): ripple insert makes room,
// Ripple delete closes the gap, and fades clamp to clip length.
import assert from 'node:assert';
import { reduce } from './reduce';
import type { TimelineItem, TimelineState } from './types';

const clip = (id: string, startFrame: number, durationInFrames = 90): TimelineItem => ({
  id, track: 'V1' as TimelineItem['track'], startFrame, durationInFrames, name: id, kind: 'video', src: `/x/${id}.mp4`,
});

const base: TimelineState = {
  fps: 30, width: 1920, height: 1080, selectedId: null,
  items: [clip('A', 0), clip('B', 90)],
};

// ripple insert: adding a 30f clip at frame 0 pushes same-track clips at/after 0 right by 30.
{
  const { id: _omit, ...itemNoStart } = clip('C', 0, 30);
  const next = reduce(base, { type: 'add', ripple: true, startFrame: 0, item: { ...itemNoStart, id: 'C' } });
  const by = Object.fromEntries(next.items.map((it) => [it.id, it.startFrame]));
  assert.equal(by.A, 30, 'ripple insert pushes A right by new clip length');
  assert.equal(by.B, 120, 'ripple insert pushes B right by new clip length');
  assert.equal(by.C, 0, 'inserted clip lands at requested frame');
}

// non-ripple insert: no shift (overwrite/overlap allowed).
{
  const { id: _omit, ...itemNoStart } = clip('C', 0, 30);
  const next = reduce(base, { type: 'add', startFrame: 0, item: { ...itemNoStart, id: 'C' } });
  const by = Object.fromEntries(next.items.map((it) => [it.id, it.startFrame]));
  assert.equal(by.A, 0, 'plain insert leaves A put');
  assert.equal(by.B, 90, 'plain insert leaves B put');
}

// ripple delete: removing A closes the gap — B shifts left by A's length.
{
  const next = reduce(base, { type: 'remove', id: 'A', ripple: true });
  assert.equal(next.items.length, 1);
  assert.equal(next.items[0].id, 'B');
  assert.equal(next.items[0].startFrame, 0, 'ripple delete shifts B left into the gap');
}

// plain delete: gap stays.
{
  const next = reduce(base, { type: 'remove', id: 'A' });
  assert.equal(next.items[0].startFrame, 90, 'plain delete leaves the gap');
}

// fade clamps to clip length (B is 90f); over-long fade is capped, other side untouched.
{
  const next = reduce(base, { type: 'setFade', id: 'B', fadeInFrames: 1000 });
  const b = next.items.find((it) => it.id === 'B')!;
  assert.equal(b.fadeInFrames, 90, 'fade-in clamped to clip length');
  assert.equal(b.fadeOutFrames, undefined, 'fade-out untouched');
}

// eslint-disable-next-line no-console
console.log('ripple-fade.check: ok');
