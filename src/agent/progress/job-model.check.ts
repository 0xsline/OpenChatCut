// 统一 Job 模型的黑盒 check(计划 A3)。跑:tsx src/agent/job-model.check.ts
import assert from 'node:assert/strict';
import {
  normalizeStatus,
  isTerminal,
  isComplete,
  isFailed,
  TERMINAL_STATUSES,
  type JobStatus,
} from './job-model';

// ── normalizeStatus:各家族 wire → canonical ───────────────────────────────
const NORM: ReadonlyArray<[string, JobStatus]> = [
  ['pending', 'pending'],
  ['queued', 'pending'], // generation/export 家族的"排队"
  ['running', 'running'],
  ['processing', 'running'],
  ['complete', 'complete'],
  ['completed', 'complete'], // 导出族终态 wire
  ['succeeded', 'complete'], // 生成族终态 wire
  ['success', 'complete'],
  ['done', 'complete'], // 转写 store 终态 wire
  ['failed', 'failed'],
  ['error', 'failed'],
  ['not_found', 'not_found'],
  ['missing', 'not_found'],
];
for (const [wire, canonical] of NORM) {
  assert.equal(normalizeStatus(wire), canonical, `normalizeStatus(${wire})`);
}

// 大小写 / 空白不敏感
assert.equal(normalizeStatus('SUCCEEDED'), 'complete');
assert.equal(normalizeStatus('  Done  '), 'complete');
assert.equal(normalizeStatus('Queued'), 'pending');

// 未知字符串 → running(非终态,继续轮询而非误判终态)
assert.equal(normalizeStatus('weird-status'), 'running');
assert.equal(normalizeStatus(''), 'running');

// ── isTerminal / isComplete / isFailed ────────────────────────────────────
for (const t of ['complete', 'completed', 'succeeded', 'done', 'failed', 'error', 'not_found', 'missing']) {
  assert.equal(isTerminal(t), true, `isTerminal(${t}) should be true`);
}
for (const nt of ['pending', 'queued', 'running', 'processing', 'weird', '']) {
  assert.equal(isTerminal(nt), false, `isTerminal(${nt}) should be false`);
}
for (const c of ['complete', 'completed', 'succeeded', 'done']) {
  assert.equal(isComplete(c), true, `isComplete(${c})`);
  assert.equal(isFailed(c), false, `isFailed(${c})`);
}
for (const f of ['failed', 'error']) {
  assert.equal(isFailed(f), true, `isFailed(${f})`);
  assert.equal(isComplete(f), false, `isComplete(${f})`);
}
// not_found 是终态,但既非 complete 也非 failed
assert.equal(isTerminal('not_found'), true);
assert.equal(isComplete('not_found'), false);
assert.equal(isFailed('not_found'), false);

// TERMINAL_STATUSES 内容锁定
assert.deepEqual([...TERMINAL_STATUSES].sort(), ['complete', 'failed', 'not_found']);

// ── 同构断言:三家族的终态 wire 全部由同一权威正确归类(A3 的核心目标)─────────
// 生成族 succeeded / 导出族 completed / 转写 store done —— 都应判为"完成 + 终态";
// 各自的在途状态(queued/running)都应判为"非终态"。
const FAMILY_COMPLETE = ['succeeded', 'completed', 'done'];
const FAMILY_INFLIGHT = ['queued', 'running'];
for (const done of FAMILY_COMPLETE) {
  assert.equal(isComplete(done), true, `family complete wire ${done}`);
  assert.equal(isTerminal(done), true, `family complete wire ${done} terminal`);
}
for (const live of FAMILY_INFLIGHT) {
  assert.equal(isTerminal(live), false, `family in-flight wire ${live} non-terminal`);
}

console.log('job-model.check.ts OK');
