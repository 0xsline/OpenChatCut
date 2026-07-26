// Runnable check: `npx tsx src/editor/sourceLimit.verify.ts`.
// 验证「片段不能比源素材更长」:剩余源帧的换算(含变速)、哪些片段不设限
// (图片/MG/文字/词驱动音频),以及经真 reduce 确认右侧裁剪确实被这条上界挡住。
import assert from 'node:assert/strict';
import { remainingSourceFrames } from './sourceLimit';
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

// ── 剩余源帧:入点之后还剩多少,变速按 时间线帧 = 源帧 / rate 换算 ──
{
  assert.equal(remainingSourceFrames(item(), 0, assets), 300);
  assert.equal(remainingSourceFrames(item(), 120, assets), 180, '入点吃掉的部分不算数');
  assert.equal(remainingSourceFrames(item({ playbackRate: 2 }), 0, assets), 150, '2 倍速时同样的源料只够一半时间线帧');
  assert.equal(remainingSourceFrames(item({ playbackRate: 0.5 }), 0, assets), 600, '慢放能撑更久');
  assert.equal(remainingSourceFrames(item(), 999, assets), 1, '入点越过尾部时至少留 1 帧,不返回 0/负数');
}

// ── 判定不了长度就不设限,免得把本来可以随便拉长的东西锁死 ──
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

// ── 经真 reduce:右侧裁剪被素材尾部挡住,不再能拉出定格帧 ──
{
  const before = stateOf([item({ durationInFrames: 100 })]);
  const stretched = reduce(before, { type: 'retime', id: 'a', durationInFrames: 5000 });
  assert.equal(stretched.items[0]!.durationInFrames, 300, '最多用满整条素材');

  const trimmed = reduce(before, { type: 'retime', id: 'a', durationInFrames: 5000, srcInFrame: 200 });
  assert.equal(trimmed.items[0]!.durationInFrames, 100, '左裁之后可用长度也跟着变短');

  const shorter = reduce(before, { type: 'retime', id: 'a', durationInFrames: 60 });
  assert.equal(shorter.items[0]!.durationInFrames, 60, '范围内的裁剪不受影响');
}

// ── 没有素材信息的片段照旧可以随便拉长(MG/模板) ──
{
  const mg = stateOf([item({ kind: 'motion-graphic', src: undefined, durationInFrames: 60 })]);
  assert.equal(reduce(mg, { type: 'retime', id: 'a', durationInFrames: 900 }).items[0]!.durationInFrames, 900);
}

console.log('sourceLimit.verify: ok (剩余源帧换算/变速/不设限规则/真 reduce 右裁上界)');
