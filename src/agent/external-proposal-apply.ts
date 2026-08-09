import type { AgentContext } from './context';
import {
  ExternalEditSessionOutcomeError,
  revisionOf,
  type ExternalEditSession,
  type ExternalEditSessionTerminalStatus,
} from './external-edit-session';
import {
  storedExternalSession,
  throwIfExternalCallCancelled,
} from './external-bridge-session';
import { isProposalStale, type Proposal } from './proposal';
import { replayActions } from '../editor/store';
import type { ProjectDoc } from '../editor/types';
import { saveProject } from '../persist/projectStore';
import { saveAutomaticVersion } from '../persist/versionStore';
import { saveExternalProposal } from '../persist/externalProposalStore';

export interface ExternalBridgePersistence {
  saveProject: typeof saveProject;
  saveAutomaticVersion: typeof saveAutomaticVersion;
  saveExternalProposal: typeof saveExternalProposal;
}

interface CommitExternalProposalInput {
  readonly projectId: string;
  readonly session: ExternalEditSession;
  readonly proposal: Proposal;
  readonly selected: ReadonlySet<number>;
  readonly force: boolean;
  readonly exposeProposal: boolean;
  readonly signal?: AbortSignal;
  readonly context: AgentContext;
  readonly persistence: ExternalBridgePersistence;
  readonly publishStale: () => void;
  readonly markTerminal: (
    status: ExternalEditSessionTerminalStatus,
  ) => Promise<void>;
}

export type ExternalProposalCommitResult =
  | { readonly status: 'stale-exposed' }
  | {
    readonly status: 'committed';
    readonly result: ProjectDoc;
    readonly appliedOperationCount: number;
    readonly indexUpdated: boolean;
  };

interface LiveApplyInterruption {
  readonly status: 'cancelled' | 'stale' | 'failed';
  readonly latestDoc: ProjectDoc;
}

function applyLiveResultIfCurrent(
  input: CommitExternalProposalInput,
  expectedRevision: string,
  result: ProjectDoc,
): LiveApplyInterruption | null {
  const latestDoc = input.context.getDoc();
  if (input.signal?.aborted) return { status: 'cancelled', latestDoc };
  if (revisionOf(latestDoc) !== expectedRevision) return { status: 'stale', latestDoc };
  try {
    input.context.commands.applyDoc(result);
    return null;
  } catch {
    return { status: 'failed', latestDoc };
  }
}

async function restoreInterruptedApplyBeforePublication(
  input: CommitExternalProposalInput,
  interruption: LiveApplyInterruption,
): Promise<void> {
  const restored = await input.persistence.saveProject(input.projectId, interruption.latestDoc);
  if (restored.saved) {
    if (interruption.status === 'stale' && input.exposeProposal) input.publishStale();
    return;
  }
  await input.markTerminal('failed');
  throw new ExternalEditSessionOutcomeError(
    'failed',
    'The edited project could not be restored after its live commit was interrupted. Reload before continuing.',
  );
}

function rollbackLiveResult(
  input: CommitExternalProposalInput,
  result: ProjectDoc,
  previous: ProjectDoc,
): ProjectDoc {
  const latestDoc = input.context.getDoc();
  if (revisionOf(latestDoc) !== revisionOf(result)) return latestDoc;
  input.context.commands.applyDoc(previous);
  return previous;
}

async function publishAppliedProposal(
  input: CommitExternalProposalInput,
  operationCount: number,
  previous: ProjectDoc,
  result: ProjectDoc,
): Promise<void> {
  try {
    await input.persistence.saveExternalProposal(
      input.projectId,
      storedExternalSession(input.session, 'applied', operationCount),
    );
  } catch {
    const restoredDoc = rollbackLiveResult(input, result, previous);
    const restored = await input.persistence.saveProject(input.projectId, restoredDoc);
    if (!restored.saved) {
      await input.markTerminal('failed');
      throw new ExternalEditSessionOutcomeError(
        'failed',
        'The proposal commit and project restoration both failed. Reload before continuing.',
      );
    }
    throw new ExternalEditSessionOutcomeError(
      'failed',
      'The proposal commit could not be published; the latest project was restored and the proposal remains pending.',
    );
  }
}


export async function commitExternalProposal(
  input: CommitExternalProposalInput,
): Promise<ExternalProposalCommitResult> {
  const currentDoc = input.context.getDoc();
  if (!input.force && isProposalStale(input.proposal, currentDoc)) {
    if (input.exposeProposal) {
      input.publishStale();
      return { status: 'stale-exposed' };
    }
    await input.markTerminal('stale');
    throw new ExternalEditSessionOutcomeError(
      'stale',
      `Edit session ${input.session.id} is stale; begin a new session.`,
    );
  }
  const chosen = input.proposal.options[0].operations
    .filter((_, index) => input.selected.has(index));
  const result = replayActions(currentDoc, chosen.flatMap((operation) => operation.actions));
  await input.persistence.saveAutomaticVersion(input.projectId, '外部 Agent 修改前', currentDoc);
  throwIfExternalCallCancelled(input.signal);
  const saved = await input.persistence.saveProject(input.projectId, result);
  if (!saved.saved) {
    throw new ExternalEditSessionOutcomeError(
      'failed',
      'The edited project could not be saved. The proposal remains pending.',
    );
  }
  const expectedRevision = revisionOf(currentDoc);
  const interruption = applyLiveResultIfCurrent(input, expectedRevision, result);
  if (interruption) {
    await restoreInterruptedApplyBeforePublication(input, interruption);
    if (interruption.status === 'stale' && input.exposeProposal) {
      return { status: 'stale-exposed' };
    }
    throw new ExternalEditSessionOutcomeError(
      interruption.status,
      interruption.status === 'cancelled'
        ? 'The apply was cancelled before its terminal commit was published; the proposal remains pending.'
        : interruption.status === 'stale'
          ? `Edit session ${input.session.id} became stale while applying; the proposal remains pending.`
          : 'The open editor could not apply the saved edit; the latest project was restored and the proposal remains pending.',
    );
  }
  await publishAppliedProposal(input, chosen.length, currentDoc, result);
  return {
    status: 'committed', result,
    appliedOperationCount: chosen.length, indexUpdated: saved.indexUpdated,
  };
}
