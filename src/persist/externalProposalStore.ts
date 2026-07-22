// Pending proposal created by an external MCP client. The draft is kept in the
// editor session; once review starts, this record survives refresh/browser changes.

import type { Proposal } from '../agent/proposal';
import { parseProposal } from './proposalStore';
import { kvGet, kvSet } from './sharedKv';

export interface StoredExternalProposal {
  sessionId: string;
  clientName: string;
  status: 'awaiting_review' | 'applied' | 'rejected' | 'discarded';
  baseRevision: string;
  createdAt: number;
  operationCount: number;
  appliedOperationCount?: number;
  proposal: Proposal | null;
}

const STORED_STATUSES = new Set<StoredExternalProposal['status']>([
  'awaiting_review',
  'applied',
  'rejected',
  'discarded',
]);

const externalProposalKey = (projectId: string) => `external-proposal:${projectId}`;

function parseStoredExternalProposal(raw: unknown): StoredExternalProposal | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Partial<StoredExternalProposal>;
  const proposal = parseProposal(value.proposal);
  const status = STORED_STATUSES.has(value.status as StoredExternalProposal['status'])
    ? value.status as StoredExternalProposal['status']
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
