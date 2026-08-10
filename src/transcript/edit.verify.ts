// 词编辑引擎 window(trim 窗口)检查:npx tsx src/transcript/edit.check.ts
// fps=10,词按秒排布,帧数=秒×10,肉眼可核。
import assert from 'node:assert';
import { editedFrames, itemWindow, keptSegments, keptWordIndices, mediaWindowKeptIndices, mediaWindowWords, retimeWords } from './edit';
import type { TranscriptWord } from './types';

const FPS = 10;
const W: TranscriptWord[] = [
  { text: 'a', start: 0, end: 1000 },     // f0-10
  { text: 'b', start: 1000, end: 2000 },  // f10-20
  { text: 'c', start: 3000, end: 4000 },  // f30-40(前有 1s 停顿)
  { text: 'd', start: 4000, end: 5000 },  // f40-50
];
const none = new Set<number>();

// ── 回归红线:无窗口行为不变 ──────────────────────────────────────────────
{
  const segs = keptSegments(W, none, FPS, 0);
  assert.deepEqual(segs, [{ srcStartFrame: 0, srcEndFrame: 50, fromFrame: 0, durFrames: 50 }]);
  assert.equal(editedFrames(W, none, FPS), 50);
  assert.deepEqual(keptWordIndices(W, none, FPS), [0, 1, 2, 3]);
  assert.equal(retimeWords(W, none, FPS, 0).length, 4);
}

// ── 窗口恒等:[0, 全长) 与无窗口一致 ─────────────────────────────────────
{
  const segs = keptSegments(W, none, FPS, 0, { window: { startFrame: 0, durFrames: 50 } });
  assert.deepEqual(segs, [{ srcStartFrame: 0, srcEndFrame: 50, fromFrame: 0, durFrames: 50 }]);
}

// ── 左裁 15 帧:头段被切,词 a 消失、b 被夹到窗口起点 ─────────────────────
{
  const opts = { window: { startFrame: 15, durFrames: 35 } };
  const segs = keptSegments(W, none, FPS, 100, opts); // offset 100 验证重排底座
  assert.deepEqual(segs, [{ srcStartFrame: 15, srcEndFrame: 50, fromFrame: 100, durFrames: 35 }]);
  assert.deepEqual(keptWordIndices(W, none, FPS, opts), [1, 2, 3], '窗口外的词 a 不算存活');
  const words = retimeWords(W, none, FPS, 100, opts);
  assert.equal(words.length, 3);
  assert.equal(words[0].text, 'b');
  assert.equal(Math.round(words[0].start), 100 / FPS * 1000, 'b 被夹到 clip 起点');
}

// ── 右裁:尾段切掉,d 消失、c 截短 ────────────────────────────────────────
{
  const opts = { window: { startFrame: 0, durFrames: 35 } };
  const segs = keptSegments(W, none, FPS, 0, opts);
  assert.deepEqual(segs, [{ srcStartFrame: 0, srcEndFrame: 35, fromFrame: 0, durFrames: 35 }]);
  assert.deepEqual(keptWordIndices(W, none, FPS, opts), [0, 1, 2]);
}

// ── 中段窗口:两头都切 ────────────────────────────────────────────────────
{
  const opts = { window: { startFrame: 15, durFrames: 20 } }; // [15,35)
  assert.deepEqual(keptWordIndices(W, none, FPS, opts), [1, 2]);
}

// ── 删词 + 窗口跨段:分段各自切并重新紧排 ─────────────────────────────────
{
  const del = new Set([1]); // 删 b → 段1 [0,10) + 段2 [30,50),流长 30
  const base = keptSegments(W, del, FPS, 0);
  assert.deepEqual(base, [
    { srcStartFrame: 0, srcEndFrame: 10, fromFrame: 0, durFrames: 10 },
    { srcStartFrame: 30, srcEndFrame: 50, fromFrame: 10, durFrames: 20 },
  ]);
  const segs = keptSegments(W, del, FPS, 0, { window: { startFrame: 5, durFrames: 20 } }); // [5,25)
  assert.deepEqual(segs, [
    { srcStartFrame: 5, srcEndFrame: 10, fromFrame: 0, durFrames: 5 },   // 段1 切头
    { srcStartFrame: 30, srcEndFrame: 45, fromFrame: 5, durFrames: 15 }, // 段2 切尾,紧排接上
  ]);
}

// ── 越界窗口自愈:超出流长 → 空;editedFrames 兜底 1 ─────────────────────
{
  const segs = keptSegments(W, none, FPS, 0, { window: { startFrame: 60, durFrames: 10 } });
  assert.equal(segs.length, 0);
  assert.equal(editedFrames(W, none, FPS, { window: { startFrame: 60, durFrames: 10 } }), 1);
}

// ── itemWindow:只有 audio 产生窗口(video 的 srcInFrame 是媒体帧语义)────
{
  assert.deepEqual(itemWindow({ kind: 'audio', srcInFrame: 15, durationInFrames: 35 }), { startFrame: 15, durFrames: 35 });
  assert.equal(itemWindow({ kind: 'video', srcInFrame: 15, durationInFrames: 35 }), undefined);
  assert.deepEqual(itemWindow({ kind: 'audio', durationInFrames: 50 }), { startFrame: 0, durFrames: 50 });
}

// ── video 媒体窗口投影(长转短 e2e 抓获的音画脱节修复)────────────────────
// video 连续播放 [srcIn, srcIn+dur×rate),字幕按媒体帧直投;可闻即显:
// transcript 删词既不重排也不隐藏(否则窗口开头出现"有人说话没字幕")。
{
  const s = (sec: number): number => sec * 1000; // ms;帧 = sec×FPS
  const W: TranscriptWord[] = [
    { text: 'a', start: s(0), end: s(1) },   // 帧 0×FPS-1×FPS(窗外)
    { text: 'b', start: s(7), end: s(8) },   // 7×FPS-8×FPS
    { text: 'c', start: s(12), end: s(13) }, // 12×FPS-13×FPS
    { text: 'd', start: s(20), end: s(21) }, // 窗外(rate=1 时)
  ];
  const item = { startFrame: 10, durationInFrames: 12 * FPS, srcInFrame: 6 * FPS }; // 窗口 [6s,18s)
  const out = mediaWindowWords(W, FPS, item);
  assert.deepEqual(out.map((w) => w.text), ['b', 'c'], '窗口内 b/c,a/d 在窗外');
  assert.equal(Math.round(out[0].start), Math.round(((10 + 1 * FPS) / FPS) * 1000), 'b 落在 startFrame+1s');
  assert.equal(Math.round(out[1].start), Math.round(((10 + 6 * FPS) / FPS) * 1000), 'c 偏移 6s');
  // 索引与词一一对应(wordOverrides 键)
  assert.deepEqual(mediaWindowKeptIndices(W, FPS, item), [1, 2]);
  // 2× 变速:窗口 [6s, 6s+12s×2)=[6s,30s) → d 也进来,时间线位置减半
  const fast = { startFrame: 0, durationInFrames: 12 * FPS, srcInFrame: 6 * FPS, playbackRate: 2 };
  const outFast = mediaWindowWords(W, FPS, fast);
  assert.deepEqual(outFast.map((w) => w.text), ['b', 'c', 'd']);
  assert.equal(Math.round(outFast[2].start), Math.round(((20 - 6) / 2) * 1000), '变速下媒体帧差除以 rate');
}

console.log('edit.check: ok (无窗口回归/恒等/左裁/右裁/中段/删词跨段/越界自愈/itemWindow kind 门/video 媒体窗投影)');
