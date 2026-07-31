// Runnable check: `npx tsx src/transcript/cutPad.verify.ts`.
// Verify the breathing opening of the deletion cut: only mute the opening cut by deletion/rearrangement, and the beginning and end of the segment itself will be muted
// The gap controlled by the compression rules will not be borrowed; the amount borrowed shall be based on the actual silence on site. If you cannot borrow, borrow less.
import assert from 'node:assert/strict';
import { keptSegments } from './edit';
import type { TranscriptWord } from './types';

const fps = 100; // 10ms one frame, so that milliseconds can be read directly into frames
// 100ms per word, 200ms between words mute: w0 [0,100] w1 [300,400] w2 [600,700] w3 [900,1000]
const words: TranscriptWord[] = [0, 1, 2, 3].map((i) => ({
  text: `w${i}`, start: i * 300, end: i * 300 + 100,
}));

const spans = (deleted: number[], cutPadFrames?: number) =>
  keptSegments(words, new Set(deleted), fps, 0, { cutPadFrames })
    .map((s) => [s.srcStartFrame, s.srcEndFrame]);

// ── Default (not passed) = old behavior, precise at word boundaries ──
{
  assert.deepEqual(spans([1]), [[0, 10], [60, 100]], '不设呼吸口时切点分毫不差');
  assert.deepEqual(spans([]), [[0, 100]], '没删词就是一整段');
}

// ── Borrow half on each side of the cut: 60 frames budget → 30 frames per side, 20 frames live mute, only borrow 20 ──
{
  assert.deepEqual(
    spans([1], 60),
    [[0, 30], [40, 100]],
    '第一段尾巴借到 w1 起点,第二段头借到 w1 终点,都被现场静音卡住',
  );
}

// ── If the budget is less than the on-site silence, borrow according to the budget ──
{
  assert.deepEqual(spans([1], 20), [[0, 20], [50, 100]], '每侧 10 帧');
  assert.deepEqual(spans([1], 1), [[0, 10], [60, 100]], 'half 取整后为 0,等于不借');
}

// ── Only incisions are borrowed: after deleting the first/last word, the new one is the incision (borrowing), and the other end is not (not borrowing) ──
{
  assert.deepEqual(spans([3], 60), [[0, 90]], '尾词删掉 → 收尾成了切口,往后借到 w3 起点');
  assert.deepEqual(spans([0], 60), [[10, 100]], '首词删掉 → 开头成了切口,往前借到 w0 终点');
  // When not a single word is deleted, neither end is a cut, and no matter how big the budget is, not a single frame is borrowed.
  assert.deepEqual(spans([], 600), [[0, 100]], '片段自身的首尾不借');
}

// ── The gaps governed by the silent compression rules are not borrowed: the length has been determined by cap ──
{
  const capped = keptSegments(words, new Set(), fps, 0, { cutPadFrames: 60, gapCapsMs: { 1: 50 } })
    .map((s) => [s.srcStartFrame, s.srcEndFrame]);
  assert.deepEqual(capped, [[0, 15], [30, 100]], 'cap 后的 w0 段止于 10+5,不再额外借;下一段头也不借');
}

// ── Incisions caused by rearrangements are also considered incisions──
{
  const reordered = keptSegments(words, new Set(), fps, 0, { cutPadFrames: 60, playOrder: [2, 3, 0, 1] })
    .map((s) => [s.srcStartFrame, s.srcEndFrame]);
  assert.deepEqual(reordered, [[40, 100], [0, 60]], '两段各自在被切开的一侧借到静音');
}

// ── Timeline positions are still connected end to end: borrowed frames are included in the duration and cannot leave overlaps or holes ──
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
