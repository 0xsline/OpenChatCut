// Runnable check: `npx tsx src/transcript/cutPad.verify.ts`.
// 验证删词切口的呼吸口:只在删词/重排切出来的口子上借静音,片段自身首尾和被静音
// 压缩规则管过的间隙都不借;借的量以现场真有的静音为准,借不到就少借。
import assert from 'node:assert/strict';
import { keptSegments } from './edit';
import type { TranscriptWord } from './types';

const fps = 100; // 10ms 一帧,好让毫秒直接读成帧
// 每词 100ms,词间留 200ms 静音:w0 [0,100] w1 [300,400] w2 [600,700] w3 [900,1000]
const words: TranscriptWord[] = [0, 1, 2, 3].map((i) => ({
  text: `w${i}`, start: i * 300, end: i * 300 + 100,
}));

const spans = (deleted: number[], cutPadFrames?: number) =>
  keptSegments(words, new Set(deleted), fps, 0, { cutPadFrames })
    .map((s) => [s.srcStartFrame, s.srcEndFrame]);

// ── 默认(不传)= 老行为,精确切在词边界 ──
{
  assert.deepEqual(spans([1]), [[0, 10], [60, 100]], '不设呼吸口时切点分毫不差');
  assert.deepEqual(spans([]), [[0, 100]], '没删词就是一整段');
}

// ── 切口两侧各借 half:60 帧预算 → 每侧 30 帧,现场静音 20 帧,只借得到 20 ──
{
  assert.deepEqual(
    spans([1], 60),
    [[0, 30], [40, 100]],
    '第一段尾巴借到 w1 起点,第二段头借到 w1 终点,都被现场静音卡住',
  );
}

// ── 预算小于现场静音时,按预算借 ──
{
  assert.deepEqual(spans([1], 20), [[0, 20], [50, 100]], '每侧 10 帧');
  assert.deepEqual(spans([1], 1), [[0, 10], [60, 100]], 'half 取整后为 0,等于不借');
}

// ── 只有切口才借:删掉首/尾词之后,新出现的那一头是切口(借),另一头不是(不借) ──
{
  assert.deepEqual(spans([3], 60), [[0, 90]], '尾词删掉 → 收尾成了切口,往后借到 w3 起点');
  assert.deepEqual(spans([0], 60), [[10, 100]], '首词删掉 → 开头成了切口,往前借到 w0 终点');
  // 一个词都没删时两头都不是切口,再大的预算也一帧都不借。
  assert.deepEqual(spans([], 600), [[0, 100]], '片段自身的首尾不借');
}

// ── 被静音压缩规则管过的间隙不借:长度已经由 cap 说了算 ──
{
  const capped = keptSegments(words, new Set(), fps, 0, { cutPadFrames: 60, gapCapsMs: { 1: 50 } })
    .map((s) => [s.srcStartFrame, s.srcEndFrame]);
  assert.deepEqual(capped, [[0, 15], [30, 100]], 'cap 后的 w0 段止于 10+5,不再额外借;下一段头也不借');
}

// ── 重排造成的切口同样算切口 ──
{
  const reordered = keptSegments(words, new Set(), fps, 0, { cutPadFrames: 60, playOrder: [2, 3, 0, 1] })
    .map((s) => [s.srcStartFrame, s.srcEndFrame]);
  assert.deepEqual(reordered, [[40, 100], [0, 60]], '两段各自在被切开的一侧借到静音');
}

// ── 时间线位置仍然首尾相接:借来的帧计入时长,不能留下重叠或空洞 ──
{
  const segs = keptSegments(words, new Set([1]), fps, 500, { cutPadFrames: 60 });
  let cursor = 500;
  for (const seg of segs) {
    assert.equal(seg.fromFrame, cursor, '每段紧接上一段');
    assert.equal(seg.durFrames, seg.srcEndFrame - seg.srcStartFrame, '时长等于借完之后的源跨度');
    cursor += seg.durFrames;
  }
}

console.log('cutPad.verify: ok (默认不变/两侧平分/现场静音上限/首尾不借/cap 不借/重排切口/时间线连续)');
