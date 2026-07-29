// Runnable check: `npx tsx src/editor/silenceRebuild.verify.ts`.
// Verify: span→local frame cropping (clamp/segment/edge), and the planned split/remove sequence
// After applying [real reducer] one by one, the number of segments/duration/srcIn/ripple left shift of the timeline are all correct.
import assert from 'node:assert/strict';
import { reduce, type Action } from './reduce';
import { planSilenceRemoval, silenceRemovalBlocker, spansToLocalCuts } from './silenceRebuild';
import type { TimelineItem, TimelineState } from './types';

const FPS = 30;

const clip = (over: Partial<TimelineItem>): TimelineItem => ({
  id: 'main', track: 'V1', startFrame: 0, durationInFrames: 300,
  name: 'talk', kind: 'video', src: '/media/uploads/talk.mp4',
  ...over,
});

const baseState = (items: TimelineItem[]): TimelineState => ({
  fps: FPS, width: 1920, height: 1080, items, selectedId: null,
} as unknown as TimelineState);

const apply = (state: TimelineState, actions: Action[]): TimelineState =>
  actions.reduce((s, a) => reduce(s, a), state);

// ── spansToLocalCuts: source milliseconds → local frame, clamp source window, srcIn takes effect ──
const trimmed = clip({ srcInFrame: 60, durationInFrames: 240 }); // Source window [60, 300)
const cuts1 = spansToLocalCuts(trimmed, [
  { startMs: 0, endMs: 1000 },      // source [0,30) — before window, insufficient after clamp → lose
  { startMs: 4000, endMs: 5000 },   // source [120,150) → local [60,90)
  { startMs: 9800, endMs: 12000 },  // source [294,360) → local [234,240) tail
], FPS);
assert.deepEqual(cuts1, [{ fromFrame: 60, toFrame: 90 }, { fromFrame: 234, toFrame: 240 }], 'clamp + srcIn 映射');

// The fragmented reserved sections are merged and deleted: the two sections of silence are only separated by 3 frames → merged into one section
const cuts2 = spansToLocalCuts(clip({}), [
  { startMs: 1000, endMs: 2000 },
  { startMs: 2100, endMs: 3000 },
], FPS);
assert.deepEqual(cuts2, [{ fromFrame: 30, toFrame: 90 }], '3 帧保留段并入');

// The entire line is quiet: conservative and giving up
assert.deepEqual(spansToLocalCuts(clip({}), [{ startMs: 0, endMs: 10_000 }], FPS), [], '整条全静不动');

// ── Planning + true reducer: dead energy in the middle, subsequent clip ripples on the same track shift left ──
{
  const follower = clip({ id: 'next', startFrame: 300, durationInFrames: 90 });
  let n = 0;
  const plan = planSilenceRemoval(clip({}), [{ fromFrame: 100, toFrame: 160 }], () => `seg_${++n}`);
  const out = apply(baseState([clip({}), follower]), plan.actions);
  const v1 = out.items.filter((it) => it.track === 'V1').sort((a, b) => a.startFrame - b.startFrame);
  assert.equal(plan.removedFrames, 60);
  assert.equal(v1.length, 3, '主 clip 变两段 + 跟随 clip');
  const [a, b, c] = v1;
  assert.deepEqual([a!.startFrame, a!.durationInFrames, a!.srcInFrame ?? 0], [0, 100, 0], '保留段 1');
  assert.deepEqual([b!.startFrame, b!.durationInFrames, b!.srcInFrame], [100, 140, 160], '保留段 2 源点跳过死气');
  assert.deepEqual([c!.id, c!.startFrame], ['next', 240], '同轨后续 clip 左移 60 帧');
}

// ── The death energy at the beginning + the death energy at the end (the original id is deleted at the beginning, and the whole paragraph at the end is removed) ──
{
  let n = 0;
  const plan = planSilenceRemoval(clip({}), [
    { fromFrame: 0, toFrame: 45 },
    { fromFrame: 200, toFrame: 300 },
  ], () => `seg_${++n}`);
  const out = apply(baseState([clip({})]), plan.actions);
  assert.equal(plan.removedFrames, 145);
  assert.equal(out.items.length, 1, '只剩中间保留段');
  const only = out.items[0]!;
  assert.deepEqual([only.startFrame, only.durationInFrames, only.srcInFrame], [0, 155, 45], '头尾都删净,srcIn=45');
}

// ── Multiple sections of dead energy: three reserved sections, srcIn jumps section by section, and the last section is aligned ──
{
  let n = 0;
  const plan = planSilenceRemoval(clip({}), [
    { fromFrame: 60, toFrame: 90 },
    { fromFrame: 180, toFrame: 240 },
  ], () => `seg_${++n}`);
  const out = apply(baseState([clip({})]), plan.actions);
  const segs = out.items.sort((a, b) => a.startFrame - b.startFrame);
  assert.equal(segs.length, 3);
  assert.deepEqual(segs.map((s) => [s.startFrame, s.durationInFrames, s.srcInFrame ?? 0]), [
    [0, 60, 0],
    [60, 90, 90],
    [150, 60, 240],
  ], '三段位置/时长/源点');
  const total = segs.reduce((sum, s) => sum + s.durationInFrames, 0);
  assert.equal(total, 300 - plan.removedFrames, '总时长恒等');
}

// ── Fade in and out to the outer edge: keep fadeIn in the first section, fadeOut in the last section, and no fade in the cut ──
{
  let n = 0;
  const faded = clip({ fadeInFrames: 12, fadeOutFrames: 15 });
  const plan = planSilenceRemoval(faded, [{ fromFrame: 100, toFrame: 160 }], () => `f_${++n}`);
  const out = apply(baseState([faded]), plan.actions);
  const segs = out.items.sort((a, b) => a.startFrame - b.startFrame);
  assert.equal(segs[0]!.fadeInFrames, 12, '首段保留 fadeIn');
  assert.equal(segs[0]!.fadeOutFrames, undefined, '切口不淡出');
  assert.equal(segs[1]!.fadeInFrames, undefined, '切口不淡入');
  assert.equal(segs[1]!.fadeOutFrames, 15, '末段保留 fadeOut');
}

// ── Gatekeeper: variable speed/zoom/word-level editing/non-audio/video/passive ──
assert.match(silenceRemovalBlocker(clip({ playbackRate: 2 })) ?? '', /变速/);
assert.match(silenceRemovalBlocker(clip({ zoom: { kind: 'shape' } as never })) ?? '', /zoom/);
assert.match(silenceRemovalBlocker(clip({ kind: 'image' })) ?? '', /无音频/);
assert.match(silenceRemovalBlocker(clip({ src: undefined })) ?? '', /无媒体源/);
assert.match(
  silenceRemovalBlocker(clip({ transcript: [{ text: 'hi', start: 0, end: 300 }], deletedWordIdx: [0] })) ?? '',
  /clean_script/, '词级编辑过的转写 clip 让位 clean_script',
);
assert.equal(silenceRemovalBlocker(clip({ transcript: [{ text: 'hi', start: 0, end: 300 }] })), null, '未编辑的转写 clip 可处理');
assert.equal(silenceRemovalBlocker(clip({})), null, '普通视频可处理');

console.log('silenceRebuild.verify: ok (映射/并段/真 reducer 波纹/淡化外缘/守门)');
