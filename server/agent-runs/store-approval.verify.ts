import assert from 'node:assert/strict';
import { loadAgentRuntimeSidecar, resetAgentRuntimeStoreMemory } from '../../src/persist/agentRuntimeStore.ts';
import {
  cancelRun,
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

resetServerRunStoreForTest();
resetAgentRuntimeStoreMemory();
console.log('server run approval cancellation verification passed');
