import type { ProjectDoc } from '../editor/types';
import { replayActions } from '../editor/store';
import type { StoredExternalProposal } from '../persist/externalProposalStore';
import type { ExternalBridgePersistence } from './external-proposal-apply';
import {
  isExternalEditSessionStale,
  restoreDraftingExternalEditSession,
  restoreExternalEditSession,
  type ExternalEditSession,
} from './external-edit-session';
import { storedExternalSession } from './external-bridge-session';
import {
  ExternalSessionRunLedger,
  type ExternalToolExecutor,
} from './external-run-ledger';
import { isProposalStale, type Proposal } from './proposal';

interface HydratedExternalSession {
  readonly session: ExternalEditSession;
  readonly run: ExternalSessionRunLedger | null;
}

export interface ExternalBridgeHydrationInput {
  readonly pending: StoredExternalProposal | null;
  readonly projectId: string;
  readonly currentDoc: ProjectDoc;
  readonly save: ExternalBridgePersistence['saveExternalProposal'];
  readonly executeTool: ExternalToolExecutor;
  readonly install: (hydrated: HydratedExternalSession) => void;
  readonly publish: (snapshot: { proposal: Proposal | null; stale: boolean }) => void;
  readonly applyAutomatic: (operationCount: number) => Promise<void>;
}

async function markDraftStale(input: ExternalBridgeHydrationInput): Promise<void> {
  const { pending } = input;
  if (!pending) return;
  const stale = restoreExternalEditSession({ ...pending, status: 'stale' }, input.currentDoc);
  await input.save(input.projectId, storedExternalSession(stale, 'stale', undefined, pending.agentRunId));
  input.install({ session: stale, run: null });
  input.publish({ proposal: null, stale: true });
}

function replayCheckpoint(
  input: ExternalBridgeHydrationInput,
  pending: StoredExternalProposal,
): ProjectDoc | null {
  try {
    return replayActions(
      input.currentDoc,
      pending.draftCheckpoint?.operations.flatMap((operation) => operation.actions) ?? [],
    );
  } catch {
    return null;
  }
}

async function prepareHydratedRun(run: ExternalSessionRunLedger): Promise<void> {
  try {
    await run.cancelPendingApprovalsOnHydration();
  } catch (error) {
    run.dispose();
    throw error;
  }
}

async function hydrateDrafting(input: ExternalBridgeHydrationInput): Promise<void> {
  const { pending } = input;
  if (!pending || pending.status !== 'drafting'
      || !pending.draftCheckpoint || !pending.agentRunId) {
    throw new Error('Stored drafting checkpoint is incomplete.');
  }
  const session = restoreDraftingExternalEditSession(pending.draftCheckpoint, input.currentDoc);
  if (isExternalEditSessionStale(session, input.currentDoc)) {
    await markDraftStale(input);
    return;
  }
  const replayed = replayCheckpoint(input, pending);
  if (!replayed || JSON.stringify(replayed) !== JSON.stringify(pending.draftCheckpoint.draftDoc)) {
    await markDraftStale(input);
    return;
  }
  const run = await ExternalSessionRunLedger.resume(
    input.projectId,
    pending.agentRunId,
    input.executeTool,
  );
  if (!run) throw new Error('Drafting Agent run is unavailable or active in another editor.');
  await prepareHydratedRun(run);
  input.install({ session, run });
  input.publish({ proposal: null, stale: false });
}

export async function hydrateStoredExternalBridge(input: ExternalBridgeHydrationInput): Promise<void> {
  const { pending } = input;
  if (!pending) {
    input.publish({ proposal: null, stale: false });
    return;
  }
  if (pending.status === 'drafting') {
    await hydrateDrafting(input);
    return;
  }
  const session = restoreExternalEditSession({
    sessionId: pending.sessionId,
    clientName: pending.clientName,
    approvalMode: pending.approvalMode,
    status: pending.status,
    baseRevision: pending.baseRevision,
    createdAt: pending.createdAt,
    appliedOperationCount: pending.appliedOperationCount,
    operationCount: pending.operationCount,
    proposal: pending.proposal,
  }, input.currentDoc);
  const runId = session.status === 'awaiting_review'
    ? pending.agentRunId ?? session.proposal?.agentRunId
    : undefined;
  const run = runId
    ? await ExternalSessionRunLedger.resume(input.projectId, runId, input.executeTool)
    : null;
  if (runId && !run) {
    throw new Error('External proposal is active in another editor or no longer resumable.');
  }
  if (run) await prepareHydratedRun(run);
  input.install({ session, run });
  if (session.status !== 'awaiting_review') {
    input.publish({ proposal: null, stale: false });
    return;
  }
  if (session.approvalMode === 'auto') {
    await input.applyAutomatic(session.proposal?.options[0].operations.length ?? 0);
    return;
  }
  const stale = Boolean(session.proposal && isProposalStale(session.proposal, input.currentDoc));
  input.publish({ proposal: session.proposal, stale });
}
