import type { AgentContext } from './context';
import { buildOperation, buildProposal, type Operation, type Proposal } from './proposal';
import { makeDraft, type DraftEngine } from '../editor/store';
import type { ProjectDoc } from '../editor/types';

export type ExternalEditSessionStatus =
  | 'drafting'
  | 'awaiting_review'
  | 'applied'
  | 'rejected'
  | 'discarded';

export type ExternalApprovalMode = 'manual' | 'auto';

export interface ExternalEditSession {
  id: string;
  clientName: string;
  approvalMode: ExternalApprovalMode;
  status: ExternalEditSessionStatus;
  baseRevision: string;
  baseDoc: ProjectDoc;
  draft: DraftEngine | null;
  operations: Operation[];
  operationCount: number;
  proposal: Proposal | null;
  createdAt: number;
  updatedAt: number;
  appliedOperationCount?: number;
}

export function revisionOf(doc: ProjectDoc): string {
  const input = JSON.stringify(doc);
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `v${doc.version}-${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

function normalizedClientName(value: unknown): string {
  if (typeof value !== 'string') return 'External Agent';
  const name = value.trim().slice(0, 40);
  return name || 'External Agent';
}

function normalizedApprovalMode(value: unknown): ExternalApprovalMode {
  if (value === undefined || value === 'manual') return 'manual';
  if (value === 'auto') return 'auto';
  throw new Error('approvalMode must be "manual" or "auto".');
}

export function isExternalEditSessionStale(session: ExternalEditSession, liveDoc: ProjectDoc): boolean {
  return session.baseRevision !== revisionOf(liveDoc);
}

export function createExternalEditSession(
  baseDoc: ProjectDoc,
  clientName?: unknown,
  approvalMode?: unknown,
): ExternalEditSession {
  const now = Date.now();
  return {
    id: crypto.randomUUID(),
    clientName: normalizedClientName(clientName),
    approvalMode: normalizedApprovalMode(approvalMode),
    status: 'drafting',
    baseRevision: revisionOf(baseDoc),
    baseDoc,
    draft: makeDraft(baseDoc),
    operations: [],
    operationCount: 0,
    proposal: null,
    createdAt: now,
    updatedAt: now,
  };
}

/** Draft contexts deliberately omit live project navigation/rename callbacks. */
export function externalDraftContext(session: ExternalEditSession, live: AgentContext): AgentContext {
  if (!session.draft) throw new Error(`Edit session ${session.id} is no longer writable.`);
  return {
    commands: session.draft.commands,
    getState: session.draft.getState,
    getDoc: session.draft.getDoc,
    getCreativeMode: live.getCreativeMode,
    templates: live.templates,
    audio: live.audio,
    getProjectId: live.getProjectId,
  };
}

/** Isolate one tool call so a throwing tool cannot leave a half-written draft. */
export function forkExternalEditSession(session: ExternalEditSession): ExternalEditSession {
  if (session.status !== 'drafting' || !session.draft) {
    throw new Error(`Edit session ${session.id} is ${session.status}, not drafting.`);
  }
  return { ...session, draft: makeDraft(session.draft.getDoc()) };
}

/** Capture only EditorCore actions; the live project remains untouched. */
export function captureExternalToolActions(
  session: ExternalEditSession,
  tool: string,
  args: Record<string, unknown>,
): ExternalEditSession {
  if (!session.draft) throw new Error(`Edit session ${session.id} is no longer writable.`);
  const actions = session.draft.takeActions();
  const operations = actions.length
    ? [...session.operations, buildOperation(tool, args, actions)]
    : session.operations;
  return { ...session, operations, operationCount: operations.length, updatedAt: Date.now() };
}

export function reviewExternalEditSession(
  session: ExternalEditSession,
  summary?: unknown,
): ExternalEditSession {
  if (session.status !== 'drafting' || !session.draft) {
    throw new Error(`Edit session ${session.id} is ${session.status}, not drafting.`);
  }
  if (!session.operationCount) throw new Error('The edit session has no staged project changes to review.');
  const text = typeof summary === 'string' ? summary.trim() : '';
  const proposal = buildProposal(session.operations, text, session.baseDoc, session.draft.getState());
  return {
    ...session,
    status: 'awaiting_review',
    draft: null,
    proposal: { ...proposal, title: session.clientName },
    updatedAt: Date.now(),
  };
}

export function restoreExternalEditSession(input: {
  sessionId: string;
  clientName: string;
  approvalMode?: ExternalApprovalMode;
  status?: Extract<ExternalEditSessionStatus, 'awaiting_review' | 'applied' | 'rejected' | 'discarded'>;
  baseRevision: string;
  createdAt: number;
  appliedOperationCount?: number;
  operationCount: number;
  proposal: Proposal | null;
}, fallbackDoc: ProjectDoc): ExternalEditSession {
  const status = input.status ?? 'awaiting_review';
  return {
    id: input.sessionId,
    clientName: input.clientName,
    approvalMode: normalizedApprovalMode(input.approvalMode),
    status,
    baseRevision: input.baseRevision,
    baseDoc: input.proposal?.baseDoc ?? fallbackDoc,
    draft: null,
    operations: input.proposal?.options[0].operations ?? [],
    operationCount: input.operationCount,
    proposal: status === 'awaiting_review' ? input.proposal : null,
    createdAt: input.createdAt,
    updatedAt: Date.now(),
    appliedOperationCount: input.appliedOperationCount,
  };
}

export function finishExternalEditSession(
  session: ExternalEditSession,
  status: Extract<ExternalEditSessionStatus, 'applied' | 'rejected' | 'discarded'>,
  appliedOperationCount?: number,
): ExternalEditSession {
  return {
    ...session,
    status,
    draft: null,
    proposal: null,
    updatedAt: Date.now(),
    appliedOperationCount,
  };
}
