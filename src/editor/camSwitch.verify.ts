// Runnable check: `npx tsx src/editor/camSwitch.verify.ts`.
// Verification: Geometric results of the change_cam planner through the real reducer (border double cut/edge single cut/entire segment deletion/
// Non-intersecting zero action), srcInFrame forward, no ripple (other rails don't move), coverage gap calculation, and
// Tool layer execChangeCam's boundary verification, multi-segment target from the same source, and single batch submission.
import assert from 'node:assert/strict';
import { coveredFrames, planCamSwitch } from './camSwitch';
import { reduce, type Action, type AtomicAction } from './reduce';
import type { TimelineItem, TimelineState } from './types';
import { execChangeCam } from '../agent/tools/multicam-tools';

let seq = 0;
const makeId = (): string => `seg_${++seq}`;
const clip = (id: string, track: string, startFrame: number, dur: number, src: string, patch: Partial<TimelineItem> = {}): TimelineItem =>
  ({ id, track, startFrame, durationInFrames: dur, kind: 'video', name: id, src, ...patch } as TimelineItem);

const baseState = (): TimelineState => ({
  fps: 30, width: 1920, height: 1080, selectedId: null,
  tracks: { V1: { kind: 'video' }, V2: { kind: 'video' }, V3: { kind: 'video' }, A1: { kind: 'audio' } },
  trackOrder: ['V1', 'V2', 'V3', 'A1'],
  items: [
    clip('camA', 'V1', 0, 300, '/m/a.mp4'),
    clip('camB', 'V2', 0, 300, '/m/b.mp4', { keyframes: { opacity: [{ frame: 0, value: 1 }, { frame: 299, value: 0.2 }] } }),
    clip('camC', 'V3', 0, 300, '/m/c.mp4'),
    { id: 'mix', track: 'A1', startFrame: 0, durationInFrames: 300, kind: 'audio', name: 'mix', src: '/m/mix.wav' } as TimelineItem,
  ],
});

const applyPlan = (s: TimelineState, actions: Action[]): TimelineState => actions.reduce(reduce, s);
const spansOf = (s: TimelineState, src: string) => s.items
  .filter((it) => it.src === src)
  .map((it) => [it.startFrame, it.startFrame + it.durationInFrames])
  .sort((a, b) => a[0] - b[0]);

// ── 1. The interval is in the middle: other camera positions are double-cut and deleted, leaving [0,60)+[150,300), srcIn is moved forward by 150 ──
{
  const s0 = baseState();
  const plan = planCamSwitch([s0.items[0]], [s0.items[1], s0.items[2]], 60, 150, makeId);
  assert.equal(plan.actions.length, 6, '两机位各 2 切 1 删');
  assert.equal(plan.coverageGapFrames, 0, '目标全覆盖无缺口');
  const s1 = applyPlan(s0, plan.actions);
  assert.deepEqual(spansOf(s1, '/m/b.mp4'), [[0, 60], [150, 300]], 'camB 剩两段');
  assert.deepEqual(spansOf(s1, '/m/c.mp4'), [[0, 60], [150, 300]], 'camC 剩两段');
  assert.deepEqual(spansOf(s1, '/m/a.mp4'), [[0, 300]], '目标机位不动');
  const bTail = s1.items.find((it) => it.src === '/m/b.mp4' && it.startFrame === 150)!;
  assert.equal(bTail.srcInFrame ?? 0, 150, '尾段源点前移到切点');
  const bHead = s1.items.find((it) => it.src === '/m/b.mp4' && it.startFrame === 0)!;
  assert.ok(bHead.keyframes?.opacity?.length && bTail.keyframes?.opacity?.length, '关键帧随 split 分段保留');
  const mix = s1.items.find((it) => it.id === 'mix')!;
  assert.equal(`${mix.startFrame}:${mix.durationInFrames}`, '0:300', '音频轨完全不动(无波纹)');
}

// ── 2. Interval pasting clip header: single cut right boundary, delete [0,150) ──
{
  const s0 = baseState();
  const plan = planCamSwitch([s0.items[0]], [s0.items[1]], 0, 150, makeId);
  assert.equal(plan.actions.length, 2, '1 切 1 删');
  assert.deepEqual(spansOf(applyPlan(s0, plan.actions), '/m/b.mp4'), [[150, 300]], '仅剩尾段');
}

// ── 3. The interval is full clip: zero cut and whole deletion ──
{
  const s0 = baseState();
  const plan = planCamSwitch([s0.items[0]], [s0.items[1]], 0, 300, makeId);
  assert.deepEqual(plan.actions.map((a) => a.type), ['remove'], '整段直接删');
  assert.deepEqual(spansOf(applyPlan(s0, plan.actions), '/m/b.mp4'), [], 'camB 清空');
}

// ── 4. Disjoint: zero action; coverage gap is counted in frames ──
{
  const s0 = baseState();
  const far = clip('camD', 'V3', 500, 100, '/m/d.mp4');
  assert.equal(planCamSwitch([s0.items[0]], [far], 60, 150, makeId).actions.length, 0, '区间外零动作');
  const shortTarget = clip('camA2', 'V1', 0, 100, '/m/a.mp4');
  const plan = planCamSwitch([shortTarget], [s0.items[1]], 60, 200, makeId);
  assert.equal(plan.coverageGapFrames, 100, '目标只盖 40 帧,缺 100 帧');
  assert.equal(coveredFrames([shortTarget], 60, 200), 40, 'coveredFrames 计数');
}

// ── 5. Tool layer: single batch submission + geometric consistency; multiple segments from the same source are considered targets ──
{
  let s = baseState();
  let batches = 0;
  const ctx = {
    getState: () => s,
    commands: { batch: (actions: AtomicAction[]) => { batches++; s = actions.reduce((st, a) => reduce(st, a as Action), s); } },
  } as unknown as Parameters<typeof execChangeCam>[1];
  const r = execChangeCam({ itemIds: ['camA', 'camB', 'camC'], targetItemId: 'camA', fromSeconds: 2, toSeconds: 5 }, ctx) as Record<string, unknown>;
  assert.equal(r.error, undefined, `no error (got ${String(r.error)})`);
  assert.equal(batches, 1, '恰好一次 batch(一步撤销)');
  assert.deepEqual(spansOf(s, '/m/b.mp4'), [[0, 60], [150, 300]], '工具层几何与规划器一致');
  assert.equal((r.removedSegments as unknown[]).length, 2, '报告两段移除');

  // The second cut: camB has been divided into two segments, and only the current segment id is listed; the target homologous segment will not be accidentally deleted.
  const bSegs = s.items.filter((it) => it.src === '/m/b.mp4').map((it) => it.id);
  const r2 = execChangeCam({ itemIds: ['camA', ...bSegs], targetItemId: 'camA', fromSeconds: 6, toSeconds: 8 }, ctx) as Record<string, unknown>;
  assert.equal(r2.error, undefined, 'second switch ok');
  assert.deepEqual(spansOf(s, '/m/b.mp4'), [[0, 60], [150, 180], [240, 300]], '第二刀再挖掉 [180,240)');
  assert.deepEqual(spansOf(s, '/m/a.mp4'), [[0, 300]], '目标仍完整');
}

// ── 6. Boundary check: each error path ──
{
  const s0 = baseState();
  const ctx = { getState: () => s0, commands: { batch: () => { throw new Error('must not commit'); } } } as unknown as Parameters<typeof execChangeCam>[1];
  const err = (args: Record<string, unknown>) => (execChangeCam(args, ctx) as { error?: string }).error ?? '';
  assert.match(err({ itemIds: ['camA'], targetItemId: 'camA', fromSeconds: 0 }), /at least 2/, '少于 2 个机位');
  assert.match(err({ itemIds: ['camA', 'nope'], targetItemId: 'camA', fromSeconds: 0 }), /not found/, '未知 id');
  assert.match(err({ itemIds: ['camA', 'mix'], targetItemId: 'camA', fromSeconds: 0 }), /must be video/, '非视频机位');
  assert.match(err({ itemIds: ['camA', 'camB'], targetItemId: 'camC', fromSeconds: 0 }), /must be one of/, '目标不在组内');
  assert.match(err({ itemIds: ['camA', 'camB'], targetItemId: 'camA', fromSeconds: -1 }), /fromSeconds/, '负起点');
  assert.match(err({ itemIds: ['camA', 'camB'], targetItemId: 'camA', fromSeconds: 5, toSeconds: 5 }), /empty switch range/, '空区间');
  const shortA = { ...s0, items: s0.items.map((it) => (it.id === 'camA' ? { ...it, durationInFrames: 30 } : it)) };
  const ctx2 = { getState: () => shortA, commands: { batch: () => { throw new Error('must not commit'); } } } as unknown as Parameters<typeof execChangeCam>[1];
  assert.match((execChangeCam({ itemIds: ['camA', 'camB'], targetItemId: 'camA', fromSeconds: 5, toSeconds: 8 }, ctx2) as { error?: string }).error ?? '', /no clip in the switch range/, '目标零覆盖拒绝');
  const locked = { ...s0, tracks: { ...s0.tracks, V2: { kind: 'video' as const, locked: true } } };
  const ctx3 = { getState: () => locked, commands: { batch: () => { throw new Error('must not commit'); } } } as unknown as Parameters<typeof execChangeCam>[1];
  assert.match((execChangeCam({ itemIds: ['camA', 'camB'], targetItemId: 'camA', fromSeconds: 0, toSeconds: 2 }, ctx3) as { error?: string }).error ?? '', /locked/, '锁轨拒绝');
}

// ── 7. Multiple segments from the same source: The remaining segments of the target camera will not be deleted as "other cameras" and will be included in the coverage together ──
{
  let s: TimelineState = {
    fps: 30, width: 1920, height: 1080, selectedId: null,
    tracks: { V1: { kind: 'video' }, V2: { kind: 'video' } }, trackOrder: ['V1', 'V2'],
    items: [
      clip('a1', 'V1', 0, 100, '/m/a.mp4'),
      clip('a2', 'V1', 100, 200, '/m/a.mp4', { srcInFrame: 100 }),
      clip('camB', 'V2', 0, 300, '/m/b.mp4'),
    ],
  };
  const ctx = {
    getState: () => s,
    commands: { batch: (actions: AtomicAction[]) => { s = actions.reduce((st, a) => reduce(st, a as Action), s); } },
  } as unknown as Parameters<typeof execChangeCam>[1];
  const r = execChangeCam({ itemIds: ['a1', 'a2', 'camB'], targetItemId: 'a1', fromSeconds: 2, toSeconds: 6 }, ctx) as Record<string, unknown>;
  assert.equal(r.error, undefined, 'same-src switch ok');
  assert.deepEqual(spansOf(s, '/m/a.mp4'), [[0, 100], [100, 300]], '目标同源段全部保留');
  assert.deepEqual(spansOf(s, '/m/b.mp4'), [[0, 60], [180, 300]], 'camB 挖掉 [60,180)');
  assert.equal(r.coverageGapSeconds, 0, '跨段覆盖无缺口');
}

console.log('camSwitch.verify: all assertions passed');
