import type { ExternalSessionRunLedger } from '../../src/agent/external-run-ledger.ts';
import type { OfflineProjectCommitResult } from './offline-project-store.ts';
import type { ProjectEditOwnershipClaim } from './project-edit-ownership.ts';

export interface OfflineReviewFailure {
  readonly outcome: 'cancelled' | 'failed' | 'stale';
  readonly message: string;
  readonly staleProposal: boolean;
}
export type AppliedOfflineCommit = OfflineProjectCommitResult & {
  readonly status: 'applied';
  readonly revision: string;
  readonly ownership: ProjectEditOwnershipClaim;
};

export function isAppliedOfflineCommit(
  result: OfflineProjectCommitResult,
): result is AppliedOfflineCommit {
  return result.status === 'applied' && Boolean(result.revision && result.ownership);
}


export function failedOfflineCommit(disposed: boolean): OfflineReviewFailure {
  return {
    outcome: disposed ? 'cancelled' : 'failed',
    message: disposed
      ? 'The MCP transport closed before commit; the incremental draft checkpoint was preserved.'
      : 'The offline project commit failed; start a new MCP session to resume the saved draft.',
    staleProposal: false,
  };
}

export function rejectedOfflineCommit(input: {
  readonly result: OfflineProjectCommitResult;
  readonly disposed: boolean;
  readonly projectId: string;
  readonly editorUrl: string;
}): OfflineReviewFailure {
  const { result } = input;
  const outcome = input.disposed
    ? 'cancelled'
    : result.status === 'metadata-conflict'
      ? 'failed'
      : 'stale';
  const message = input.disposed
    ? 'The MCP transport closed before commit; the incremental draft checkpoint was preserved.'
    : result.status === 'browser-takeover'
      ? `Project ${input.projectId} opened in a browser before commit. Start a new MCP session at ${input.editorUrl}.`
      : result.status === 'stale'
        ? `Stored project ${input.projectId} changed before commit. Start a new MCP session.`
        : 'Project metadata kept changing; no offline edits were written.';
  return { outcome, message, staleProposal: outcome === 'stale' };
}

export async function publishOfflineReviewFailure(
  run: ExternalSessionRunLedger,
  proposalId: string | undefined,
  failure: OfflineReviewFailure,
): Promise<void> {
  if (proposalId && failure.staleProposal) {
    await run.proposal(proposalId, 'stale').catch(() => undefined);
  }
  await run.finalize(
    failure.outcome === 'failed' ? 'failed' : 'aborted',
    `Offline external edit session ${failure.outcome}.`,
  ).catch(() => undefined);
}

export async function publishAppliedOfflineReview(
  run: ExternalSessionRunLedger,
  proposalId: string | undefined,
  cleanupWarning: string | undefined,
): Promise<string | undefined> {
  try {
    if (proposalId) await run.proposal(proposalId, 'applied');
    await run.finalize('completed', 'Offline external edit session applied.');
    return cleanupWarning;
  } catch {
    return cleanupWarning
      ? `${cleanupWarning} The applied run ledger could not be finalized.`
      : 'The edit was applied, but the run ledger could not be finalized.';
  }
}
