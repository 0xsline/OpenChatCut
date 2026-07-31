// Pending proposal created by an external MCP client. The draft is kept in the
// editor session; once review starts, this record survives refresh/browser changes.

import type {
  ExternalApprovalMode,
  ExternalEditSessionTerminalStatus,
} from '../agent/external-edit-session';
import type { Proposal } from '../agent/proposal';
import { parseProposal } from './proposalStore';
import { kvGet, kvSet } from './sharedKv';

export interface StoredExternalProposal {
  sessionId: string;
  clientName: string;
  approvalMode: ExternalApprovalMode;
  status: 'awaiting_review' | ExternalEditSessionTerminalStatus;
  baseRevision: string;
  createdAt: number;
  operationCount: number;
  appliedOperationCount?: number;
  proposal: Proposal | null;
}

const STORED_STATUSES: ReadonlySet<string> = new Set([
  'awaiting_review',
  'applied',
  'rejected',
  'cancelled',
  'stale',
  'failed',
]);

function isStoredStatus(value: unknown): value is StoredExternalProposal['status'] {
  return typeof value === 'string' && STORED_STATUSES.has(value);
}

const externalProposalKey = (projectId: string) => `external-proposal:${projectId}`;

function parseStoredExternalProposal(raw: unknown): StoredExternalProposal | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Partial<StoredExternalProposal>;
  const proposal = parseProposal(value.proposal);
  const rawStatus: unknown = value.status;
  const status = rawStatus === 'discarded'
    ? 'cancelled'
    : isStoredStatus(rawStatus)
      ? rawStatus
      : 'awaiting_review';
  if (
    typeof value.sessionId !== 'string'
    || typeof value.clientName !== 'string'
    || typeof value.baseRevision !== 'string'
    || typeof value.createdAt !== 'number'
    || (status === 'awaiting_review' && !proposal)
  ) return null;
  return {
    sessionId: value.sessionId,
    clientName: value.clientName,
    approvalMode: value.approvalMode === 'auto' ? 'auto' : 'manual',
    status,
    baseRevision: value.baseRevision,
    createdAt: value.createdAt,
    operationCount: typeof value.operationCount === 'number'
      ? value.operationCount
      : proposal?.options[0].operations.length ?? 0,
    appliedOperationCount: typeof value.appliedOperationCount === 'number'
      ? value.appliedOperationCount
      : undefined,
    proposal,
  };
}

export async function loadExternalProposal(projectId: string): Promise<StoredExternalProposal | null> {
  return parseStoredExternalProposal(await kvGet<unknown>(externalProposalKey(projectId)));
}

export async function saveExternalProposal(
  projectId: string,
  pending: StoredExternalProposal,
): Promise<void> {
  await kvSet(externalProposalKey(projectId), pending);
}
