// Runnable check: `npx tsx src/agent/timelineDelta.verify.ts`.
// 验证工具差分:只读无差分、新建/换轨/改长度进 clips、波纹整体位移压成规则、
// 零星位移退回枚举、删除与新轨上报、30 条上限提示,并经真 reducer 走一遍波纹删除。
import assert from 'node:assert/strict';
import { describeTimelineDelta, snapshotTimeline } from './timelineDelta';
import { reduce } from '../editor/reduce';
import type { TimelineItem, TimelineState } from '../editor/types';

const clip = (id: string, track: string, startFrame: number, dur = 30): TimelineItem =>
  ({ id, track, startFrame, durationInFrames: dur, kind: 'video', name: id, src: `/m/${id}.mp4` } as TimelineItem);

// 原始轨道 id 故意不叫 V1/V2:别名由位置推导(视频轨自下而上 V1..Vn),
// 用同名会把「原始 id」和「别名」搅在一起。trackOrder 自上而下。
const TRACKS = { 'trk-upper': { kind: 'video' as const }, 'trk-lower': { kind: 'video' as const } };
const stateOf = (items: TimelineItem[], tracks: Record<string, { kind: 'video' | 'audio' }> = TRACKS): TimelineState => ({
  fps: 30, width: 1920, height: 1080, selectedId: null,
  tracks,
  trackOrder: Object.keys(tracks),
  items,
});

// ── 只读:状态没动 → null(不给结果加任何字段) ──
{
  const s = stateOf([clip('a', 'trk-lower', 0), clip('b', 'trk-lower', 30)]);
  assert.equal(describeTimelineDelta(snapshotTimeline(s), s), null, '无变化不产出差分');
}

// ── 新建 / 换轨 / 改长度 → 逐条进 clips ──
{
  const before = snapshotTimeline(stateOf([clip('a', 'trk-lower', 0), clip('b', 'trk-lower', 30)]));
  const after = stateOf([
    { ...clip('a', 'trk-lower', 0), durationInFrames: 45 } as TimelineItem, // 改长度
    clip('b', 'trk-upper', 30),                                             // 换轨
    clip('c', 'trk-lower', 90),                                             // 新建
  ]);
  const d = describeTimelineDelta(before, after)!;
  assert.equal(d.clips?.length, 3, '三类变更都进 clips');
  assert.deepEqual(d.clips?.map((c) => c.id).sort(), ['a', 'b', 'c']);
  assert.equal(d.shifted, undefined, '这些都不是纯位移');
  const a = d.clips!.find((c) => c.id === 'a')!;
  assert.equal(a.durationInFrames, 45, 'clips 带新状态而不是旧状态');
  assert.equal(a.track, 'V1', 'track 报别名(最下方视频轨 = V1),与 read_project 一致');
}

// ── 波纹:同轨同位移量 ≥3 → 压成一条规则,不逐条列 ──
{
  const items = [clip('a', 'trk-lower', 0), clip('b', 'trk-lower', 30), clip('c', 'trk-lower', 60), clip('d', 'trk-lower', 90), clip('e', 'trk-lower', 120)];
  const before = snapshotTimeline(stateOf(items));
  // 删掉 a,后面 4 个各左移 30
  const after = stateOf(items.slice(1).map((it) => ({ ...it, startFrame: it.startFrame - 30 })));
  const d = describeTimelineDelta(before, after)!;
  assert.equal(d.clips, undefined, '纯位移不进 clips');
  assert.deepEqual(d.shifted, [{ track: 'V1', fromFrame: 30, by: -30, count: 4 }], '压成一条规则');
  assert.deepEqual(d.removedItemIds, ['a'], '删除单独上报');
}

// ── 零星位移(<3)→ 退回逐条枚举,不压规则 ──
{
  const items = [clip('a', 'trk-lower', 0), clip('b', 'trk-lower', 30), clip('c', 'trk-lower', 60)];
  const before = snapshotTimeline(stateOf(items));
  const after = stateOf([items[0]!, { ...items[1]!, startFrame: 40 }, { ...items[2]!, startFrame: 70 }]);
  const d = describeTimelineDelta(before, after)!;
  assert.equal(d.shifted, undefined, '2 个不压规则');
  assert.deepEqual(d.clips?.map((c) => c.id), ['b', 'c'], '逐条列出');
}

// ── 不同轨/不同位移量各自成组 ──
{
  const items = [
    ...[0, 30, 60].map((f, i) => clip(`v${i}`, 'trk-lower', f)),
    ...[0, 30, 60].map((f, i) => clip(`w${i}`, 'trk-upper', f)),
  ];
  const before = snapshotTimeline(stateOf(items));
  const after = stateOf(items.map((it) => ({
    ...it, startFrame: it.startFrame + (it.track === 'trk-lower' ? 10 : 20),
  })));
  const d = describeTimelineDelta(before, after)!;
  assert.equal(d.shifted?.length, 2, '两轨两条规则');
  assert.deepEqual(d.shifted?.map((r) => [r.track, r.by, r.count]).sort(), [['V1', 10, 3], ['V2', 20, 3]]);
}

// ── 上限:超过 30 条只列前 30 并提示重读 ──
{
  const items = Array.from({ length: 40 }, (_, i) => clip(`c${i}`, 'trk-lower', i * 30));
  const before = snapshotTimeline(stateOf(items));
  // 每个都改长度(非纯位移)→ 全部算变更
  const after = stateOf(items.map((it) => ({ ...it, durationInFrames: 20 })));
  const d = describeTimelineDelta(before, after)!;
  assert.equal(d.clips?.length, 30, '最多列 30 条');
  assert.match(d.notes?.join(' ') ?? '', /共 40 个片段变更/, '提示总数与重读');
}

// ── 新增轨道上报 + 轨道构成变化提醒 ──
{
  const before = snapshotTimeline(stateOf([clip('a', 'trk-lower', 0)], { 'trk-lower': { kind: 'video' } }));
  const after = stateOf([clip('a', 'trk-lower', 0), clip('b', 'trk-upper', 0)]); // 上方新增一条视频轨
  const d = describeTimelineDelta(before, after)!;
  assert.deepEqual(d.createdTracks, ['V2'], '新轨上报(按别名:新轨在上 = V2)');
  assert.match(d.notes?.join(' ') ?? '', /轨道构成已变化/, '提醒重新确认轨道定位');
}

// ── 经真 reducer 的波纹删除:差分与实际结果一致 ──
{
  const items = [clip('a', 'trk-lower', 0), clip('b', 'trk-lower', 30), clip('c', 'trk-lower', 60), clip('d', 'trk-lower', 90)];
  const s0 = stateOf(items);
  const before = snapshotTimeline(s0);
  const s1 = reduce(s0, { type: 'remove', id: 'a', ripple: true });
  const d = describeTimelineDelta(before, s1)!;
  assert.deepEqual(d.removedItemIds, ['a'], '真 reducer 删除');
  assert.equal(d.shifted?.length, 1, '波纹压成一条规则');
  assert.equal(d.shifted![0]!.count, 3, '后面 3 个片段位移');
  assert.equal(d.shifted![0]!.by, -30, '各左移 30 帧');
  // 规则能反推出真实位置
  for (const it of s1.items) {
    const was = before.placements.get(it.id)!;
    assert.equal(it.startFrame, was.startFrame + d.shifted![0]!.by, `${it.id} 位置可由规则推出`);
  }
}

console.log('timelineDelta.verify: ok (只读/变更分类/波纹压缩/零星枚举/上限/新轨/真 reducer)');
