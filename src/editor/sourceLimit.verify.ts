// Runnable check: `npx tsx src/editor/sourceLimit.verify.ts`.
// Verify that "the clip cannot be longer than the source asset": conversion of remaining source frames (including variable speed), which clips are not limited
// (picture/MG/text/word-driven audio), and it is confirmed by real reduce that the right cropping is indeed blocked by this upper bound.
import assert from 'node:assert/strict';
import {
  remainingSourceFrames,
  sourceFrameAt,
  sourceFramesToTimelineFrames,
  sourceWindowForTimelineRange,
  timelineFramesToSourceFrames,
} from './sourceLimit';
import { reduce } from './reduce';
import type { MediaAsset, TimelineItem, TimelineState } from './types';

const assets: MediaAsset[] = [
  { id: 'as-v', name: 'a.mp4', kind: 'video', src: '/m/a.mp4', durationInFrames: 300 },
  { id: 'as-a', name: 'a.wav', kind: 'audio', src: '/m/a.wav', durationInFrames: 300 },
  { id: 'as-i', name: 'a.png', kind: 'image', src: '/m/a.png', durationInFrames: 0 },
];

const item = (patch: Partial<TimelineItem> = {}): TimelineItem => ({
  id: 'a', track: 'V1', startFrame: 0, durationInFrames: 100,
  kind: 'video', name: 'a', src: '/m/a.mp4', ...patch,
} as TimelineItem);

const stateOf = (items: TimelineItem[]): TimelineState => ({
  fps: 30, width: 1920, height: 1080, selectedId: null,
  tracks: { V1: { kind: 'video' } }, trackOrder: ['V1'], items, assets,
});

// ── Transition pre-roll keeps the source position continuous at the cut ──
{
  const incoming = item({ srcInFrame: 1263 });
  assert.equal(sourceFrameAt(incoming, -15), 1248);
  assert.equal(sourceFrameAt(incoming, 0), 1263);
  assert.equal(sourceFrameAt(item({ srcInFrame: 100, playbackRate: 2 }), -15), 70);
  assert.equal(sourceFrameAt(item({ srcInFrame: 5 }), -15), 0, '源入点不足时不越过素材开头');
}

// ── One authoritative timeline/source conversion, including clamped pre-roll windows ──
{
  const fast = item({ srcInFrame: 10, playbackRate: 2 });
  assert.equal(timelineFramesToSourceFrames(fast, 25), 50);
  assert.equal(sourceFramesToTimelineFrames(fast, 50), 25);
  assert.deepEqual(sourceWindowForTimelineRange(fast, 5, 20), { startFrame: 20, endFrame: 60 });
  assert.deepEqual(
    sourceWindowForTimelineRange(item({ srcInFrame: 5, playbackRate: 0.5 }), -20, 30),
    { startFrame: 0, endFrame: 10 },
    'source windows clamp pre-roll at the asset head without changing the range endpoint',
  );
}

// ── Remaining source frames: How much is left after the entry point, variable speed timeline frame = source frame / rate conversion ──
{
  assert.equal(remainingSourceFrames(item(), 0, assets), 300);
  assert.equal(remainingSourceFrames(item(), 120, assets), 180, '入点吃掉的部分不算数');
  assert.equal(remainingSourceFrames(item({ playbackRate: 2 }), 0, assets), 150, '2 倍速时同样的源料只够一半时间线帧');
  assert.equal(remainingSourceFrames(item({ playbackRate: 0.5 }), 0, assets), 600, '慢放能撑更久');
  assert.equal(remainingSourceFrames(item(), 999, assets), 1, '入点越过尾部时至少留 1 帧,不返回 0/负数');
}

// ── If you can’t determine the length, don’t set a limit, so as not to lock something that can be stretched arbitrarily ──
{
  assert.equal(remainingSourceFrames(item({ kind: 'image', src: '/m/a.png' }), 0, assets), null, '图片可以任意拉长');
  assert.equal(remainingSourceFrames(item({ kind: 'motion-graphic', src: undefined }), 0, assets), null, 'MG 是生成的');
  assert.equal(remainingSourceFrames(item({ kind: 'text', src: undefined }), 0, assets), null);
  assert.equal(remainingSourceFrames(item({ src: '/m/missing.mp4' }), 0, assets), null, '素材表里没有就不猜');
  assert.equal(remainingSourceFrames(item(), 0, []), null);
  assert.equal(remainingSourceFrames(item(), 0, undefined), null);
  assert.equal(
    remainingSourceFrames(
      { kind: 'audio', src: '/m/a.wav', transcript: [{ text: 'hi', start: 0, end: 100 }] } as TimelineItem,
      0, assets,
    ),
    null,
    '词驱动音频由 retime 按编辑后词流收口,两套上界不能打架',
  );
}

// ── Jingzhen reduce: The right crop is blocked by the tail of the asset, and the freeze frame can no longer be pulled out──
{
  const before = stateOf([item({ durationInFrames: 100 })]);
  const stretched = reduce(before, { type: 'retime', id: 'a', durationInFrames: 5000 });
  assert.equal(stretched.items[0]!.durationInFrames, 300, '最多用满整条素材');

  const trimmed = reduce(before, { type: 'retime', id: 'a', durationInFrames: 5000, srcInFrame: 200 });
  assert.equal(trimmed.items[0]!.durationInFrames, 100, '左裁之后可用长度也跟着变短');

  const shorter = reduce(before, { type: 'retime', id: 'a', durationInFrames: 60 });
  assert.equal(shorter.items[0]!.durationInFrames, 60, '范围内的裁剪不受影响');
}

// ──Clips without asset information can still be lengthened (MG/template)──
{
  const mg = stateOf([item({ kind: 'motion-graphic', src: undefined, durationInFrames: 60 })]);
  assert.equal(reduce(mg, { type: 'retime', id: 'a', durationInFrames: 900 }).items[0]!.durationInFrames, 900);
}


// ── Variable-speed split advances source time by timeline delta × playbackRate ──
{
  const normal = reduce(
    stateOf([item({ srcInFrame: 10, durationInFrames: 100 })]),
    { type: 'split', id: 'a', atFrame: 25, newId: 'normal-right' },
  );
  assert.deepEqual(
    normal.items.find((clip) => clip.id === 'normal-right')?.srcInFrame,
    35,
    '1x split keeps the established source in-point behavior',
  );

  const fast = reduce(
    stateOf([item({ srcInFrame: 10, playbackRate: 2, durationInFrames: 100 })]),
    { type: 'split', id: 'a', atFrame: 25, newId: 'fast-right' },
  );
  const fastRight = fast.items.find((clip) => clip.id === 'fast-right')!;
  assert.deepEqual(
    [fastRight.startFrame, fastRight.durationInFrames, fastRight.srcInFrame],
    [25, 75, 60],
    '2x split resumes after 50 source frames while preserving the right timeline duration',
  );

  const slow = reduce(
    stateOf([item({ srcInFrame: 10, playbackRate: 0.5, durationInFrames: 100 })]),
    { type: 'split', id: 'a', atFrame: 25, newId: 'slow-right' },
  );
  const slowRight = slow.items.find((clip) => clip.id === 'slow-right')!;
  assert.deepEqual(
    [slowRight.startFrame, slowRight.durationInFrames, slowRight.srcInFrame],
    [25, 75, 22.5],
    '0.5x split preserves the fractional source boundary instead of skipping ahead',
  );
}
console.log('sourceLimit.verify: ok (剩余源帧换算/变速/不设限规则/真 reduce 右裁上界)');
