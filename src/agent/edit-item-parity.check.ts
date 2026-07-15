// Parity check for edit_item's generic (unified) item ops. Imports the PURE
// edit-item-generic module (no GL .frag chain) so it runs under tsx. Verifies validation
// + that commit delegates to the right editor commands, and the atomic-abort contract via
// the same validators execEditItemTool batches. Run: tsx src/agent/edit-item-parity.check.ts
import assert from 'node:assert';
import type { TimelineState } from '../editor/types';
import {
  GENERIC_ITEM_KINDS, validateGenericUpdate, validateGenericDelete, applyGeneric, type GenericCommands,
} from './edit-item-generic';

// GENERIC_ITEM_KINDS covers the source edit_item item types (minus effect/transition adds)
for (const k of ['video', 'image', 'audio', 'gif', 'svg', 'motion-graphic', 'text', 'solid']) {
  assert.ok(GENERIC_ITEM_KINDS.has(k), `GENERIC_ITEM_KINDS missing ${k}`);
}
assert.ok(!GENERIC_ITEM_KINDS.has('effect') && !GENERIC_ITEM_KINDS.has('transition'), 'effect/transition are library adds, not generic');

const state = {
  items: [{ id: 'v1_abc', kind: 'video', track: 'V1', startFrame: 0, durationInFrames: 90, name: 'clip', src: '/media/x.mp4', volume: 1 }],
  fps: 30, trackOrder: ['V2', 'V1', 'A1', 'A2'], tracks: {}, width: 1920, height: 1080, selectedId: null,
} as unknown as TimelineState;

function recorder() {
  const calls: Array<[string, ...unknown[]]> = [];
  const rec = (name: string) => (...a: unknown[]) => { calls.push([name, ...a]); };
  const commands: GenericCommands = {
    moveItem: rec('moveItem'), setItemTiming: rec('setItemTiming'), updateItemProps: rec('updateItemProps'),
    setItemVolume: rec('setItemVolume'), setItemFade: rec('setItemFade'), removeItem: rec('removeItem'), rippleDeleteItem: rec('rippleDeleteItem'),
  };
  return { calls, commands };
}

// ── generic update: move + trim + volume + fade → right commands, correct conversions ──
{
  const plan = validateGenericUpdate(state, { type: 'video', itemId: 'v1_', track: 'V1', startFrame: 30, durationInFrames: 60, volume: 0.5, fadeInSeconds: 1 });
  assert.equal(plan.error, undefined, 'update validates');
  assert.equal(plan.itemId, 'v1_abc', 'resolves item by prefix');
  const { calls, commands } = recorder();
  applyGeneric(plan, commands);
  assert.deepEqual(calls.map((c) => c[0]).sort(), ['moveItem', 'setItemFade', 'setItemTiming', 'setItemVolume'], 'delegates move/timing/volume/fade');
  assert.deepEqual(calls.find((c) => c[0] === 'moveItem')![2], { track: 'V1', startFrame: 30 }, 'move gets track+startFrame');
  assert.deepEqual(calls.find((c) => c[0] === 'setItemTiming')![2], { durationInFrames: 60, srcInFrame: undefined }, 'timing gets duration (not startFrame — no double-apply)');
  assert.deepEqual(calls.find((c) => c[0] === 'setItemFade')![2], { fadeInFrames: 30, fadeOutFrames: undefined }, 'fade 1s→30f @30fps');
}

// ── clamps: volume >2 clamps to 2; negative duration floors to 1 ──
{
  const plan = validateGenericUpdate(state, { type: 'video', itemId: 'v1_abc', volume: 5, durationInFrames: -10 });
  assert.equal(plan.volume, 2, 'volume clamps to 2');
  assert.equal(plan.durationInFrames, 1, 'duration floors to 1');
}

// ── no fields → error ──
assert.ok(validateGenericUpdate(state, { type: 'video', itemId: 'v1_abc' }).error, 'empty update errors');
// ── unknown item → error ──
assert.ok(validateGenericUpdate(state, { type: 'video', itemId: 'nope' }).error, 'missing item errors');
// ── invalid track → error ──
assert.ok(validateGenericUpdate(state, { type: 'video', itemId: 'v1_abc', track: 'A9' }).error, 'bad track errors');

// ── generic delete: default vs ripple ──
{
  const plan = validateGenericDelete(state, { type: 'video', itemId: 'v1_abc' });
  const { calls, commands } = recorder();
  applyGeneric(plan, commands);
  assert.deepEqual(calls.map((c) => c[0]), ['removeItem'], 'default delete → removeItem');
}
{
  const plan = validateGenericDelete(state, { type: 'video', itemId: 'v1_abc', ripple: true });
  const { calls, commands } = recorder();
  applyGeneric(plan, commands);
  assert.deepEqual(calls.map((c) => c[0]), ['rippleDeleteItem'], 'ripple delete → rippleDeleteItem');
}
assert.ok(validateGenericDelete(state, { type: 'video', itemId: 'gone' }).error, 'delete missing item errors');

// ── applyGeneric returns null for a non-generic plan (caller falls through) ──
assert.equal(applyGeneric({ plan: 'addTransition' }, recorder().commands), null, 'non-generic plan → null');

console.log('edit-item-parity.check.ts OK');
