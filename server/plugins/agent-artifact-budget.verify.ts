// The project artifact budget (MAX_PROJECT_ARTIFACTS) used to refuse a running
// agent's writes. A server run stores one draft artifact per tool call, so a
// long turn stopped persisting drafts after about 255 calls ("Server run draft
// could not be persisted (HTTP 409)"), and a context checkpoint or a large
// external result could no longer be archived. The budget now bounds what
// finished runs leave behind, in the store, in server merges and in exports.
import assert from 'node:assert/strict';
import {
  createAgentRun, loadAgentArtifact, loadAgentRuntimeSidecar, MAX_PROJECT_ARTIFACTS,
  patchAgentRun, resetAgentRuntimeStoreMemory, sha256Text, storeAgentArtifact, upsertAgentApproval,
  type AgentArtifactRecord, type AgentRunStatus, type AgentRuntimeSidecar,
} from '../../src/persist/agentRuntimeStore.ts';
import { validateRuntime } from '../../src/persist/agentRuntimeTransferValidation.ts';
import { resetSharedKvMemory } from '../../src/persist/sharedKv.ts';
import { mergeAgentSidecar } from './project-store-entries.ts';

resetAgentRuntimeStoreMemory();
resetSharedKvMemory();

const OVER_BUDGET = MAX_PROJECT_ARTIFACTS + 44;
let sequence = 0;

async function seedRun(projectId: string, runId: string, status: AgentRunStatus): Promise<void> {
  const now = Date.now();
  await createAgentRun({
    version: 1, runId, projectId, status, askOnly: false,
    userInputPreview: 'Long edit', userInputDigest: await sha256Text(runId),
    createdAt: now, updatedAt: now, artifactIds: [], checkpointIds: [], proposalIds: [], events: [],
  });
}

async function artifact(
  projectId: string,
  runId: string,
  kind: 'server-run-draft' | 'checkpoint-source',
): Promise<AgentArtifactRecord> {
  sequence += 1;
  const body = JSON.stringify({ kind, sequence });
  return {
    version: 1, artifactId: `budget${String(sequence).padStart(6, '0')}`, projectId, runId, kind,
    bodySha256: await sha256Text(body), originalBytes: new TextEncoder().encode(body).byteLength,
    originalChars: body.length, createdAt: Date.now() + sequence,
    redacted: false, binaryOmitted: false, body,
    ...(kind === 'server-run-draft' ? { toolCallId: `call${sequence}`, toolName: 'edit_item' } : {}),
  };
}

async function snapshot(projectId: string): Promise<{ sidecar: AgentRuntimeSidecar; artifacts: AgentArtifactRecord[] }> {
  const sidecar = await loadAgentRuntimeSidecar(projectId);
  const artifacts = await Promise.all(sidecar.artifacts.map((row) => loadAgentArtifact(projectId, row.artifactId)));
  assert(artifacts.every((row) => row !== null), 'every indexed artifact has a body');
  return { sidecar, artifacts: artifacts as AgentArtifactRecord[] };
}

// A running turn stores every draft, well past the budget.
const projectId = 'artifact_budget_project';
await seedRun(projectId, 'run_active', 'running');
await seedRun(projectId, 'run_finished', 'running');
const beforeArtifacts = await loadAgentRuntimeSidecar(projectId);
for (let index = 0; index < OVER_BUDGET; index += 1) {
  assert.equal(await storeAgentArtifact(await artifact(projectId, 'run_active', 'server-run-draft')), true,
    `draft ${index + 1} of a running turn is stored`);
}

// What a finished run leaves behind is still bounded.
for (let index = 0; index < MAX_PROJECT_ARTIFACTS; index += 1) {
  assert.equal(await storeAgentArtifact(await artifact(projectId, 'run_finished', 'checkpoint-source')), true);
}
await patchAgentRun(projectId, 'run_finished', { status: 'completed' });
assert.equal(await storeAgentArtifact(await artifact(projectId, 'run_finished', 'checkpoint-source')), false,
  'a finished run cannot grow past the budget');
assert.equal(await storeAgentArtifact(await artifact(projectId, 'run_active', 'server-run-draft')), true,
  'a running turn still stores while the finished runs fill the budget');

// Export counts what leaves the project: drafts never do, and approvals are
// capped as retention keeps them, every pending one plus the newest decided.
for (let index = 0; index < 100; index += 1) {
  await upsertAgentApproval({
    version: 1, approvalId: `approval_${index}`, projectId, runId: 'run_active',
    toolCallId: `call_decided_${index}`, toolName: 'read_project', argsDigest: await sha256Text(`args ${index}`),
    status: 'allowed', createdAt: Date.now(), decidedAt: Date.now(),
  });
}
await upsertAgentApproval({
  version: 1, approvalId: 'approval_pending', projectId, runId: 'run_active',
  toolCallId: 'call_pending', toolName: 'read_project', argsDigest: await sha256Text('pending'),
  status: 'pending', createdAt: Date.now(),
});
const exported = await snapshot(projectId);
assert.equal(exported.sidecar.approvals.length, 101, 'retention keeps the pending approval and 100 decided ones');
await validateRuntime(exported);

const overflowId = 'artifact_budget_overflow';
await seedRun(overflowId, 'run_overflow', 'running');
for (let index = 0; index <= MAX_PROJECT_ARTIFACTS; index += 1) {
  assert.equal(await storeAgentArtifact(await artifact(overflowId, 'run_overflow', 'checkpoint-source')), true);
}
await assert.rejects(validateRuntime(await snapshot(overflowId)), /exceeds record caps/,
  'an export that would carry more artifacts than an import accepts is still refused');

// A server merge keeps every artifact of a running turn, the draft's base included.
const merged = mergeAgentSidecar(`agent-runtime:${projectId}`, beforeArtifacts, exported.sidecar, true);
assert.equal(merged.accepted, true);
const kept = (merged.value as AgentRuntimeSidecar).artifacts;
assert.equal(kept.filter((row) => row.runId === 'run_active').length, OVER_BUDGET + 1,
  'a server merge drops none of a running turn\'s drafts');
assert.equal(kept.filter((row) => row.runId === 'run_finished').length, MAX_PROJECT_ARTIFACTS,
  'a server merge still bounds a finished run');

console.log(`agent-artifact-budget.verify: a running turn stores ${OVER_BUDGET + 1} drafts; finished runs stay within ${MAX_PROJECT_ARTIFACTS}`);
