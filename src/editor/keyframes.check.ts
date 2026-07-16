// Generic transform keyframes (PRD §4.5): sampling / easing / split consistency /
// retime scaling + reducer integration. Run: npx tsx src/editor/keyframes.check.ts
import assert from 'node:assert/strict';
import { easeProgress, sampleKeyframes, scaleKeyframes, splitKeyframes, upsertKeyframe } from './keyframes';
import { reduce } from './reduce';
import type { Keyframe, TimelineItem, TimelineState } from './types';

const approx = (a: number, b: number, eps = 1e-6, msg?: string) =>
  assert.ok(Math.abs(a - b) <= eps * Math.max(1, Math.abs(b)), msg ?? `expected ${a} ≈ ${b}`);

// ── sampling: hold outside, interpolate inside ──────────────────────────────
assert.equal(sampleKeyframes([], 10), 0, 'empty list → 0');
assert.equal(sampleKeyframes([{ frame: 30, value: 0.7 }], 0), 0.7, 'single kf holds before');
assert.equal(sampleKeyframes([{ frame: 30, value: 0.7 }], 99), 0.7, 'single kf holds after');
{
  const kfs: Keyframe[] = [{ frame: 10, value: 0 }, { frame: 20, value: 100 }];
  assert.equal(sampleKeyframes(kfs, 0), 0, 'holds first value before span');
  assert.equal(sampleKeyframes(kfs, 15), 50, 'linear midpoint');
  assert.equal(sampleKeyframes(kfs, 20), 100, 'exact endpoint');
  assert.equal(sampleKeyframes(kfs, 500), 100, 'holds last value after span');
}

// ── easing: named curves + bezier tuples ────────────────────────────────────
assert.equal(easeProgress(0.5, undefined), 0.5, 'default linear');
assert.equal(easeProgress(0, 'easeIn'), 0, 'easing endpoint 0');
assert.equal(easeProgress(1, 'easeInOut'), 1, 'easing endpoint 1');
assert.ok(easeProgress(0.25, 'easeIn') < 0.25, 'easeIn starts slow');
assert.ok(easeProgress(0.25, 'easeOut') > 0.25, 'easeOut starts fast');
approx(easeProgress(0.5, 'easeInOut'), 0.5, 1e-4, 'easeInOut symmetric midpoint');
approx(easeProgress(0.3, [0, 0, 1, 1]), 0.3, 1e-4, 'identity-ish tuple ≈ linear');
{
  // monotonic and inside [0,1] for a standard tuple
  let prev = 0;
  for (let i = 0; i <= 20; i++) {
    const y = easeProgress(i / 20, [0.42, 0, 0.58, 1]);
    assert.ok(y >= prev - 1e-9 && y >= -1e-9 && y <= 1 + 1e-9, 'tuple easing monotonic in [0,1]');
    prev = y;
  }
}

// ── upsert: same frame overwrites, list stays sorted ────────────────────────
{
  let kfs = upsertKeyframe(undefined, 20, 1);
  kfs = upsertKeyframe(kfs, 5, 0, 'easeOut');
  kfs = upsertKeyframe(kfs, 20, 0.5);
  assert.deepEqual(kfs.map((k) => k.frame), [5, 20], 'sorted, no duplicate frames');
  assert.equal(kfs[1].value, 0.5, 'same-frame set overwrites');
  assert.equal(kfs[0].easing, 'easeOut', 'easing preserved');
}

// ── split consistency: sample(orig, f) === left/right sampling per frame ────
function assertSplitConsistent(kfs: Keyframe[], cut: number, dur: number, label: string) {
  const [left, right] = splitKeyframes(kfs, cut);
  for (let f = 0; f < dur; f++) {
    const want = sampleKeyframes(kfs, f);
    const got = f < cut ? sampleKeyframes(left, f) : sampleKeyframes(right, f - cut);
    approx(got, want, 1e-6, `${label}: frame ${f} — got ${got}, want ${want}`);
  }
}
assertSplitConsistent([{ frame: 0, value: 0 }, { frame: 100, value: 100 }], 40, 120, 'linear straddle');
assertSplitConsistent([{ frame: 0, value: 0, easing: 'easeInOut' }, { frame: 100, value: 100 }], 40, 120, 'easeInOut straddle');
assertSplitConsistent([{ frame: 0, value: 1, easing: [0.3, 0.1, 0.7, 0.9] }, { frame: 90, value: 0 }], 33, 120, 'bezier tuple straddle');
assertSplitConsistent(
  [{ frame: 10, value: 0, easing: 'easeIn' }, { frame: 50, value: 1, easing: 'easeOut' }, { frame: 80, value: 0.2 }],
  50, 120, 'cut exactly on a keyframe',
);
assertSplitConsistent([{ frame: 60, value: 5 }, { frame: 80, value: 9 }], 30, 120, 'cut before first kf');
assertSplitConsistent([{ frame: 5, value: 5, easing: 'easeIn' }, { frame: 20, value: 9 }], 90, 120, 'cut after last kf');
{
  // right half is rebased to local frame 0 and both halves are non-empty
  const [left, right] = splitKeyframes([{ frame: 0, value: 0 }, { frame: 100, value: 100 }], 40);
  assert.ok(left.length >= 2 && right.length >= 2, 'boundary anchors added');
  assert.equal(right[0].frame, 0, 'right half starts at local 0');
  approx(right[0].value, 40, 1e-9, 'boundary anchor carries the sampled value');
}

// ── scale (变速): frames rescale + rounding collisions collapse ─────────────
{
  const kfs: Keyframe[] = [{ frame: 0, value: 0 }, { frame: 10, value: 1 }, { frame: 11, value: 2 }, { frame: 40, value: 3 }];
  const half = scaleKeyframes(kfs, 0.5);
  assert.deepEqual(half.map((k) => [k.frame, k.value]), [[0, 0], [5, 1], [6, 2], [20, 3]], 'halved frames');
  const tiny = scaleKeyframes(kfs, 0.05);
  assert.deepEqual(tiny.map((k) => [k.frame, k.value]), [[0, 0], [1, 2], [2, 3]], 'collisions: later keyframe wins');
  const dbl = scaleKeyframes(kfs, 2);
  assert.deepEqual(dbl.map((k) => k.frame), [0, 20, 22, 80], 'doubled frames');
}

// ── reducer integration ─────────────────────────────────────────────────────
const clip = (over: Partial<TimelineItem>): TimelineItem =>
  ({ id: 'v1', track: 'V1', startFrame: 0, durationInFrames: 100, kind: 'video', name: 'clip', src: '/m.mp4', ...over });
const stateOf = (it: TimelineItem, locked = false): TimelineState =>
  ({ fps: 30, width: 1920, height: 1080, selectedId: null, items: [it], ...(locked ? { tracks: { V1: { kind: 'video', locked: true } } } : {}) });

{ // setKeyframe: sorted insert, same-frame overwrite, opacity clamped to 0..1
  let s = stateOf(clip({}));
  s = reduce(s, { type: 'setKeyframe', id: 'v1', prop: 'opacity', frame: 50, value: 0.5 });
  s = reduce(s, { type: 'setKeyframe', id: 'v1', prop: 'opacity', frame: 10, value: 2, easing: 'easeIn' });
  s = reduce(s, { type: 'setKeyframe', id: 'v1', prop: 'opacity', frame: 50, value: 0.25 });
  const kfs = s.items[0].keyframes!.opacity!;
  assert.deepEqual(kfs.map((k) => [k.frame, k.value]), [[10, 1], [50, 0.25]], 'sorted + clamped + overwritten');
  assert.equal(kfs[0].easing, 'easeIn');
  // removeKeyframe drops the point; removing the last point drops the prop + map
  let r = reduce(s, { type: 'removeKeyframe', id: 'v1', prop: 'opacity', frame: 10 });
  r = reduce(r, { type: 'removeKeyframe', id: 'v1', prop: 'opacity', frame: 50 });
  assert.equal(r.items[0].keyframes, undefined, 'empty prop → keyframes cleared');
  assert.equal(reduce(r, { type: 'removeKeyframe', id: 'v1', prop: 'opacity', frame: 50 }), r, 'removing a missing kf is a true no-op');
  // clearKeyframes with/without prop
  const c = reduce(s, { type: 'clearKeyframes', id: 'v1', prop: 'opacity' });
  assert.equal(c.items[0].keyframes, undefined, 'clear prop drops empty map');
  assert.equal(reduce(s, { type: 'clearKeyframes', id: 'v1' }).items[0].keyframes, undefined, 'clear all');
}
{ // audio clips can't take transform keyframes
  const s = stateOf(clip({ kind: 'audio', src: '/a.mp3' }));
  assert.equal(reduce(s, { type: 'setKeyframe', id: 'v1', prop: 'opacity', frame: 0, value: 1 }), s, 'audio → no-op');
}
{ // locked track blocks keyframe + prop edits (轨道 lock)
  const s = stateOf(clip({}), true);
  assert.equal(reduce(s, { type: 'setKeyframe', id: 'v1', prop: 'scale', frame: 0, value: 2 }), s, 'locked: setKeyframe no-op');
  assert.equal(reduce(s, { type: 'setTransform', id: 'v1', patch: { scale: 2 } }), s, 'locked: setTransform no-op');
  assert.equal(reduce(s, { type: 'updateProps', id: 'v1', patch: { a: 1 } }), s, 'locked: updateProps no-op');
  assert.equal(reduce(s, { type: 'setSpeed', id: 'v1', rate: 2 }), s, 'locked: setSpeed no-op');
}
{ // split partitions keyframes: per-frame sampling identical across the cut
  const kfs: Keyframe[] = [{ frame: 0, value: 0, easing: 'easeInOut' }, { frame: 80, value: 1 }];
  const base = stateOf(clip({ keyframes: { opacity: kfs, scale: [{ frame: 10, value: 1 }, { frame: 90, value: 2, easing: 'easeOut' }] } }));
  const out = reduce(base, { type: 'split', id: 'v1', atFrame: 40, newId: 'v1b' });
  const L = out.items.find((x) => x.id === 'v1')!;
  const R = out.items.find((x) => x.id === 'v1b')!;
  for (const prop of ['opacity', 'scale'] as const) {
    for (let f = 0; f < 100; f++) {
      const want = sampleKeyframes(base.items[0].keyframes![prop]!, f);
      const got = f < 40 ? sampleKeyframes(L.keyframes![prop]!, f) : sampleKeyframes(R.keyframes![prop]!, f - 40);
      approx(got, want, 1e-6, `split ${prop} frame ${f}`);
    }
  }
}
{ // setSpeed rescales keyframe frames with the retimed duration
  const s = stateOf(clip({ keyframes: { opacity: [{ frame: 0, value: 0 }, { frame: 100, value: 1 }] } }));
  const out = reduce(s, { type: 'setSpeed', id: 'v1', rate: 2 });
  assert.equal(out.items[0].durationInFrames, 50, '2× → half duration');
  assert.deepEqual(out.items[0].keyframes!.opacity!.map((k) => k.frame), [0, 50], 'kf frames scaled with retime');
  const noKf = reduce(stateOf(clip({})), { type: 'setSpeed', id: 'v1', rate: 2 });
  assert.ok(!('keyframes' in noKf.items[0]), 'no-keyframe clip gains no keyframes key on retime');
}

console.log('keyframes.check: OK');
