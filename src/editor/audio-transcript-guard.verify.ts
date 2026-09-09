// 音频转写窗口守卫检查:npx tsx src/editor/audio-transcript-guard.verify.ts
// ASR 跑在非语音音频(音效)上会编造词:一段 3s 的 sting 会得到 "Music" 24.4s。
// AudioClip 会把这些词当作源窗口播放,于是音效被裁到一段根本没有声音的区间,
// 时间线上看起来一切正常,却完全听不见。守卫有两条:
//   1) 源窗口起点超出媒体长度 → 丢弃
//   2) 用户没删过词,却只留下不到一半的片段 → 丢弃
// 两条都不满足时行为保持不变(真实的逐词删除仍然照常生效)。
import assert from 'node:assert';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('./TimelineMediaLayer.tsx', import.meta.url), 'utf8');

assert.match(source, /sourceDurationInFrames\?: number;/, 'AudioClip 必须能接收媒体长度');
assert.match(
  source,
  /segment\.srcStartFrame < sourceDurationInFrames/,
  '必须丢弃起点超出媒体长度的片段',
);
assert.match(source, /const swallowsClip = !editedByUser && keptFrames \* 2 < item\.durationInFrames;/, '必须丢弃未编辑却吞掉大半片段的转写');
assert.match(source, /if \(segments\.length && !swallowsClip\)/, '两条守卫都要作用在转写分支上');

// 组合逻辑本身(与实现同构,防止阈值被悄悄改写)
const decide = (
  segs: Array<{ srcStartFrame: number; durFrames: number }>,
  itemDuration: number,
  deleted: number,
  sourceDuration?: number,
) => {
  const kept = segs.filter((s) => sourceDuration === undefined || s.srcStartFrame < sourceDuration);
  const keptFrames = kept.reduce((t, s) => t + s.durFrames, 0);
  const swallows = deleted === 0 && keptFrames * 2 < itemDuration;
  return kept.length > 0 && !swallows ? 'transcript' : 'plain';
};

// 音效幻觉:词在 24.4s,媒体只有 91 帧 → 整段被丢弃
assert.equal(decide([{ srcStartFrame: 733, durFrames: 1 }], 53, 0, 91), 'plain', '越界窗口 → 平铺播放');
// 音效幻觉:词落在文件内,但只留 16 帧 / 55 帧 → 仍然丢弃
assert.equal(decide([{ srcStartFrame: 66, durFrames: 16 }], 55, 0, 91), 'plain', '吞掉大半 → 平铺播放');
// 真实逐词删除:用户删过词,短片段是有意的 → 照常走转写
assert.equal(decide([{ srcStartFrame: 10, durFrames: 16 }], 55, 3, 300), 'transcript', '有删除 → 尊重转写');
// 正常语音:转写覆盖大部分片段 → 照常走转写
assert.equal(decide([{ srcStartFrame: 10, durFrames: 50 }], 55, 0, 300), 'transcript', '覆盖完整 → 尊重转写');
// 媒体长度未知时不做越界判断
assert.equal(decide([{ srcStartFrame: 733, durFrames: 60 }], 55, 0, undefined), 'transcript', '长度未知 → 不误伤');

console.log('audio-transcript-guard.verify: ok (越界丢弃/吞片丢弃/删除词照常/长度未知不误伤)');
