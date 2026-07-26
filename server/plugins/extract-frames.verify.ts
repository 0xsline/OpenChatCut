// Runnable check: `npx tsx server/plugins/extract-frames.verify.ts`.
// 验证联系表取样:均匀取样的基本性质,以及「变化优先 + 均匀补齐」的选取规则
// (变化点优先入选、挨太近的不重复占位、候选过多按序均摊、窗口外丢弃、
// 无候选时与均匀取样完全一致)。
import assert from 'node:assert/strict';
import { pickDistinctTimes, sampleTimesMs } from './extract-frames.ts';

const inWindow = (times: number[], lo: number, hi: number): boolean =>
  times.every((t) => t >= lo && t < hi);
const ascending = (times: number[]): boolean =>
  times.every((t, i) => i === 0 || t >= times[i - 1]!);

// ── 均匀取样:等分块中点、条数、区间 ──
{
  assert.deepEqual(sampleTimesMs(0, 12000, 6), [1000, 3000, 5000, 7000, 9000, 11000], '等分块中点');
  assert.equal(sampleTimesMs(0, 1000, 99).length, 20, '受 MAX_SAMPLES 上限约束');
  assert.equal(sampleTimesMs(0, 1000, 0).length, 1, 'count 0 至少给 1 个');
}

// ── 无候选 → 与均匀取样完全一致(场景分析失败时的兜底路径) ──
{
  assert.deepEqual(pickDistinctTimes([], 0, 18000, 6), sampleTimesMs(0, 18000, 6), '空候选=均匀取样');
}

// ── 变化点优先入选,其余用均匀取样补齐到 count ──
{
  const out = pickDistinctTimes([9000, 12000, 15000], 0, 18000, 6);
  assert.equal(out.length, 6, '补齐到 count');
  for (const t of [9000, 12000, 15000]) assert.ok(out.includes(t), `变化点 ${t} 必须入选`);
  assert.ok(ascending(out) && inWindow(out, 0, 18000), '升序且落在窗口内');
}

// ── 挨太近的候选不重复占位(否则一个转场会吃掉多个名额) ──
{
  const out = pickDistinctTimes([9000, 9050, 9100], 0, 18000, 6);
  const near = out.filter((t) => t >= 9000 && t <= 9100);
  assert.equal(near.length, 1, '同一处变化只占一个名额');
}

// ── 候选多于名额 → 按序均摊,不能全挤在开头 ──
{
  const dense = Array.from({ length: 40 }, (_, i) => i * 250); // 0..9750ms 密集候选
  const out = pickDistinctTimes(dense, 0, 10000, 5);
  assert.equal(out.length, 5, '不超过 count');
  assert.ok(out[out.length - 1]! - out[0]! > 5000, `应覆盖整段而非挤在开头(实得 ${out.join(',')})`);
  assert.ok(ascending(out), '升序');
}

// ── 窗口外的候选丢弃 ──
{
  const out = pickDistinctTimes([-500, 500, 99000], 0, 3000, 3);
  assert.ok(inWindow(out, 0, 3000), `窗口外候选必须丢弃(实得 ${out.join(',')})`);
  assert.ok(out.includes(500), '窗口内候选保留');
}

// ── 非窗口起点的区间(view_asset_frames 会传 fromMs/toMs) ──
{
  const out = pickDistinctTimes([7000], 5000, 9000, 3);
  assert.ok(inWindow(out, 5000, 9000), '相对区间内');
  assert.ok(out.includes(7000), '区间内变化点保留');
}

console.log('extract-frames.verify: ok (均匀取样/空候选兜底/变化优先/近邻去重/均摊/窗口裁剪)');
