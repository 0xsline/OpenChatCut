// Runnable check: `npx tsx src/editor/snap.verify.ts`.
// 验证吸附的两条新规则:(1) 迟滞——吸住之后要走出 1.5 倍半径才松开,否则在边界上
// 会来回抖;(2) 按类型加权——播放头的吸附半径更大,等距时它赢。
import assert from 'node:assert/strict';
import {
  findClosestSnapPoint, snapDraggedEdges, sortTimelineSnapPoints, STICKY_RELEASE, type SnapPoint,
} from './snap';

const THRESHOLD = 4; // 帧
const base = { baseStart: 100, baseDuration: 50, points: [] as SnapPoint[], thresholdFrames: THRESHOLD };

// ── 加权:等距时播放头赢过片段边缘,且它的半径确实更宽 ──
{
  const points: SnapPoint[] = [
    { frame: 100, type: 'item-end', itemId: 'x' },
    { frame: 108, type: 'playhead' },
  ];
  assert.equal(findClosestSnapPoint(points, 104, THRESHOLD)?.type, 'playhead', '各差 4 帧时播放头优先');

  const farPlayhead: SnapPoint[] = [{ frame: 106, type: 'playhead' }];
  assert.equal(findClosestSnapPoint(farPlayhead, 100, THRESHOLD)?.type, 'playhead', '6 帧仍在播放头的 1.5 倍半径内');
  const farEdge: SnapPoint[] = [{ frame: 106, type: 'item-end', itemId: 'x' }];
  assert.equal(findClosestSnapPoint(farEdge, 100, THRESHOLD), null, '同样 6 帧,片段边缘已经够不着');
}

// ── 迟滞:吸住之后小幅移动仍然咬住同一帧 ──
{
  const points: SnapPoint[] = [{ frame: 120, type: 'item-start', itemId: 'x' }];
  const first = snapDraggedEdges({ ...base, points, mode: 'move', rawDelta: 18 }); // 探针 118
  assert.equal(first.snapAt, 120, '进入半径先吸住');
  assert.equal(first.deltaF, 20);
  assert.ok(first.hold);

  // 走到 5 帧外:没有迟滞就会松开(超过阈值 4),有迟滞则继续咬住(未过 4×1.5=6)
  const held = snapDraggedEdges({ ...base, points, mode: 'move', rawDelta: 25, hold: first.hold });
  assert.equal(held.snapAt, 120, '未走出释放半径,保持吸附');
  assert.equal(held.deltaF, 20);

  const released = snapDraggedEdges({ ...base, points, mode: 'move', rawDelta: 27, hold: first.hold });
  assert.equal(released.snapAt, null, '走出 1.5 倍半径后松开');
  assert.equal(released.deltaF, 27, '松开后回到原始位移');

  // 不传 hold = 老行为:同样的位移不会咬住
  const stateless = snapDraggedEdges({ ...base, points, mode: 'move', rawDelta: 25 });
  assert.equal(stateless.snapAt, null);
}

// ── 吸附目标消失(比如那个片段被删了)必须立刻松开,不能咬着幽灵 ──
{
  const hold = { frame: 120, edge: 'start' as const, type: 'item-start' as const };
  const gone = snapDraggedEdges({ ...base, points: [], mode: 'move', rawDelta: 21, hold });
  assert.equal(gone.snapAt, null);
  assert.equal(gone.deltaF, 21);
}

// ── hold 记住的是哪一条边:trim-left 不该沿用 move 时吸在尾边的记录 ──
{
  const points: SnapPoint[] = [{ frame: 155, type: 'item-start', itemId: 'x' }];
  const moved = snapDraggedEdges({ ...base, points, mode: 'move', rawDelta: 4 }); // 尾边探针 154
  assert.equal(moved.hold?.edge, 'end', 'move 时吸住的是尾边');
  const trimmed = snapDraggedEdges({ ...base, points, mode: 'trim-left', rawDelta: 4, hold: moved.hold });
  assert.equal(trimmed.snapAt, null, 'trim-left 只看头边,尾边的 hold 不适用');
}

// ── trim-right 只探尾边,并且照样有迟滞 ──
{
  const points: SnapPoint[] = [{ frame: 160, type: 'item-end', itemId: 'x' }];
  const first = snapDraggedEdges({ ...base, points, mode: 'trim-right', rawDelta: 8 }); // 尾边 158
  assert.equal(first.snapAt, 160);
  assert.equal(first.deltaF, 10);
  const held = snapDraggedEdges({ ...base, points, mode: 'trim-right', rawDelta: 15, hold: first.hold });
  assert.equal(held.snapAt, 160, `释放半径是 ${THRESHOLD * STICKY_RELEASE} 帧`);
}

// ── 完全没有目标时原样返回位移 ──
{
  const none = snapDraggedEdges({ ...base, points: [{ frame: 900, type: 'playhead' }], mode: 'move', rawDelta: 7 });
  assert.deepEqual([none.deltaF, none.snapAt, none.hold], [7, null, null]);
}

// ── Sorting + binary search is result-identical, including equal-distance tie order ──
{
  const points: SnapPoint[] = [
    { frame: 108, type: 'item-start', itemId: 'later-in-registry' },
    { frame: 92, type: 'item-end', itemId: 'earlier-in-registry' },
    { frame: 500, type: 'marker-start', markerId: 'far' },
  ];
  const probes = [88, 92, 96, 100, 104, 108, 112];
  const before = probes.map((frame) => findClosestSnapPoint(points, frame, 10));
  const sorted = sortTimelineSnapPoints(points);
  const after = probes.map((frame) => findClosestSnapPoint(sorted, frame, 10));
  assert.deepEqual(after, before, '排序后二分搜索必须保持相等距离与边界结果');
  assert.equal(findClosestSnapPoint(sorted, 100, 10)?.itemId, 'earlier-in-registry');
}

console.log('snap.verify: ok (类型加权/迟滞保持与释放/目标消失即松开/边归属/trim-right)');
