// 音频转写窗口守卫检查:npx tsx src/editor/audio-transcript-guard.verify.ts
// ASR 跑在非语音音频(音效)上会编造词:一段 3s 的 sting 会得到 "Music" 24.4s。
// AudioClip 会把这些词当作源窗口播放,于是音效被裁到一段根本没有声音的区间,
// 时间线上看起来一切正常,却完全听不见。守卫有两条:
//   1) 源窗口起点超出媒体长度 → 丢弃
//   2) 用户没删过词,却只留下不到一半的片段 → 整段平铺播放
// 两条都不满足时行为保持不变(真实的逐词删除仍然照常生效)。
import assert from 'node:assert/strict';
import { keptSegments } from '../transcript/edit';
import type { TranscriptWord } from '../transcript/types';
import { audibleTranscriptSegments } from './audioTranscriptGuard';

const fps = 30;
const segmentsOf = (words: TranscriptWord[], deleted: number[] = []) => keptSegments(words, new Set(deleted), fps, 0, {});

// 音效幻觉 1:3s(90 帧)的 sting,ASR 给出 "Music" 24.42–24.44s → 窗口起点在文件之外
{
  const segs = segmentsOf([{ text: 'Music', start: 24420, end: 24440 }]);
  assert.ok(segs[0]!.srcStartFrame >= 90, 'keptSegments 确实给出了越界窗口(前提)');
  assert.equal(audibleTranscriptSegments(segs, { durationInFrames: 90, deletedWordCount: 0, sourceDurationInFrames: 90 }), null,
    '越界窗口 → 平铺播放');
}

// 音效幻觉 2:1.8s(55 帧)的 sting,只有一个落在文件内的假词 → 留下 15 帧,不到一半
{
  const segs = segmentsOf([{ text: 'Uh', start: 500, end: 1000 }]);
  assert.equal(audibleTranscriptSegments(segs, { durationInFrames: 55, deletedWordCount: 0, sourceDurationInFrames: 55 }), null,
    '未编辑却吞掉大半 → 平铺播放');
}

const speech: TranscriptWord[] = [
  { text: 'one', start: 0, end: 900 },
  { text: 'two', start: 1000, end: 1900 },
  { text: 'three', start: 2000, end: 2900 },
  { text: 'four', start: 3000, end: 3900 },
];

// 正常语音:转写覆盖整段 → 原样走转写
{
  const segs = segmentsOf(speech);
  assert.deepEqual(audibleTranscriptSegments(segs, { durationInFrames: 118, deletedWordCount: 0, sourceDurationInFrames: 120 }), segs,
    '覆盖完整 → 尊重转写');
}

// 真实逐词删除:用户删了三个词,只剩一小段是有意的 → 照常走转写
{
  const segs = segmentsOf(speech, [1, 2, 3]);
  assert.deepEqual(audibleTranscriptSegments(segs, { durationInFrames: 118, deletedWordCount: 3, sourceDurationInFrames: 120 }), segs,
    '有删除 → 尊重转写');
}

// 媒体长度未知时不做越界判断(只看吞片规则)
{
  const segs = segmentsOf(speech);
  assert.deepEqual(audibleTranscriptSegments(segs, { durationInFrames: 118, deletedWordCount: 0 }), segs, '长度未知 → 不误伤');
}

// 部分越界:文件内的窗口保留,越界的丢掉
{
  const segs = [
    { srcStartFrame: 0, srcEndFrame: 60, fromFrame: 0, durFrames: 60 },
    { srcStartFrame: 733, srcEndFrame: 734, fromFrame: 60, durFrames: 1 },
  ];
  assert.deepEqual(audibleTranscriptSegments(segs, { durationInFrames: 61, deletedWordCount: 0, sourceDurationInFrames: 90 }), [segs[0]],
    '只丢越界窗口');
}

console.log('audio-transcript-guard.verify: ok (越界丢弃/吞片平铺/删除词照常/长度未知不误伤/部分越界)');
