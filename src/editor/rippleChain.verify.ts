// Runnable check: `npx tsx src/editor/rippleChain.verify.ts`.
// Verify that the variable speed ripple only pushes the "closely connected continuous chain": it will stop when it encounters a gap specially left by the user, and the overlap will be counted as connected.
// Other tracks are not affected, and true reduce confirms that both acceleration/deceleration directions are correct.
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

// ── Continuous chain: a section starting from the boundary and connecting end to end, the first gap is the end point ──
{
  const items = [clip('a', 0), clip('b', 60), clip('c', 120), clip('gap', 300), clip('after', 360)];
  assert.deepEqual([...contiguousFollowers(items, 'V1', 60)], ['b', 'c'], '空隙之后的不算在内');
  assert.deepEqual([...contiguousFollowers(items, 'V1', 360)], ['after']);
  assert.deepEqual([...contiguousFollowers(items, 'V1', 420)], [], '边界之后没有片段');
  assert.deepEqual([...contiguousFollowers(items, 'V2', 60)], [], '别的轨一个都不推');
}

// ── Overlap is considered to be connected (overlapping placement is allowed on the same track), and the largest right edge is taken at the end of the chain ──
{
  const overlapping = [clip('a', 0), clip('b', 30), clip('c', 60)];
  assert.deepEqual([...contiguousFollowers(overlapping, 'V1', 30)], ['b', 'c']);
}

// ── Jingzhen reduce: accelerate shortening → only close neighbors can catch up to fill the gap ──
{
  const before = stateOf([clip('a', 0, 60), clip('b', 60), clip('c', 120), clip('far', 300)]);
  const after = reduce(before, { type: 'setSpeed', id: 'a', rate: 2 });
  assert.equal(after.items.find((it) => it.id === 'a')!.durationInFrames, 30);
  assert.deepEqual(starts(after), [0, 30, 90, 300], 'far 前面有空隙,不该被拖走');
}

// ── Slow down and lengthen → The same chain moves backward, and the one behind the gap remains still ──
{
  const before = stateOf([clip('a', 0, 60), clip('b', 60), clip('far', 300)]);
  const after = reduce(before, { type: 'setSpeed', id: 'a', rate: 0.5 });
  assert.equal(after.items.find((it) => it.id === 'a')!.durationInFrames, 120);
  assert.deepEqual(starts(after), [0, 120, 300]);
}

// ── There is a gap directly behind the target → the chain is empty, no one can move except itself ──
{
  const before = stateOf([clip('a', 0, 60), clip('far', 200), clip('tail', 260)]);
  const after = reduce(before, { type: 'setSpeed', id: 'a', rate: 2 });
  assert.equal(after.items.find((it) => it.id === 'a')!.durationInFrames, 30);
  assert.deepEqual(starts(after), [0, 200, 260], '空隙挡住波纹,后面整段都留在原地');
}

// ──No one moves when the speed remains unchanged (the duration does not change)──
{
  const before = stateOf([clip('a', 0, 60), clip('b', 60)]);
  assert.deepEqual(starts(reduce(before, { type: 'setSpeed', id: 'a', rate: 1 })), [0, 60]);
}

console.log('rippleChain.verify: ok (连续链/重叠算相接/跨轨隔离/真 reduce 加速·减速·空链不动)');
