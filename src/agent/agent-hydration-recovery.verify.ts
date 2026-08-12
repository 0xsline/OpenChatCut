import assert from 'node:assert/strict';
import { INITIAL } from '../editor/initial';
import { makeDraft } from '../editor/store';
import {
  MAX_APPROVALS,
  loadAgentRuntimeSidecar,
  patchAgentRun,
  resetAgentRuntimeStoreMemory,
  upsertAgentApproval,
} from '../persist/agentRuntimeStore';
import {
  adoptAgentSessionWriteGeneration,
  agentSessionWriteGeneration,
  rotateAgentSessionGeneration,
} from '../persist/agentSessionGeneration';
import { docFromTimeline } from '../persist/projectStore';
import {
  loadProposalRecord,
  markProposalApplying,
  saveProposal,
} from '../persist/proposalStore';
import {
  digestAgentToolArgs,
  startAgentRun,
  stopAgentRunLeases,
  type AgentRunRecorder,
} from './runtime-ledger';
import { buildOperation, buildProposal } from './proposal';
import { cleanupAgentHydration, loadRecoveredAgentSession } from './useAgentPersistence';
import type { AgentHookState } from './useAgentState';
import { requestRuntimeGuard } from './useAgentRun';
// The settle endpoint is server-side; emulate its effect locally (patch the
// sidecar) so verifies exercise the full settlement path without a server.
const originalFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  if (url.includes('/settle') && init?.method === 'POST') {
    const body = JSON.parse(String(init.body)) as {
      projectId: string; status: string;
      proposalId?: string; summary?: string;
    };
    const settleRunId = String(url).split('/').filter(Boolean).at(-2) ?? '';
    await patchAgentRun(body.projectId, settleRunId, {
      status: body.status as 'completed' | 'failed' | 'aborted' | 'interrupted'
        | 'waiting_approval' | 'awaiting_user',
      ...(body.summary ? { finalSummary: body.summary } : {}),
    });
    return new Response(JSON.stringify({ ok: true, already: false, gone: false }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });
  }
  return originalFetch(input, init);
}) as typeof fetch;

const projectId = `hydrate-recovery-${crypto.randomUUID()}`;
resetAgentRuntimeStoreMemory();
const capProjectId = `approval-cap-${crypto.randomUUID()}`;
for (let index = 0; index < MAX_APPROVALS; index += 1) {
  await upsertAgentApproval({
    version: 1,
    approvalId: `approval-${index}`,
    projectId: capProjectId,
    runId: `run-${index}`,
    toolCallId: `call-${index}`,
    toolName: 'edit_item',
    argsDigest: index.toString(16).padStart(64, '0'),
    status: 'pending',
    createdAt: index,
  });
}
await assert.rejects(upsertAgentApproval({
  version: 1,
  approvalId: 'approval-overflow',
  projectId: capProjectId,
  runId: 'run-overflow',
  toolCallId: 'call-overflow',
  toolName: 'edit_item',
  argsDigest: 'f'.repeat(64),
  status: 'pending',
  createdAt: MAX_APPROVALS,
}), /limit reached/, 'pending approval overflow fails closed');
resetAgentRuntimeStoreMemory();

async function legacyRun(
  status: 'running' | 'waiting_approval' | 'awaiting_user',
  retainOwnership = false,
) {
  const recorder = await startAgentRun({ projectId, userInput: status, askOnly: false });
  await patchAgentRun(projectId, recorder.runId, retainOwnership ? { status } : {
    status,
    ownerInstanceId: undefined,
    leaseExpiresAt: undefined,
  });
  if (!retainOwnership) recorder.stopLease();
  return recorder;
}

async function pendingApproval(recorder: AgentRunRecorder, toolCallId: string) {
  return recorder.recordApprovalRequested({
    toolCallId,
    toolName: 'edit_item',
    argsDigest: await digestAgentToolArgs({ id: toolCallId }),
  });
}

const running = await legacyRun('running');
const waiting = await legacyRun('waiting_approval', true);
const awaiting = await legacyRun('awaiting_user');
const expiredApproval = await pendingApproval(waiting, 'expired-owner-call');
await patchAgentRun(projectId, waiting.runId, { ownerInstanceId: undefined, leaseExpiresAt: undefined });
waiting.stopLease();
const protectedProposalRun = await legacyRun('waiting_approval');
const base = docFromTimeline({ ...INITIAL, items: [] });
const proposalDraft = makeDraft(base);
proposalDraft.commands.setAspect(1080, 1080, 'contain');
const operation = buildOperation(
  'set_aspect_ratio',
  { ratio: '1:1' },
  proposalDraft.takeActions(),
);
const proposal = buildProposal(
  [operation],
  'persisted proposal',
  base,
  proposalDraft.getState(),
  protectedProposalRun.runId,
);
await saveProposal(projectId, proposal);

const live = await startAgentRun({ projectId, userInput: 'live owner', askOnly: false });
const liveApproval = await pendingApproval(live, 'live-owner-call');
const hydrated = await loadRecoveredAgentSession(projectId, () => true);

const recovered = await loadAgentRuntimeSidecar(projectId);
for (const recorder of [running, waiting, awaiting]) {
  assert.equal(recovered.runs.find((run) => run.runId === recorder.runId)?.status, 'interrupted');
}
assert.equal(recovered.approvals.find((item) => item.approvalId === expiredApproval.approvalId)?.status, 'cancelled');
assert.equal(recovered.runs.find((run) => run.runId === live.runId)?.status, 'waiting_approval');
assert.equal(recovered.approvals.find((item) => item.approvalId === liveApproval.approvalId)?.status, 'pending');
assert.equal(hydrated?.pending?.id, proposal.id);
assert.equal(recovered.runs.find((run) => run.runId === protectedProposalRun.runId)?.status,
  'waiting_approval', 'persisted built-in review ownership survives crash recovery');

const decidedAt = recovered.approvals.find((item) => item.approvalId === expiredApproval.approvalId)?.decidedAt;
await loadRecoveredAgentSession(projectId, () => true);
const repeated = await loadAgentRuntimeSidecar(projectId);
assert.equal(repeated.approvals.find((item) => item.approvalId === expiredApproval.approvalId)?.decidedAt, decidedAt,
  'repeated production hydration does not settle an approval twice');
const resultDoc = proposalDraft.getDoc();
await markProposalApplying(projectId, proposal, resultDoc, 1);
const recoveredBeforeCommit = await loadRecoveredAgentSession(
  projectId, () => true, undefined, base,
);
assert.equal(recoveredBeforeCommit?.pending?.id, proposal.id);
assert.equal((await loadProposalRecord(projectId))?.phase, 'prepared');

await markProposalApplying(projectId, proposal, resultDoc, 1);
const recoveredAfterCommit = await loadRecoveredAgentSession(
  projectId, () => true, undefined, resultDoc,
);
assert.equal(recoveredAfterCommit?.pending, null);
assert.equal(await loadProposalRecord(projectId), null);
assert.equal(
  (await loadAgentRuntimeSidecar(projectId)).runs
    .find((run) => run.runId === protectedProposalRun.runId)?.status,
  'completed',
  'a document committed before a crash settles applied and cannot expose a replayable proposal',
);


let alive = true;
const cancelled = loadRecoveredAgentSession(projectId, () => alive, async () => {
  alive = false;
  return loadAgentRuntimeSidecar(projectId);
});
assert.equal(await cancelled, null, 'unmounted hydration does not continue into chat/proposal loading');
let releaseRecovery!: () => void;
let recoveryStarted!: () => void;
const recoveryReached = new Promise<void>((resolve) => { recoveryStarted = resolve; });
const recoveryGate = new Promise<void>((resolve) => { releaseRecovery = resolve; });
const staleGenerationHydration = loadRecoveredAgentSession(projectId, () => true, async () => {
  recoveryStarted();
  await recoveryGate;
  return loadAgentRuntimeSidecar(projectId);
});
await recoveryReached;
await rotateAgentSessionGeneration(projectId);
releaseRecovery();
assert.equal(
  await staleGenerationHydration,
  null,
  'generation rotation invalidates an in-flight hydration before it can restore old context',
);
const authoritativeGeneration = await rotateAgentSessionGeneration(projectId);
adoptAgentSessionWriteGeneration(projectId, 'stale-tab-generation');
let recoveryWriteGeneration = '';
await loadRecoveredAgentSession(projectId, () => true, async () => {
  recoveryWriteGeneration = await agentSessionWriteGeneration(projectId);
  return loadAgentRuntimeSidecar(projectId);
});
assert.equal(
  recoveryWriteGeneration,
  authoritativeGeneration,
  'hydration adopts the freshly observed generation before recovery mutates runtime state',
);

const cleanupEvents: string[] = [];
const activeAbort = new AbortController();
activeAbort.signal.addEventListener('abort', () => cleanupEvents.push('abort'));
const activeCleanupState = {
  runningRef: { current: true },
  abortRef: { current: activeAbort },
  pendingGuardRef: { current: { resolve: (decision: string) => cleanupEvents.push(decision) } },
} as unknown as AgentHookState;
let stoppedActiveLeases = 0;
cleanupAgentHydration(activeCleanupState, projectId, async () => { stoppedActiveLeases += 1; });
assert.deepEqual(cleanupEvents, ['deny', 'abort'],
  'unmount synchronously denies approval before aborting the active turn');
assert.equal(stoppedActiveLeases, 0,
  'the active execution lease remains owned until runtime finally/finalize');

const idleCleanupState = {
  runningRef: { current: false },
  abortRef: { current: null },
  pendingGuardRef: { current: null },
} as unknown as AgentHookState;
let stoppedIdleLeases = 0;
cleanupAgentHydration(idleCleanupState, projectId, async () => { stoppedIdleLeases += 1; });
assert.equal(stoppedIdleLeases, 1, 'idle/hydration recorders release immediately on cleanup');

const immediateGuardRef = { current: null };
let renderedGuard: unknown = null;
const immediateGuardState = {
  runningRef: { current: false },
  abortRef: { current: null },
  pendingGuardRef: immediateGuardRef,
  setPendingGuard: (guard: unknown) => { renderedGuard = guard; },
} as unknown as AgentHookState;
const immediateDecision = requestRuntimeGuard(immediateGuardState, projectId, {
  skill: 'high-cost-operation',
  permissionKind: 'persistent_local',
  approval: 'once',
  tool: 'install_skill',
});
assert.equal(immediateGuardRef.current, renderedGuard,
  'pending guard ref is assigned synchronously before React renders');
cleanupAgentHydration(immediateGuardState, projectId, async () => undefined);
assert.equal(await immediateDecision, 'deny',
  'unmount before the pending-guard render still denies the waiting tool');
assert.equal(immediateGuardRef.current, null, 'resolving the guard synchronously clears its ref');
// A proposal whose run is still leased by another editor must hydrate
// silently (no throw): the proposal is settled stale and cleared so the
// next open starts clean instead of surfacing a recovery error.
const contestedProject = `hydrate-contested-${crypto.randomUUID()}`;
const contestedRecorder = await startAgentRun({ projectId: contestedProject, userInput: 'other-editor', askOnly: false });
contestedRecorder.stopLease();
await patchAgentRun(contestedProject, contestedRecorder.runId, {
  status: 'waiting_approval',
  ownerInstanceId: 'another-editor-instance',
  leaseExpiresAt: Date.now() + 60_000,
});
const contestedProposal = buildProposal(
  [operation],
  'contested proposal',
  base,
  proposalDraft.getState(),
  contestedRecorder.runId,
);
await saveProposal(contestedProject, contestedProposal);
const contestedHydration = await loadRecoveredAgentSession(contestedProject, () => true);
assert.equal(contestedHydration?.pending?.id, contestedProposal.id,
  'a proposal whose run is owned elsewhere still hydrates (server-side settle is idempotent)');
assert.equal(
  (await loadAgentRuntimeSidecar(contestedProject)).runs
    .find((run) => run.runId === contestedRecorder.runId)?.status,
  'waiting_approval',
  'the contested run stays waiting_approval after hydration (no ownership handshake in the browser)');
await stopAgentRunLeases(projectId);
resetAgentRuntimeStoreMemory();
