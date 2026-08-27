// Contract verify for edit_item's generic item operations. Imports the pure
// edit-item-generic module (no GL .frag chain) so it runs under tsx. Verifies validation
// + that commit delegates to the right editor commands, and the atomic-abort contract via
// the same validators execEditItemTool batches. Run: tsx src/agent/tools/edit-item-generic.check.ts
import assert from 'node:assert';
import type { ClipTransform, MediaAsset, MediaRelinkResult, TimelineState } from '../../editor/types';
import {
  GENERIC_ITEM_KINDS, GENERIC_ADD_KINDS, validateGenericAdd, validateGenericUpdate, validateGenericDelete, applyGeneric,
  didYouMean, rejectUnknownFields, type GenericCommands,
} from './edit-item-generic';

// GENERIC_ITEM_KINDS covers edit_item types except effect/transition additions.
for (const k of ['video', 'image', 'audio', 'gif', 'svg', 'motion-graphic', 'text', 'solid']) {
  assert.ok(GENERIC_ITEM_KINDS.has(k), `GENERIC_ITEM_KINDS missing ${k}`);
}
assert.ok(!GENERIC_ITEM_KINDS.has('effect') && !GENERIC_ITEM_KINDS.has('transition'), 'effect/transition are library adds, not generic');

const state = {
  items: [{ id: 'v1_abc', kind: 'video', track: 'V1', startFrame: 0, durationInFrames: 90, name: 'clip', src: '/media/x.mp4', volume: 1 }],
  fps: 30, trackOrder: ['V2', 'V1', 'A1', 'A2'], tracks: {}, width: 1920, height: 1080, selectedId: null,
} as unknown as TimelineState;

function recorder(relinkResult: MediaRelinkResult = { ok: true, changed: true }) {
  const calls: Array<[string, ...unknown[]]> = [];
  const rec = (name: string) => (...a: unknown[]) => { calls.push([name, ...a]); };
  const commands: GenericCommands = {
    moveItem: rec('moveItem'), setItemTiming: rec('setItemTiming'),
    slipItem: (id, deltaInFrames) => {
      calls.push(['slipItem', id, deltaInFrames]);
      return {
        ok: true,
        itemId: id,
        requestedDeltaInFrames: deltaInFrames,
        appliedDeltaInFrames: deltaInFrames,
        srcInFrame: 0,
        sourceDomain: 'media',
        sourceWindow: { startFrame: 0, endFrame: 90 },
        minDeltaInFrames: deltaInFrames,
        maxDeltaInFrames: deltaInFrames,
        clamped: false,
      };
    },
    updateItemProps: rec('updateItemProps'), setItemVolume: rec('setItemVolume'),
    setItemFade: rec('setItemFade'), setItemKeyframe: rec('setItemKeyframe'),
    setItemFilters: rec('setItemFilters'), setItemTransform: rec('setItemTransform'),
    setItemSpeed: rec('setItemSpeed'), clearItemKeyframes: rec('clearItemKeyframes'),
    replaceItemMedia: rec('replaceItemMedia'),
    relinkTimelineItem: (id, next) => {
      calls.push(['relinkTimelineItem', id, next]);
      return relinkResult;
    },
    setItemBackgroundFill: rec('setItemBackgroundFill'),
    removeItem: rec('removeItem'), rippleDeleteItem: rec('rippleDeleteItem'),
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

// ── generic transform keyframes (PRD §4.5): validated + batched to setItemKeyframe ──
{
  const plan = validateGenericUpdate(state, {
    type: 'video', itemId: 'v1_abc',
    keyframes: { opacity: [{ frame: 0, value: 1 }, { frame: 30, value: 0, easing: 'easeOut' }], scale: [{ frame: 0, value: 1.2 }] },
  });
  assert.equal(plan.error, undefined, 'keyframes update validates');
  const { calls, commands } = recorder();
  applyGeneric(plan, commands);
  assert.deepEqual(calls.map((c) => c[0]), ['setItemKeyframe', 'setItemKeyframe', 'setItemKeyframe'], 'one setItemKeyframe per point');
  assert.deepEqual(calls[1], ['setItemKeyframe', 'v1_abc', 'opacity', 30, 0, 'easeOut'], 'frame/value/easing pass through');
}
for (const [alias, canonical] of [
  ['ease-in', 'easeIn'],
  ['ease-out', 'easeOut'],
  ['ease-in-out', 'easeInOut'],
] as const) {
  const plan = validateGenericUpdate(state, {
    type: 'video', itemId: 'v1_abc',
    keyframes: { opacity: [{ frame: 0, value: 1, easing: alias }] },
  });
  assert.equal(plan.error, undefined, `${alias} validates`);
  const { calls, commands } = recorder();
  applyGeneric(plan, commands);
  assert.deepEqual(calls[0], ['setItemKeyframe', 'v1_abc', 'opacity', 0, 1, canonical], `${alias} canonicalizes before commit`);
}
assert.ok(validateGenericUpdate(state, { type: 'video', itemId: 'v1_abc', keyframes: { opacity: [{ frame: 0, value: 2 }] } }).error, 'out-of-range keyframe value errors');
assert.ok(validateGenericUpdate(state, { type: 'video', itemId: 'v1_abc', keyframes: { blur: [{ frame: 0, value: 1 }] } }).error, 'unknown keyframe prop errors');
assert.ok(validateGenericUpdate(state, { type: 'video', itemId: 'v1_abc', keyframes: { opacity: [{ frame: 0, value: 1, easing: 'zigzag' }] } }).error, 'bad easing errors');

// ── no fields → error ──
assert.ok(validateGenericUpdate(state, { type: 'video', itemId: 'v1_abc' }).error, 'empty update errors');
// ── unknown item → error ──
assert.ok(validateGenericUpdate(state, { type: 'video', itemId: 'nope' }).error, 'missing item errors');
// ── invalid track → error ──
assert.ok(validateGenericUpdate(state, { type: 'video', itemId: 'v1_abc', track: 'A9' }).error, 'bad track errors');

// ── atomic pool-asset replacement preserves the existing slot ──
{
  const replacementAssets = [{
    id: 'vid_new', kind: 'video', name: 'new', src: '/media/new.mp4', durationInFrames: 180,
  }] as unknown as MediaAsset[];
  const plan = validateGenericUpdate(state, {
    type: 'video', itemId: 'v1_abc', assetId: 'vid_new',
    sourceStartFrame: 15, sourceDurationInFrames: 60,
  }, replacementAssets);
  assert.equal(plan.error, undefined, 'pool replacement validates');
  assert.equal(plan.plan, 'replacePoolAsset');
  assert.equal(plan.itemId, 'v1_abc');
  assert.equal(plan.assetId, 'vid_new');
  assert.equal(plan.srcInFrame, 15);
  assert.equal(plan.durationInFrames, 60);
}
// source-frame aliases are exact; source duration respects playback rate.
{
  const speedState = {
    ...state,
    items: [{ ...state.items[0]!, playbackRate: 2 }],
  } as TimelineState;
  const plan = validateGenericUpdate(speedState, {
    type: 'video', itemId: 'v1_abc', sourceStartFrame: 12, sourceDurationInFrames: 80,
  });
  assert.equal(plan.error, undefined);
  assert.equal(plan.srcInFrame, 12);
  assert.equal(plan.durationInFrames, 40, '80 source frames at 2x occupy 40 timeline frames');
}
// ── fromFrame alias + id alias ──
{
  const plan = validateGenericUpdate(state, { type: 'video', id: 'v1_', fromFrame: 12, durationInFrames: 40 });
  assert.equal(plan.error, undefined, 'fromFrame+id validate');
  assert.equal(plan.itemId, 'v1_abc');
  assert.equal(plan.startFrame, 12, 'fromFrame → startFrame');
}
// ── unknown field + Did you mean ──
{
  const err = String(validateGenericUpdate(state, { type: 'video', itemId: 'v1_abc', startFrane: 10 } as Record<string, unknown>).error ?? '');
  assert.ok(err.includes('unknown field'), err);
  assert.ok(err.includes('Did you mean') || err.includes('startFrame'), err);
}
assert.equal(didYouMean('startFrane', ['startFrame', 'fromFrame']), 'startFrame');
assert.ok(rejectUnknownFields({ name: 'x' }, { type: true, assetId: true })?.includes('unknown field'));

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

// ── B-roll placement: validateGenericAdd (place a pool asset as a clip) ──────────────────
const pool = [
  { id: 'aud_music01', kind: 'audio', name: 'bgm', src: '/media/bgm.mp3', durationInFrames: 300 },
  { id: 'vid_broll01', kind: 'video', name: 'broll', src: '/media/broll.mp4', durationInFrames: 150 },
  { id: 'vid_broll02', kind: 'video', name: 'broll2', src: '/media/broll2.mp4', durationInFrames: 120 },
  { id: 'img_logo01', kind: 'image', name: 'logo', src: '/media/logo.png', durationInFrames: 90 },
] as unknown as MediaAsset[];

// GENERIC_ADD_KINDS = pool-placeable kinds (library MG still uses library: prefix path; text/solid authored)
for (const k of ['video', 'image', 'gif', 'svg', 'audio', 'motion-graphic']) assert.ok(GENERIC_ADD_KINDS.has(k), `GENERIC_ADD_KINDS missing ${k}`);
assert.ok(!GENERIC_ADD_KINDS.has('text') && !GENERIC_ADD_KINDS.has('solid'), 'text/solid are not pool adds');

// exact-id placement → addMedia plan on the right track/position
{
  const p = validateGenericAdd(state, pool, { type: 'video', assetId: 'vid_broll01', track: 'V1', startFrame: 60 });
  assert.equal(p.error, undefined, 'video add validates');
  assert.equal(p.plan, 'addMedia'); assert.equal(p.assetId, 'vid_broll01');
  assert.equal(p.track, 'V1'); assert.equal(p.startFrame, 60); assert.equal(p.kind, 'video');
}
// no track hint: video defaults to V1, audio to A1
assert.equal(validateGenericAdd(state, pool, { type: 'video', assetId: 'vid_broll01' }).track, 'V1', 'video default track V1');
assert.equal(validateGenericAdd(state, pool, { type: 'audio', assetId: 'aud_music01' }).track, 'A1', 'audio default track A1');
// startFrame omitted → not in plan (appends)
assert.equal('startFrame' in validateGenericAdd(state, pool, { type: 'video', assetId: 'vid_broll01' }), false, 'no startFrame → append');

// ambiguous prefix → error with candidates (G2)
{
  const p = validateGenericAdd(state, pool, { type: 'video', assetId: 'vid_broll0' });
  assert.ok(p.error, 'ambiguous prefix errors');
  assert.equal((p.candidates as unknown[]).length, 2, 'lists both candidates');
}
// unknown asset → error
assert.ok(validateGenericAdd(state, pool, { type: 'video', assetId: 'zzz' }).error, 'unknown asset errors');
// kind mismatch (asset is image, asked video) → error
assert.ok(validateGenericAdd(state, pool, { type: 'video', assetId: 'img_logo01' }).error, 'kind mismatch errors');
// duration override (trim a still at placement); ≤0 ignored
assert.equal(validateGenericAdd(state, pool, { type: 'image', assetId: 'img_logo01', track: 'V1', durationInFrames: 120 }).durationInFrames, 120, 'duration override carried');
assert.equal('durationInFrames' in validateGenericAdd(state, pool, { type: 'image', assetId: 'img_logo01', track: 'V1', durationInFrames: 0 }), false, 'non-positive duration ignored');
// unsupported add type (text is authored, not a pool asset)
assert.ok(validateGenericAdd(state, pool, { type: 'text', assetId: 'x' }).error, 'text add unsupported');
// missing assetId → error
assert.ok(validateGenericAdd(state, pool, { type: 'video' }).error, 'missing assetId errors');
// live: unknown field "name" on adds (pool media has no name field)
{
  const err = String(validateGenericAdd(state, pool, { type: 'video', assetId: 'vid_broll01', name: 'My Clip' }).error ?? '');
  assert.ok(err.includes('unknown field') && err.includes('name'), err);
}
// fromFrame alias on add
assert.equal(validateGenericAdd(state, pool, { type: 'video', assetId: 'vid_broll01', fromFrame: 90 }).startFrame, 90);
// delete by id alias
assert.equal(validateGenericDelete(state, { type: 'video', id: 'v1_abc' }).itemId, 'v1_abc');

// ── transform.crop: composition pixels → stored fractions; per-edge merge ──
{
  const plan = validateGenericUpdate(state, { type: 'video', itemId: 'v1_abc', transform: { crop: { left: 384 } } }) as { error?: string; transform?: ClipTransform };
  assert.equal(plan.error, undefined, 'crop left px validates');
  assert.equal(plan.transform?.crop?.left, 384 / 1920);
  const { calls, commands } = recorder();
  applyGeneric(plan, commands);
  assert.deepEqual(calls.find((c) => c[0] === 'setItemTransform')![2], { crop: { left: 384 / 1920, top: 0, right: 0, bottom: 0 } });
}
{
  const cropped = {
    ...state,
    items: [{ ...state.items[0]!, transform: { crop: { left: 0.1, right: 0.05 } } }],
  } as TimelineState;
  const plan = validateGenericUpdate(cropped, { type: 'video', itemId: 'v1_abc', transform: { crop: { top: 108 } } }) as { error?: string; transform?: ClipTransform };
  assert.equal(plan.error, undefined);
  assert.equal(plan.transform?.crop?.left, 0.1);
  assert.equal(plan.transform?.crop?.right, 0.05);
  assert.equal(plan.transform?.crop?.top, 108 / 1080);
}
{
  const plan = validateGenericUpdate(state, { type: 'video', itemId: 'v1_abc', transform: { crop: null } }) as { error?: string; transform?: ClipTransform };
  assert.equal(plan.error, undefined, 'crop null clears');
  assert.equal(plan.transform?.crop, undefined);
}

console.log('edit-item-generic.check.ts OK');
