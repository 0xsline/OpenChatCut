import {
  checkpointExternalEditSession,
  ExternalEditSessionOutcomeError,
  isExternalEditSessionStale,
  revisionOf,
  type ExternalEditSession,
} from './external-edit-session';
import type { StoredExternalProposal } from '../persist/externalProposalStore';
import type { ProjectDoc } from '../editor/types';

export const EXTERNAL_ACTIVE_STATUSES = new Set<ExternalEditSession['status']>([
  'drafting',
  'awaiting_review',
]);

export function throwIfExternalCallCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new ExternalEditSessionOutcomeError(
      'cancelled',
      'The external editor call was cancelled before it completed.',
    );
  }
}

export function externalSessionId(args: Record<string, unknown>): string {
  const value = args.editSessionId;
  if (typeof value !== 'string' || !value.trim()) {
    throw new ExternalEditSessionOutcomeError('rejected', 'editSessionId is required');
  }
  return value.trim();
}

export function findActiveExternalSession(
  sessions: ReadonlyMap<string, ExternalEditSession>,
): ExternalEditSession | undefined {
  return [...sessions.values()].find((session) => EXTERNAL_ACTIVE_STATUSES.has(session.status));
}

export function storedExternalSession(
  session: ExternalEditSession,
  status: StoredExternalProposal['status'] = session.status === 'drafting'
    ? 'drafting'
    : 'awaiting_review',
  appliedOperationCount?: number,
  agentRunId?: string,
): StoredExternalProposal {
  const drafting = status === 'drafting' && session.status === 'drafting';
  return {
    sessionId: session.id,
    clientName: session.clientName,
    approvalMode: session.approvalMode,
    status,
    baseRevision: session.baseRevision,
    createdAt: session.createdAt,
    operationCount: session.operationCount,
    appliedOperationCount,
    agentRunId: agentRunId ?? session.proposal?.agentRunId,
    draftCheckpoint: drafting ? checkpointExternalEditSession(session) : undefined,
    proposal: drafting ? null : session.proposal,
  };
}

export interface ExternalBindingIdentity {
  readonly projectId: string;
  readonly editorInstanceId: string;
  readonly baseRevision: string;
}

export async function validateExternalBridgeBinding(input: {
  readonly binding: ExternalBindingIdentity;
  readonly projectId: string;
  readonly editorInstanceId: string;
  readonly sessions: ReadonlyMap<string, ExternalEditSession>;
  readonly currentDoc: ProjectDoc;
  readonly markStale: (session: ExternalEditSession) => Promise<void>;
}): Promise<void> {
  if (input.binding.projectId !== input.projectId
      || input.binding.editorInstanceId !== input.editorInstanceId) {
    throw new ExternalEditSessionOutcomeError(
      'stale',
      'The editor call belongs to a different project or editor instance.',
    );
  }
  if (input.binding.baseRevision === revisionOf(input.currentDoc)) return;
  const active = findActiveExternalSession(input.sessions);
  if (active) await input.markStale(active);
  throw new ExternalEditSessionOutcomeError(
    'stale',
    `Project ${input.projectId} changed; re-initialize the MCP session.`,
  );
}

export function externalSessionInfo(input: {
  readonly session: ExternalEditSession;
  readonly currentDoc: ProjectDoc;
  readonly warning?: string;
  readonly runId?: string;
}): Record<string, unknown> {
  const { session } = input;
  return {
    editSessionId: session.id,
    status: session.status,
    clientName: session.clientName,
    approvalMode: session.approvalMode,
    baseRevision: session.baseRevision,
    operationCount: session.operationCount,
    agentRunId: input.runId ?? session.proposal?.agentRunId,
    appliedOperationCount: session.appliedOperationCount,
    warning: input.warning,
    stale: EXTERNAL_ACTIVE_STATUSES.has(session.status)
      ? isExternalEditSessionStale(session, input.currentDoc)
      : undefined,
    editorUrl: typeof window === 'undefined' ? undefined : window.location.href,
    approvalLocation: session.status === 'awaiting_review' && session.approvalMode === 'manual'
      ? 'OpenChatCut project UI'
      : undefined,
    updatedAt: new Date(session.updatedAt).toISOString(),
  };
}
