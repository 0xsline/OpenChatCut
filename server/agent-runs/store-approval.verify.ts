import assert from 'node:assert/strict';
import { reconcileRestartedToolApprovals } from './store-recovery';
import { RunRecoveryStore, resetRunRecoveryStoreForTest } from './run-recovery-store';
import { loadAgentRuntimeSidecar, resetAgentRuntimeStoreMemory } from '../../src/persist/agentRuntimeStore.ts';
import {
  cancelRun,
  claimToolRequest,
  settleToolResult,
  createRun,
  flushServerRunPersistence,
  recoverServerRun,
  resetServerRunStoreForTest,
  waitForToolResult,
} from './store.ts';

function create(projectId: string, runId: string) {
  return createRun({
    id: runId,
    projectId,
    sessionGeneration: 'legacy',
    provider: 'deepseek',
    model: 'deepseek-v4-flash',
  });
}

async function pendingApproval(projectId: string, runId: string, toolCallId: string) {
  const run = create(projectId, runId);
  await flushServerRunPersistence(run);
  const pending = waitForToolResult(
    run,
    toolCallId,
    'edit_item',
    toolCallId === 'call-cancelled-approval' ? 'a'.repeat(64) : 'b'.repeat(64),
    60_000,
  );
  void pending.catch(() => undefined);
  await flushServerRunPersistence(run);
  const approval = (await loadAgentRuntimeSidecar(projectId)).approvals.find(
    (item) => item.runId === runId && item.toolCallId === toolCallId,
  );
  assert.equal(approval?.status, 'pending');
  return { run, pending };
}

const recoveryStore = new RunRecoveryStore(':memory:');
resetRunRecoveryStoreForTest(recoveryStore);
resetAgentRuntimeStoreMemory();
resetServerRunStoreForTest();
const cancelled = await pendingApproval(
  'server-run-cancelled-approval',
  'run-cancelled-approval',
  'call-cancelled-approval',
);
await cancelRun(cancelled.run);
await assert.rejects(cancelled.pending, /cancelled/);
await flushServerRunPersistence(cancelled.run);
const cancelledApproval = (await loadAgentRuntimeSidecar(cancelled.run.projectId)).approvals.find(
  (item) => item.runId === cancelled.run.id,
);
assert.equal(cancelledApproval?.status, 'cancelled');
assert.equal(typeof cancelledApproval?.decidedAt, 'number',
  'terminal done is not observable until pending approval cancellation is durable');

const restarted = await pendingApproval(
  'server-run-restarted-approval',
  'run-restarted-approval',
  'call-restarted-approval',
);
resetServerRunStoreForTest();
await assert.rejects(restarted.pending, /reset/);
const recovered = await recoverServerRun(restarted.run.projectId, restarted.run.id);
assert(recovered, 'the interrupted durable server run is recovered as a terminal record');
const recoveredApproval = (await loadAgentRuntimeSidecar(restarted.run.projectId)).approvals.find(
  (item) => item.runId === restarted.run.id,
);
assert.equal(recoveredApproval?.status, 'cancelled');
assert.equal(typeof recoveredApproval?.decidedAt, 'number',
  'server restart repair cancels approvals left pending by the interrupted process');

// A recovered owner may retire pending mirrors only for unclaimed intents.
const mirrorRun = createRun({ id: 'run-intent-mirror', projectId: 'server-run-intent-mirror',
  sessionGeneration: 'legacy', backend: 'api', provider: 'openai', model: 'test-model' });
await flushServerRunPersistence(mirrorRun);
const mirrorKey = { projectId: mirrorRun.projectId, sessionGeneration: mirrorRun.sessionGeneration, runId: mirrorRun.id };
recoveryStore.prepareAdmission({ ...mirrorKey, backend: 'api', model: mirrorRun.model, askOnly: false,
  admissionExpiresAt: Date.now() + 60_000 });
const mirrorOwner = recoveryStore.acquireOwnership(mirrorKey, { instanceId: 'mirror-owner' });
recoveryStore.beginRequest(mirrorKey, { epoch: mirrorOwner.epoch!, requestIndex: 1,
  prompt: '', messages: [{ role: 'user', content: 'inspect' }], toolNames: ['read_timeline'] });
const fixtures = [
  { id: 'unclaimed', name: 'read_timeline', digest: '1'.repeat(64), state: 'intent' },
  { id: 'claimed', name: 'read_project', digest: '2'.repeat(64), state: 'claimed' },
  { id: 'outcome', name: 'inspect_item', digest: '3'.repeat(64), state: 'outcome' },
  { id: 'other', name: 'read_media', digest: '4'.repeat(64), state: 'other' },
];
for (const fixture of fixtures) {
  const pending = waitForToolResult(mirrorRun, fixture.id, fixture.name, fixture.digest, 60_000);
  void pending.catch(() => undefined);
  if (fixture.state === 'other') continue;
  const intent = recoveryStore.beginTool(mirrorKey, { epoch: mirrorOwner.epoch!,
    intent: { toolCallId: fixture.id, name: fixture.name, argsDigest: fixture.digest } });
  if (fixture.state !== 'intent') recoveryStore.claimTool(mirrorKey, { epoch: mirrorOwner.epoch!,
    toolCallId: fixture.id, argsDigest: fixture.digest, claimId: `claim-${fixture.id}` });
  if (fixture.state === 'outcome') recoveryStore.finishTool(mirrorKey, { epoch: mirrorOwner.epoch!,
    outcome: { opSeq: intent.opSeq, toolCallId: fixture.id, name: fixture.name, argsDigest: fixture.digest, success: true, result: { done: true } } });
}
await flushServerRunPersistence(mirrorRun);
await assert.rejects(() => reconcileRestartedToolApprovals(mirrorRun, mirrorOwner.epoch! + 1), /stale/);
assert.equal((await loadAgentRuntimeSidecar(mirrorRun.projectId)).approvals.every((entry) => entry.status === 'pending'), true);
await reconcileRestartedToolApprovals(mirrorRun, mirrorOwner.epoch!);
await reconcileRestartedToolApprovals(mirrorRun, mirrorOwner.epoch!);
const mirrors = (await loadAgentRuntimeSidecar(mirrorRun.projectId)).approvals;
assert.equal(mirrors.find((entry) => entry.toolCallId === 'unclaimed')?.status, 'cancelled');
assert.equal(mirrors.find((entry) => entry.toolCallId === 'outcome')?.status, 'allowed');
for (const id of ['claimed', 'other']) assert.equal(mirrors.find((entry) => entry.toolCallId === id)?.status, 'pending');

// A cold request map can reuse the original call id, then a later new id.
assert.equal(mirrorRun.toolRequests.has('unclaimed'), false, 'the unclaimed in-memory request is retired as well');
const sameId = waitForToolResult(mirrorRun, 'unclaimed', 'read_timeline', '1'.repeat(64), 60_000);
await flushServerRunPersistence(mirrorRun);
assert.equal((await loadAgentRuntimeSidecar(mirrorRun.projectId)).approvals.find((entry) => entry.toolCallId === 'unclaimed')?.status, 'pending');
const sameBinding = { toolCallId: 'unclaimed', argsDigest: '1'.repeat(64), claimId: 'new-same-id' };
assert.equal(claimToolRequest(mirrorRun, sameBinding), 'claimed');
assert.equal(settleToolResult(mirrorRun, { ...sameBinding, result: { timeline: [] } }), 'accepted');
await sameId;
await flushServerRunPersistence(mirrorRun);
const newId = waitForToolResult(mirrorRun, 'unclaimed-new', 'read_timeline', '1'.repeat(64), 60_000);
void newId.catch(() => undefined);
await flushServerRunPersistence(mirrorRun);
assert.equal((await loadAgentRuntimeSidecar(mirrorRun.projectId)).approvals.find((entry) => entry.toolCallId === 'unclaimed-new')?.status, 'pending');
await cancelRun(mirrorRun);

resetServerRunStoreForTest();
resetAgentRuntimeStoreMemory();
resetRunRecoveryStoreForTest(null);
console.log('server run approval cancellation verification passed');
