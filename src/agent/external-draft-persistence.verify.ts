import assert from 'node:assert/strict';
import { INITIAL } from '../editor/initial';
import { makeDraft, type DraftEngine } from '../editor/store';
import {
  loadAgentRuntimeSidecar,
  resetAgentRuntimeStoreMemory,
} from '../persist/agentRuntimeStore';
import {
  loadExternalProposal,
  saveExternalProposal,
  type StoredExternalProposal,
} from '../persist/externalProposalStore';
import { docFromTimeline, saveProject } from '../persist/projectStore';
import { kvSet } from '../persist/sharedKv';
import { saveAutomaticVersion } from '../persist/versionStore';
import type { AgentContext } from './context';
import { ExternalBridgeRuntime, type ExternalBridgeBinding } from './external-bridge-runtime';
import { loadRecoveredAgentSession } from './useAgentPersistence';
import { revisionOf } from './external-edit-session';

const base = docFromTimeline({ ...INITIAL, items: [] });
const projectId = `external-draft-${crypto.randomUUID()}`;
const records: StoredExternalProposal[] = [];
resetAgentRuntimeStoreMemory();

function context(draft: DraftEngine): AgentContext {
  return {
    commands: draft.commands,
    getState: draft.getState,
    getDoc: draft.getDoc,
    getCreativeMode: () => null,
    templates: [],
    audio: [],
    getProjectId: () => projectId,
  };
}

const persistence = {
  saveProject,
  saveAutomaticVersion,
  saveExternalProposal: async (id: string, record: StoredExternalProposal) => {
    records.push(structuredClone(record));
    await saveExternalProposal(id, record);
  },
};

function sessionId(value: unknown): string {
  assert(value && typeof value === 'object' && 'editSessionId' in value);
  const id = value.editSessionId;
  if (typeof id !== 'string') throw new Error('Expected external edit session to expose editSessionId');
  return id;
}

const live = makeDraft(base);
function needsConfirmation(value: unknown): boolean {
  return Boolean(value && typeof value === 'object' && 'needs_confirmation' in value
    && value.needs_confirmation === true);
}

function binding(editorInstanceId: string, draft = live): ExternalBridgeBinding {
  return { projectId, editorInstanceId, baseRevision: revisionOf(draft.getDoc()) };
}

async function setRatio(
  runtime: ExternalBridgeRuntime,
  currentBinding: ExternalBridgeBinding,
  editSessionId: string,
  ratio: string,
) {
  await runtime.execute('set_aspect_ratio', { editSessionId, ratio }, currentBinding);
}

const first = new ExternalBridgeRuntime(
  projectId, 'editor-before-reload', () => context(live), () => undefined, persistence,
);
const firstBinding = binding('editor-before-reload');
const begun = await first.execute('begin_edit_session', {}, firstBinding);
const editSessionId = sessionId(begun);
assert.equal(records.at(-1)?.status, 'drafting');
assert.equal(records.at(-1)?.draftCheckpoint?.operations.length, 0);
assert.equal('draft' in (records.at(-1) ?? {}), false, 'DraftEngine is never serialized');

await setRatio(first, firstBinding, editSessionId, '1:1');
await setRatio(first, firstBinding, editSessionId, '9:16');
const persistedDraft = await loadExternalProposal(projectId);
assert(persistedDraft);
assert.equal(persistedDraft.status, 'drafting');
assert.equal(persistedDraft.draftCheckpoint?.operations.length, 2);
const guardedArgs = { editSessionId, limit: 1 };
const guarded = await first.execute('read_export_history', guardedArgs, firstBinding);
assert.equal(needsConfirmation(guarded), true);
await assert.rejects(
  first.execute('read_export_history', guardedArgs, firstBinding),
  /already pending/,
  'repeated retries cannot allocate duplicate durable approvals',
);
const pendingApproval = (await loadAgentRuntimeSidecar(projectId)).approvals
  .find((approval) => approval.status === 'pending');
assert(pendingApproval);
await first.disconnect();
assert.equal(
  (await loadAgentRuntimeSidecar(projectId)).approvals
    .find((approval) => approval.approvalId === pendingApproval.approvalId)?.status,
  'cancelled',
  'disconnect cancels orphaned pending approvals instead of restoring an allowance',
);
await loadRecoveredAgentSession(projectId, () => true);
const preservedRun = (await loadAgentRuntimeSidecar(projectId)).runs
  .find((run) => run.runId === persistedDraft.agentRunId);
assert.equal(preservedRun?.status, 'running',
  'production recovery preserves a persisted external drafting owner for reload');

const snapshots: Array<{ proposal: StoredExternalProposal['proposal']; stale: boolean }> = [];
const reloaded = new ExternalBridgeRuntime(
  projectId,
  'editor-after-reload',
  () => context(live),
  (snapshot) => snapshots.push(snapshot),
  persistence,
);
await reloaded.hydrate(persistedDraft);
const reloadBinding = binding('editor-after-reload');
const freshGuarded = await reloaded.execute('read_export_history', guardedArgs, reloadBinding);
assert.equal(needsConfirmation(freshGuarded), true, 'reload requires a fresh external approval');
const freshGuard = reloaded.pendingGuard();
assert(freshGuard);
await reloaded.confirmRealTool(freshGuard.id, false);
await setRatio(reloaded, reloadBinding, editSessionId, '4:3');
assert.equal((await loadExternalProposal(projectId))?.operationCount, 3);

const originalAnimationFrame = globalThis.requestAnimationFrame;
globalThis.requestAnimationFrame = (callback) => {
  callback(performance.now());
  return 1;
};
await reloaded.execute('review_edit_session', {
  editSessionId,
  summary: 'three persisted operations',
}, reloadBinding);
globalThis.requestAnimationFrame = originalAnimationFrame;
assert.equal(snapshots.at(-1)?.proposal?.options[0].operations.length, 3);
assert.equal((await loadExternalProposal(projectId))?.status, 'awaiting_review');
const awaiting = await loadExternalProposal(projectId);
assert(awaiting?.proposal);
const legacyAwaitingId = `${projectId}-legacy-review`;
await kvSet(`external-proposal:${legacyAwaitingId}`, {
  sessionId: awaiting.sessionId,
  clientName: awaiting.clientName,
  approvalMode: awaiting.approvalMode,
  status: 'awaiting_review',
  baseRevision: awaiting.baseRevision,
  createdAt: awaiting.createdAt,
  operationCount: awaiting.operationCount,
  proposal: awaiting.proposal,
});
assert.equal((await loadExternalProposal(legacyAwaitingId))?.status, 'awaiting_review');
const legacyTerminalId = `${projectId}-legacy-terminal`;
await kvSet(`external-proposal:${legacyTerminalId}`, {
  sessionId: awaiting.sessionId,
  clientName: awaiting.clientName,
  status: 'discarded',
  baseRevision: awaiting.baseRevision,
  createdAt: awaiting.createdAt,
  operationCount: awaiting.operationCount,
  proposal: null,
});
assert.equal((await loadExternalProposal(legacyTerminalId))?.status, 'cancelled');
await reloaded.reject();
assert.equal((await loadExternalProposal(projectId))?.status, 'rejected');

const staleProjectId = `${projectId}-stale`;
const staleRecord = structuredClone(persistedDraft);
await saveExternalProposal(staleProjectId, staleRecord);
const changed = makeDraft(base);
changed.commands.setAspect(1080, 1080, 'contain');
const staleRecords: StoredExternalProposal[] = [];
const staleRuntime = new ExternalBridgeRuntime(
  staleProjectId,
  'stale-editor',
  () => ({ ...context(changed), getProjectId: () => staleProjectId }),
  (snapshot) => snapshots.push(snapshot),
  { ...persistence, saveExternalProposal: async (_id, record) => { staleRecords.push(record); } },
);
await staleRuntime.hydrate(staleRecord);
assert.equal(staleRecords.at(-1)?.status, 'stale');
assert.equal(snapshots.at(-1)?.stale, true);

const malformedProjectId = `${projectId}-malformed`;
await kvSet(`external-proposal:${malformedProjectId}`, {
  ...persistedDraft,
  draftCheckpoint: { ...persistedDraft.draftCheckpoint, draftDoc: { version: 999 } },
});
const malformed = await loadExternalProposal(malformedProjectId);
assert.equal(malformed?.status, 'stale', 'malformed drafting data fails closed as terminal stale');
assert.equal(malformed?.draftCheckpoint, undefined);

await reloaded.disconnect();
await staleRuntime.disconnect();
resetAgentRuntimeStoreMemory();
