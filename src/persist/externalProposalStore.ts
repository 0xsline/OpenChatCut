// External edit-session state shared across reloads. Persisted values are
// untrusted; drafting checkpoints are admitted only after full boundary checks.

import type {
  ExternalApprovalMode,
  ExternalDraftCheckpoint,
  ExternalEditSessionTerminalStatus,
} from '../agent/external-edit-session';
import type { Operation, Proposal } from '../agent/proposal';
import type { AnyAction } from '../editor/store';
import { parseProposal } from './proposalStore';
import { migrateProjectDoc } from './projectStore';
import { kvGet, kvSet } from './sharedKv';

export interface StoredExternalProposal {
  sessionId: string;
  clientName: string;
  approvalMode: ExternalApprovalMode;
  status: 'drafting' | 'awaiting_review' | ExternalEditSessionTerminalStatus;
  baseRevision: string;
  createdAt: number;
  operationCount: number;
  appliedOperationCount?: number;
  agentRunId?: string;
  draftCheckpoint?: ExternalDraftCheckpoint;
  proposal: Proposal | null;
}

const STORED_STATUSES: Record<StoredExternalProposal['status'], true> = {
  drafting: true,
  awaiting_review: true,
  applied: true,
  rejected: true,
  cancelled: true,
  stale: true,
  failed: true,
};
const externalProposalKey = (projectId: string) => `external-proposal:${projectId}`;
const finiteTime = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;

function isStoredStatus(value: unknown): value is StoredExternalProposal['status'] {
  return typeof value === 'string' && value in STORED_STATUSES;
}

function isAction(value: unknown): value is AnyAction {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return typeof (value as Partial<AnyAction>).type === 'string';
}

function isOperation(value: unknown): value is Operation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const operation = value as Partial<Operation>;
  if (!operation.args || typeof operation.args !== 'object' || Array.isArray(operation.args)
      || !Array.isArray(operation.actions)) return false;
  return typeof operation.tool === 'string' && operation.actions.every(isAction)
    && typeof operation.action === 'string' && typeof operation.target === 'string'
    && typeof operation.impact === 'string';
}

function parseDraftCheckpoint(
  raw: unknown,
  stored: Pick<StoredExternalProposal, 'sessionId' | 'clientName' | 'approvalMode' | 'baseRevision' | 'createdAt'>,
): ExternalDraftCheckpoint | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const checkpoint = raw as Partial<ExternalDraftCheckpoint>;
  if (checkpoint.version !== 1 || checkpoint.sessionId !== stored.sessionId
      || checkpoint.clientName !== stored.clientName
      || checkpoint.approvalMode !== stored.approvalMode
      || checkpoint.baseRevision !== stored.baseRevision
      || checkpoint.createdAt !== stored.createdAt || !finiteTime(checkpoint.updatedAt)
      || checkpoint.updatedAt < stored.createdAt || !Array.isArray(checkpoint.operations)
      || !checkpoint.operations.every(isOperation)) return null;
  const draftDoc = migrateProjectDoc(checkpoint.draftDoc);
  if (!draftDoc) return null;
  return {
    version: 1, sessionId: stored.sessionId, clientName: stored.clientName,
    approvalMode: stored.approvalMode, baseRevision: stored.baseRevision,
    draftDoc, operations: checkpoint.operations, createdAt: stored.createdAt,
    updatedAt: checkpoint.updatedAt,
  };
}

function malformedDraft(
  value: Partial<StoredExternalProposal>,
  common: Pick<StoredExternalProposal, 'sessionId' | 'clientName' | 'approvalMode' | 'baseRevision' | 'createdAt'>,
): StoredExternalProposal {
  const operationCount = typeof value.operationCount === 'number'
      && Number.isInteger(value.operationCount) && value.operationCount >= 0
    ? value.operationCount
    : 0;
  return {
    ...common, status: 'stale', operationCount,
    agentRunId: typeof value.agentRunId === 'string' ? value.agentRunId : undefined,
    proposal: null,
  };
}

function parseStoredExternalProposal(raw: unknown): StoredExternalProposal | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const value = raw as Partial<StoredExternalProposal>;
  const rawStatus: unknown = value.status;
  const status = rawStatus === 'discarded'
    ? 'cancelled' : isStoredStatus(rawStatus) ? rawStatus : 'awaiting_review';
  if (typeof value.sessionId !== 'string' || typeof value.clientName !== 'string'
      || typeof value.baseRevision !== 'string' || !finiteTime(value.createdAt)) return null;
  const approvalMode: ExternalApprovalMode = value.approvalMode === 'auto' ? 'auto' : 'manual';
  const proposal = parseProposal(value.proposal);
  const common: Pick<
    StoredExternalProposal,
    'sessionId' | 'clientName' | 'approvalMode' | 'baseRevision' | 'createdAt'
  > = {
    sessionId: value.sessionId, clientName: value.clientName, approvalMode,
    baseRevision: value.baseRevision, createdAt: value.createdAt,
  };
  const checkpoint = status === 'drafting'
    ? parseDraftCheckpoint(value.draftCheckpoint, common) : null;
  if (status === 'drafting' && (!checkpoint || typeof value.agentRunId !== 'string'
      || !value.agentRunId || value.operationCount !== checkpoint.operations.length)) {
    return malformedDraft(value, common);
  }
  if (status === 'awaiting_review' && !proposal) return null;
  return {
    ...common, status,
    operationCount: typeof value.operationCount === 'number'
      ? value.operationCount : proposal?.options[0].operations.length ?? 0,
    appliedOperationCount: typeof value.appliedOperationCount === 'number'
      ? value.appliedOperationCount : undefined,
    agentRunId: typeof value.agentRunId === 'string' ? value.agentRunId : proposal?.agentRunId,
    draftCheckpoint: checkpoint ?? undefined,
    proposal: status === 'drafting' ? null : proposal,
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
