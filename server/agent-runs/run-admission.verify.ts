import assert from 'node:assert/strict';
import { deferRunExecution, discardDeferredRun, ensureDeferredRunExecution, startDeferredRun, startResumedRun } from './run-admission';
import { createRun, resetServerRunStoreForTest } from './store';
import { RunRecoveryStore, resetRunRecoveryStoreForTest } from './run-recovery-store';
import { resetRunRecoveryRuntimeForTest, runRecoveryKeyOf } from './run-recovery-runtime';
import type { ServerRunInput } from './executor';

const store = new RunRecoveryStore(':memory:');
resetRunRecoveryStoreForTest(store);
const admittedIds: string[] = [];
const input: ServerRunInput = {
  messages: [{ role: 'user', content: 'inspect' }], provider: 'openai', model: 'test-model',
  openAiApiMode: 'chat', cacheMode: 'short', maxOutputTokens: 4096,
  autonomousAcceptance: false, maxAcceptanceIterations: 1, origin: 'http://127.0.0.1', tools: [],
};
try {
  for (const backend of ['api', 'codex', 'copilot', 'claude-code'] as const) {
    const run = createRun({ id: `admission-${backend}`, projectId: `admission-${backend}`,
      sessionGeneration: 'legacy', backend, provider: 'openai', model: input.model });
    admittedIds.push(run.id);
    deferRunExecution(run, { ...input, backend });
    const key = runRecoveryKeyOf(run);
    const row = store.load(key);
    if (backend === 'copilot' || backend === 'claude-code') {
      assert.equal(row, null, `${backend} retains its existing admission`);
      continue;
    }
    assert(row);
    assert.equal(row.admissionExpiresAt, run.createdAt + 60_000);
    ensureDeferredRunExecution(run, { ...input, backend });
    assert.equal(store.load(key)?.admissionExpiresAt, row.admissionExpiresAt, 'a retry preserves the deadline');
    const stale = startResumedRun(run, { mode: 'resume', expectedRevision: row.revision + 1 }, input.origin);
    assert.deepEqual(stale, { ok: false, status: 409, reason: 'recovery revision is stale' });
    const owner = store.acquireOwnership(key, { instanceId: 'foreign-owner' });
    assert.equal(startResumedRun(run, { mode: 'resume' }, input.origin).ok, false, 'a foreign live lease blocks takeover');
    store.beginRequest(key, { epoch: owner.epoch!, requestIndex: 1, prompt: '', messages: input.messages, toolNames: [] });
    store.beginTool(key, { epoch: owner.epoch!, intent: { toolCallId: 'call', name: 'read_project', argsDigest: 'a'.repeat(64) } });
    store.claimTool(key, { epoch: owner.epoch!, toolCallId: 'call', argsDigest: 'a'.repeat(64), claimId: 'claim' });
    store.releaseOwnership(key, { instanceId: 'foreign-owner', epoch: owner.epoch! });
    assert.deepEqual(startResumedRun(run, { mode: 'resume' }, input.origin),
      { ok: false, status: 409, reason: 'run is waiting for tool reconciliation' });
  }
  const expired = createRun({ id: 'admission-expired', projectId: 'admission-expired',
    sessionGeneration: 'legacy', backend: 'api', provider: 'openai', model: input.model });
  Object.assign(expired, { createdAt: Date.now() - 60_001 });
  assert.throws(() => deferRunExecution(expired, input), /admission expired/);
  assert.equal(store.load(runRecoveryKeyOf(expired)), null, 'expired admission grants no durable execution authority');
  const single = createRun({ id: 'admission-single', projectId: 'admission-single',
    sessionGeneration: 'legacy', backend: 'api', provider: 'openai', model: input.model });
  admittedIds.push(single.id);
  deferRunExecution(single, input);
  let executions = 0;
  const execute = async () => { executions += 1; };
  assert.equal(startDeferredRun(single, execute), 'started');
  assert.equal(startDeferredRun(single, execute), 'already_started');
  assert.equal(executions, 1);
  await Promise.resolve();
} finally {
  for (const id of admittedIds) discardDeferredRun(id);
  resetRunRecoveryRuntimeForTest();
  resetServerRunStoreForTest();
  resetRunRecoveryStoreForTest(null);
}
console.log('run-admission.verify: deadlines, backend boundaries, ownership and claim gating passed');
