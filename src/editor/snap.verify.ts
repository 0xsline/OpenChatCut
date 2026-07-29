// Runnable check: `npx tsx src/editor/snap.verify.ts`.
// Two new rules for verifying adsorption: (1) Hysteresis - after being sucked, you have to go out of 1.5 times the radius before releasing, otherwise it will be on the boundary
// It will shake back and forth; (2) Weighted by type - the adsorption radius of the play head is larger, and it wins when it is equidistant.
import assert from 'node:assert/strict';
import { findClosestSnapPoint, snapDraggedEdges, STICKY_RELEASE, type SnapPoint } from './snap';

const THRESHOLD = 4; // frame
const base = { baseStart: 100, baseDuration: 50, points: [] as SnapPoint[], thresholdFrames: THRESHOLD };

// ── Weighted: When isometric the playhead wins over the edge of the clip, and its radius is indeed wider ──
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

// ── Hysteresis: Move slightly after sucking and still bite the same frame ──
{
  const points: SnapPoint[] = [{ frame: 120, type: 'item-start', itemId: 'x' }];
  const first = snapDraggedEdges({ ...base, points, mode: 'move', rawDelta: 18 }); // Probe 118
  assert.equal(first.snapAt, 120, '进入半径先吸住');
  assert.equal(first.deltaF, 20);
  assert.ok(first.hold);

  // Go outside 5 frames: if there is no hysteresis, it will be released (exceeding the threshold 4), if there is hysteresis, it will continue to bite (but not past 4×1.5=6)
  const held = snapDraggedEdges({ ...base, points, mode: 'move', rawDelta: 25, hold: first.hold });
  assert.equal(held.snapAt, 120, '未走出释放半径,保持吸附');
  assert.equal(held.deltaF, 20);

  const released = snapDraggedEdges({ ...base, points, mode: 'move', rawDelta: 27, hold: first.hold });
  assert.equal(released.snapAt, null, '走出 1.5 倍半径后松开');
  assert.equal(released.deltaF, 27, '松开后回到原始位移');

  // Do not pass hold = old behavior: the same displacement will not bite
  const stateless = snapDraggedEdges({ ...base, points, mode: 'move', rawDelta: 25 });
  assert.equal(stateless.snapAt, null);
}

// ── If the adsorption target disappears (for example, the clip is deleted), you must release it immediately, and you cannot bite the ghost ──
{
  const hold = { frame: 120, edge: 'start' as const, type: 'item-start' as const };
  const gone = snapDraggedEdges({ ...base, points: [], mode: 'move', rawDelta: 21, hold });
  assert.equal(gone.snapAt, null);
  assert.equal(gone.deltaF, 21);
}

// ── Hold remembers which side: trim-left should not inherit the record that is sucked at the end when move ──
{
  const points: SnapPoint[] = [{ frame: 155, type: 'item-start', itemId: 'x' }];
  const moved = snapDraggedEdges({ ...base, points, mode: 'move', rawDelta: 4 }); // Tail edge probe 154
  assert.equal(moved.hold?.edge, 'end', 'move 时吸住的是尾边');
  const trimmed = snapDraggedEdges({ ...base, points, mode: 'trim-left', rawDelta: 4, hold: moved.hold });
  assert.equal(trimmed.snapAt, null, 'trim-left 只看头边,尾边的 hold 不适用');
}

// ── trim-right only detects the tail edge, and there is still hysteresis ──
{
  const points: SnapPoint[] = [{ frame: 160, type: 'item-end', itemId: 'x' }];
  const first = snapDraggedEdges({ ...base, points, mode: 'trim-right', rawDelta: 8 }); // tail edge 158
  assert.equal(first.snapAt, 160);
  assert.equal(first.deltaF, 10);
  const held = snapDraggedEdges({ ...base, points, mode: 'trim-right', rawDelta: 15, hold: first.hold });
  assert.equal(held.snapAt, 160, `释放半径是 ${THRESHOLD * STICKY_RELEASE} 帧`);
}

// ── When there is no target at all, the displacement is returned ──
{
  const none = snapDraggedEdges({ ...base, points: [{ frame: 900, type: 'playhead' }], mode: 'move', rawDelta: 7 });
  assert.deepEqual([none.deltaF, none.snapAt, none.hold], [7, null, null]);
}

console.log('snap.verify: ok (类型加权/迟滞保持与释放/目标消失即松开/边归属/trim-right)');
