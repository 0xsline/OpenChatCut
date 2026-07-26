// Runnable check: `npx tsx src/editor/clipFit.verify.ts`.
// 验证时长派生数据的自愈:两侧淡化不重叠、setFade 时被改的一侧让位、关键帧截断
// 保持"仍然渲染得到的帧采样值完全不变",并经真 reduce 确认 retime/setSpeed/split
// 改完时长后不会留下越界的淡化或关键帧。
import assert from 'node:assert/strict';
import { capFade, fitItemToDuration, fitKeyframes, truncateKeyframes } from './clipFit';
import { sampleKeyframes } from './keyframes';
import { reduce } from './reduce';
import type { Keyframe, TimelineItem, TimelineState } from './types';

const item = (patch: Partial<TimelineItem> = {}): TimelineItem => ({
  id: 'a', track: 'V1', startFrame: 0, durationInFrames: 100,
  kind: 'video', name: 'a', src: '/m/a.mp4', ...patch,
} as TimelineItem);

const stateOf = (items: TimelineItem[]): TimelineState => ({
  fps: 30, width: 1920, height: 1080, selectedId: null,
  tracks: { V1: { kind: 'video' } }, trackOrder: ['V1'], items,
});

// ── capFade:负数归零、让出 room、undefined 保持不设 ──
{
  assert.equal(capFade(undefined, 100), undefined, '没设过就保持没设');
  assert.equal(capFade(-5, 100), 0);
  assert.equal(capFade(90, 100), 90);
  assert.equal(capFade(90, 10), 10, '只能吃掉对侧让出来的空间');
  assert.equal(capFade(90, -20), 0, 'room 为负时归零');
}

// ── 核心缺陷:两侧淡化加起来不能超过片段长度 ──
{
  const broken = fitItemToDuration(item({ durationInFrames: 100, fadeInFrames: 90, fadeOutFrames: 90 }));
  assert.equal(broken.fadeInFrames, 90);
  assert.equal(broken.fadeOutFrames, 10, '淡出让位,合计正好等于时长');
  assert.ok((broken.fadeInFrames ?? 0) + (broken.fadeOutFrames ?? 0) <= 100);

  const legal = item({ fadeInFrames: 10, fadeOutFrames: 10 });
  assert.equal(fitItemToDuration(legal), legal, '本来就合法时返回原对象(不触发多余重渲染)');
}

// ── 关键帧截断:每个仍渲染得到的帧,采样值必须一模一样 ──
{
  const kfs: Keyframe[] = [
    { frame: 0, value: 0, easing: 'easeInOut' },
    { frame: 40, value: 100, easing: [0.2, 0.9, 0.4, 1] },
    { frame: 90, value: 20 },
  ];
  const last = 49; // 时长缩到 50
  const cut = truncateKeyframes(kfs, last);
  assert.ok(cut[cut.length - 1]!.frame <= last, '没有关键帧落在最后一帧之后');
  for (let f = 0; f <= last; f += 1) {
    assert.ok(
      Math.abs(sampleKeyframes(cut, f) - sampleKeyframes(kfs, f)) < 1e-6,
      `第 ${f} 帧采样值必须不变(直接丢尾巴会让曲线提前停住)`,
    );
  }
  assert.equal(truncateKeyframes(kfs, 200), kfs, '已经在范围内时原样返回');

  const ik = { opacity: kfs, scale: [{ frame: 0, value: 1 }] as Keyframe[] };
  assert.equal(fitKeyframes(ik, 200), ik, '全部在范围内则整个对象原样返回');
  const trimmed = fitKeyframes(ik, last)!;
  assert.notEqual(trimmed, ik);
  assert.deepEqual(trimmed.scale, ik.scale, '没越界的属性不动');
  assert.equal(fitKeyframes(undefined, 10), undefined);

  // 时长 1 帧的极端情况:留下一个 0 帧关键帧,不炸也不清空
  assert.deepEqual(truncateKeyframes(kfs, 0).map((k) => k.frame), [0]);
}

// ── 经真 reduce:retime 缩短片段后,淡化与关键帧一起被压回来 ──
{
  const before = stateOf([item({
    durationInFrames: 100, fadeInFrames: 30, fadeOutFrames: 60,
    keyframes: { opacity: [{ frame: 0, value: 0 }, { frame: 95, value: 1 }] },
  })]);
  const after = reduce(before, { type: 'retime', id: 'a', durationInFrames: 20 });
  const it = after.items[0]!;
  assert.equal(it.durationInFrames, 20);
  assert.ok((it.fadeInFrames ?? 0) + (it.fadeOutFrames ?? 0) <= 20, `缩短后淡化仍越界: ${it.fadeInFrames}+${it.fadeOutFrames}`);
  assert.ok((it.keyframes?.opacity ?? []).every((k) => k.frame <= 19), '没有渲染不到的关键帧');
}

// ── 经真 reduce:setSpeed 加速后同样自愈 ──
{
  const before = stateOf([item({ durationInFrames: 100, fadeInFrames: 40, fadeOutFrames: 40 })]);
  const it = reduce(before, { type: 'setSpeed', id: 'a', rate: 4 }).items[0]!;
  assert.equal(it.durationInFrames, 25);
  assert.ok((it.fadeInFrames ?? 0) + (it.fadeOutFrames ?? 0) <= 25, '4 倍速后 40+40 帧淡化必须收回来');
}

// ── 经真 reduce:split 后两个半段的外侧淡化也不能超过各自长度 ──
{
  const before = stateOf([item({ durationInFrames: 100, fadeInFrames: 80, fadeOutFrames: 80 })]);
  const halves = reduce(before, { type: 'split', id: 'a', atFrame: 30, newId: 'b' }).items;
  assert.equal(halves.length, 2);
  for (const half of halves) {
    assert.ok(
      (half.fadeInFrames ?? 0) + (half.fadeOutFrames ?? 0) <= half.durationInFrames,
      `${half.id} 的淡化超过了它自己的 ${half.durationInFrames} 帧`,
    );
  }
}

// ── setFade:被显式改的那一侧让位,没动的一侧原样保留 ──
{
  const before = stateOf([item({ durationInFrames: 100, fadeInFrames: 0, fadeOutFrames: 90 })]);
  const it = reduce(before, { type: 'setFade', id: 'a', fadeInFrames: 90 }).items[0]!;
  assert.equal(it.fadeOutFrames, 90, '只调淡入不该把用户原有的淡出砍短');
  assert.equal(it.fadeInFrames, 10, '被改的一侧吃剩下的空间');

  const both = reduce(before, { type: 'setFade', id: 'a', fadeInFrames: 70, fadeOutFrames: 70 }).items[0]!;
  assert.deepEqual([both.fadeInFrames, both.fadeOutFrames], [70, 30], '两侧同时给出时淡入优先');
}

console.log('clipFit.verify: ok (淡化联合钳位/被改侧让位/关键帧截断采样不变/真 reduce retime·setSpeed·split)');
