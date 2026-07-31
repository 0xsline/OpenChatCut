// Runnable check: `npx tsx src/editor/clipFit.verify.ts`.
// Verify the self-healing of duration-derived data: fading on both sides does not overlap, the side that was changed when setFade gives way, and key frames are truncated
// Keep "the still rendered frame sample value is completely unchanged" and confirm with true reduce retime/setSpeed/split
// No out-of-bounds fades or keyframes will be left after changing the duration.
import assert from 'node:assert/strict';
import { capFade, fitItemToDuration, fitKeyframes, truncateKeyframes } from './clipFit';
import { sampleKeyframes } from './keyframes';
import { reduce } from './reduce';
import { migrateProjectDoc } from '../persist/projectStore';
import type { Keyframe, TimelineItem, TimelineState } from './types';

const item = (patch: Partial<TimelineItem> = {}): TimelineItem => ({
  id: 'a', track: 'V1', startFrame: 0, durationInFrames: 100,
  kind: 'video', name: 'a', src: '/m/a.mp4', ...patch,
} as TimelineItem);

const stateOf = (items: TimelineItem[]): TimelineState => ({
  fps: 30, width: 1920, height: 1080, selectedId: null,
  tracks: { V1: { kind: 'video' } }, trackOrder: ['V1'], items,
});

// ── capFade: Negative numbers are returned to zero, room is given away, undefined remains unset ──
{
  assert.equal(capFade(undefined, 100), undefined, '没设过就保持没设');
  assert.equal(capFade(-5, 100), 0);
  assert.equal(capFade(90, 100), 90);
  assert.equal(capFade(90, 10), 10, '只能吃掉对侧让出来的空间');
  assert.equal(capFade(90, -20), 0, 'room 为负时归零');
}

// ── Core flaw: The sum of the fades on both sides cannot exceed the length of the clip ──
{
  const broken = fitItemToDuration(item({ durationInFrames: 100, fadeInFrames: 90, fadeOutFrames: 90 }));
  assert.equal(broken.fadeInFrames, 90);
  assert.equal(broken.fadeOutFrames, 10, '淡出让位,合计正好等于时长');
  assert.ok((broken.fadeInFrames ?? 0) + (broken.fadeOutFrames ?? 0) <= 100);

  const legal = item({ fadeInFrames: 10, fadeOutFrames: 10 });
  assert.equal(fitItemToDuration(legal), legal, '本来就合法时返回原对象(不触发多余重渲染)');
}

// ── Keyframe truncation: Each frame that is still rendered must have the same sample value ──
{
  const kfs: Keyframe[] = [
    { frame: 0, value: 0, easing: 'easeInOut' },
    { frame: 40, value: 100, easing: [0.2, 0.9, 0.4, 1] },
    { frame: 90, value: 20 },
  ];
  const last = 49; // Reduce duration to 50
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

  // Extreme case of 1 frame duration: leaving a 0-frame keyframe, neither exploding nor clearing
  assert.deepEqual(truncateKeyframes(kfs, 0).map((k) => k.frame), [0]);
}

// ── After using reduce:retime to shorten the clip, the fade and keyframes are pressed back together ──
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

// ── It is true that reduce:setSpeed ​​also heals itself after acceleration ──
{
  const before = stateOf([item({ durationInFrames: 100, fadeInFrames: 40, fadeOutFrames: 40 })]);
  const it = reduce(before, { type: 'setSpeed', id: 'a', rate: 4 }).items[0]!;
  assert.equal(it.durationInFrames, 25);
  assert.ok((it.fadeInFrames ?? 0) + (it.fadeOutFrames ?? 0) <= 25, '4 倍速后 40+40 帧淡化必须收回来');
}

// ── The outer fade of the last two halves of Jingzhen reduce:split cannot exceed their respective lengths ──
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

// ── setFade: The side that has been explicitly changed gives way, and the side that has not been moved remains unchanged ──
{
  const before = stateOf([item({ durationInFrames: 100, fadeInFrames: 0, fadeOutFrames: 90 })]);
  const it = reduce(before, { type: 'setFade', id: 'a', fadeInFrames: 90 }).items[0]!;
  assert.equal(it.fadeOutFrames, 90, '只调淡入不该把用户原有的淡出砍短');
  assert.equal(it.fadeInFrames, 10, '被改的一侧吃剩下的空间');

  const both = reduce(before, { type: 'setFade', id: 'a', fadeInFrames: 70, fadeOutFrames: 70 }).items[0]!;
  assert.deepEqual([both.fadeInFrames, both.fadeOutFrames], [70, 30], '两侧同时给出时淡入优先');
}

// ── Self-healing is also required when loading the project: reduce is only reached when there is an action, and illegal values ​​cannot wait for the user to move first ──
{
  const legacy = {
    version: 3, assets: [], mediaFolders: [], activeTimelineId: 'tl1',
    timelines: [{
      id: 'tl1', name: 'main', order: 0, fps: 30, width: 1920, height: 1080, selectedId: null,
      tracks: { V1: { kind: 'video' as const } }, trackOrder: ['V1'],
      items: [item({ durationInFrames: 100, fadeInFrames: 90, fadeOutFrames: 90 })],
    }],
  };
  const healed = migrateProjectDoc(legacy);
  assert.ok(healed, '合法工程仍能通过迁移');
  const it = healed!.timelines[0]!.items[0]!;
  assert.ok(
    (it.fadeInFrames ?? 0) + (it.fadeOutFrames ?? 0) <= 100,
    `加载后仍越界: ${it.fadeInFrames}+${it.fadeOutFrames}(整段会一直是暗的)`,
  );
}

console.log('clipFit.verify: ok (淡化联合钳位/被改侧让位/关键帧截断采样不变/真 reduce retime·setSpeed·split/加载自愈)');
