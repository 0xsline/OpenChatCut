import type { ExternalApprovalGate } from './external-approval-gate';
import type {
  ExternalEditSession,
  ExternalEditSessionTerminalStatus,
} from './external-edit-session';
import type { ExternalSessionRunLedger } from './external-run-ledger';

export async function finalizeExternalSessionRun(
  session: ExternalEditSession,
  status: ExternalEditSessionTerminalStatus,
  approvalGate: ExternalApprovalGate,
  run: ExternalSessionRunLedger | undefined,
  rejectGuard: (guardId: string) => Promise<void>,
): Promise<void> {
  for (const approval of approvalGate.pendingForSession(session.id)) {
    await rejectGuard(approval.guardId);
  }
  approvalGate.clearSessionAllowances(session.id);
  if (!run) return;
  const proposalId = session.proposal?.id;
  if (proposalId && (status === 'applied' || status === 'rejected' || status === 'stale')) {
    await run.proposal(proposalId, status);
  }
  const finalStatus = status === 'applied' || status === 'rejected'
    ? 'completed'
    : status === 'cancelled' || status === 'stale'
      ? 'aborted'
      : 'failed';
  await run.finalize(finalStatus, `External edit session ${status}.`);
}
