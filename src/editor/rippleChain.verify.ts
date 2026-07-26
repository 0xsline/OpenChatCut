// Runnable check: `npx tsx src/editor/rippleChain.verify.ts`.
// 验证变速波纹只推「紧贴着的那条连续链」:遇到用户特意留出的空隙就停,重叠算相接,
// 别的轨不受影响,并经真 reduce 确认加速/减速两个方向都对。
import assert from 'node:assert/strict';
import { contiguousFollowers, reduce } from './reduce';
import type { TimelineItem, TimelineState } from './types';

const clip = (id: string, startFrame: number, durationInFrames = 60, track = 'V1'): TimelineItem => ({
  id, track, startFrame, durationInFrames,
  kind: 'video', name: id, src: '/m/a.mp4',
} as TimelineItem);

const stateOf = (items: TimelineItem[]): TimelineState => ({
  fps: 30, width: 1920, height: 1080, selectedId: null,
  tracks: { V1: { kind: 'video' }, V2: { kind: 'video' } }, trackOrder: ['V1', 'V2'], items,
});

const starts = (s: TimelineState, track = 'V1') =>
  s.items.filter((it) => it.track === track).toSorted((a, b) => a.startFrame - b.startFrame).map((it) => it.startFrame);

// ── 连续链:从边界起首尾相接的一段,第一个空隙就是终点 ──
{
  const items = [clip('a', 0), clip('b', 60), clip('c', 120), clip('gap', 300), clip('after', 360)];
  assert.deepEqual([...contiguousFollowers(items, 'V1', 60)], ['b', 'c'], '空隙之后的不算在内');
  assert.deepEqual([...contiguousFollowers(items, 'V1', 360)], ['after']);
  assert.deepEqual([...contiguousFollowers(items, 'V1', 420)], [], '边界之后没有片段');
  assert.deepEqual([...contiguousFollowers(items, 'V2', 60)], [], '别的轨一个都不推');
}

// ── 重叠算相接(同轨允许覆盖摆放),链尾取最大右边缘 ──
{
  const overlapping = [clip('a', 0), clip('b', 30), clip('c', 60)];
  assert.deepEqual([...contiguousFollowers(overlapping, 'V1', 30)], ['b', 'c']);
}

// ── 经真 reduce:加速缩短 → 只有紧贴的邻居跟上来补空 ──
{
  const before = stateOf([clip('a', 0, 60), clip('b', 60), clip('c', 120), clip('far', 300)]);
  const after = reduce(before, { type: 'setSpeed', id: 'a', rate: 2 });
  assert.equal(after.items.find((it) => it.id === 'a')!.durationInFrames, 30);
  assert.deepEqual(starts(after), [0, 30, 90, 300], 'far 前面有空隙,不该被拖走');
}

// ── 减速拉长 → 同一条链往后让,空隙之后的仍然不动 ──
{
  const before = stateOf([clip('a', 0, 60), clip('b', 60), clip('far', 300)]);
  const after = reduce(before, { type: 'setSpeed', id: 'a', rate: 0.5 });
  assert.equal(after.items.find((it) => it.id === 'a')!.durationInFrames, 120);
  assert.deepEqual(starts(after), [0, 120, 300]);
}

// ── 目标后面直接就是空隙 → 链是空的,除了它自己谁都不动 ──
{
  const before = stateOf([clip('a', 0, 60), clip('far', 200), clip('tail', 260)]);
  const after = reduce(before, { type: 'setSpeed', id: 'a', rate: 2 });
  assert.equal(after.items.find((it) => it.id === 'a')!.durationInFrames, 30);
  assert.deepEqual(starts(after), [0, 200, 260], '空隙挡住波纹,后面整段都留在原地');
}

// ── 速率不变(时长没变)时谁都不动 ──
{
  const before = stateOf([clip('a', 0, 60), clip('b', 60)]);
  assert.deepEqual(starts(reduce(before, { type: 'setSpeed', id: 'a', rate: 1 })), [0, 60]);
}

console.log('rippleChain.verify: ok (连续链/重叠算相接/跨轨隔离/真 reduce 加速·减速·空链不动)');
