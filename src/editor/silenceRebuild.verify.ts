// Runnable check: `npx tsx src/editor/silenceRebuild.verify.ts`.
// 验证:span→局部帧裁剪(clamp/并碎段/贴边),以及规划出的 split/remove 序列
// 经【真实 reducer】逐条应用后,时间线的段数/时长/srcIn/波纹左移全部正确。
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

// ── spansToLocalCuts:源毫秒 → 局部帧,clamp 源窗口,srcIn 生效 ──
const trimmed = clip({ srcInFrame: 60, durationInFrames: 240 }); // 源窗口 [60, 300)
const cuts1 = spansToLocalCuts(trimmed, [
  { startMs: 0, endMs: 1000 },      // 源 [0,30) — 在窗口前,clamp 后不足 → 丢
  { startMs: 4000, endMs: 5000 },   // 源 [120,150) → 局部 [60,90)
  { startMs: 9800, endMs: 12000 },  // 源 [294,360) → 局部 [234,240) 贴尾
], FPS);
assert.deepEqual(cuts1, [{ fromFrame: 60, toFrame: 90 }, { fromFrame: 234, toFrame: 240 }], 'clamp + srcIn 映射');

// 碎保留段并入删除:两段静音只隔 3 帧 → 合并为一段
const cuts2 = spansToLocalCuts(clip({}), [
  { startMs: 1000, endMs: 2000 },
  { startMs: 2100, endMs: 3000 },
], FPS);
assert.deepEqual(cuts2, [{ fromFrame: 30, toFrame: 90 }], '3 帧保留段并入');

// 整条全静:保守放弃
assert.deepEqual(spansToLocalCuts(clip({}), [{ startMs: 0, endMs: 10_000 }], FPS), [], '整条全静不动');

// ── 规划 + 真 reducer:中段死气,后续同轨 clip 波纹左移 ──
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

// ── 开头死气 + 结尾死气(头删原 id,尾整段移除) ──
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

// ── 多段死气:三保留段,srcIn 逐段跳,末段贴齐 ──
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

// ── 淡入淡出归到外缘:首段保 fadeIn,末段保 fadeOut,切口无淡化 ──
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

// ── 守门:变速/zoom/词级编辑/非音视频/无源 ──
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
