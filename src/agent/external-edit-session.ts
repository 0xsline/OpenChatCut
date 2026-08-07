import type { AgentContext } from './context';
import { buildOperation, buildProposal, type Operation, type Proposal } from './proposal';
import { makeDraft, type DraftEngine } from '../editor/store';
import type { ProjectDoc } from '../editor/types';

export type ExternalEditSessionTerminalStatus =
  | 'applied'
  | 'rejected'
  | 'cancelled'
  | 'stale'
  | 'failed';

export type ExternalEditSessionStatus =
  | 'drafting'
  | 'awaiting_review'
  | ExternalEditSessionTerminalStatus;

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
export interface ExternalDraftCheckpoint {
  version: 1;
  sessionId: string;
  clientName: string;
  approvalMode: ExternalApprovalMode;
  baseRevision: string;
  draftDoc: ProjectDoc;
  operations: Operation[];
  createdAt: number;
  updatedAt: number;
}


export class ExternalEditSessionOutcomeError extends Error {
  readonly outcome: Exclude<ExternalEditSessionTerminalStatus, 'applied'>;

  constructor(
    outcome: Exclude<ExternalEditSessionTerminalStatus, 'applied'>,
    message: string,
  ) {
    super(message);
    this.name = 'ExternalEditSessionOutcomeError';
    this.outcome = outcome;
  }
}

function canonicalProjectJson(doc: ProjectDoc): string {
  return JSON.stringify(doc, (_key, value: unknown) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
    const record = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(record).sort().map((key) => [key, record[key]]));
  });
}

export function revisionOf(doc: ProjectDoc): string {
  const input = canonicalProjectJson(doc);
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
export function checkpointExternalEditSession(
  session: ExternalEditSession,
): ExternalDraftCheckpoint {
  if (session.status !== 'drafting' || !session.draft) {
    throw new Error(`Edit session ${session.id} is ${session.status}, not drafting.`);
  }
  return {
    version: 1,
    sessionId: session.id,
    clientName: session.clientName,
    approvalMode: session.approvalMode,
    baseRevision: session.baseRevision,
    draftDoc: session.draft.getDoc(),
    operations: session.operations,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
  };
}

export function restoreDraftingExternalEditSession(
  checkpoint: ExternalDraftCheckpoint,
  baseDoc: ProjectDoc,
): ExternalEditSession {
  return {
    id: checkpoint.sessionId,
    clientName: normalizedClientName(checkpoint.clientName),
    approvalMode: normalizedApprovalMode(checkpoint.approvalMode),
    status: 'drafting',
    baseRevision: checkpoint.baseRevision,
    baseDoc,
    draft: makeDraft(checkpoint.draftDoc),
    operations: checkpoint.operations,
    operationCount: checkpoint.operations.length,
    proposal: null,
    createdAt: checkpoint.createdAt,
    updatedAt: checkpoint.updatedAt,
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
  status?: 'awaiting_review' | ExternalEditSessionTerminalStatus | 'discarded';
  baseRevision: string;
  createdAt: number;
  appliedOperationCount?: number;
  operationCount: number;
  proposal: Proposal | null;
}, fallbackDoc: ProjectDoc): ExternalEditSession {
  const status = input.status === 'discarded' ? 'cancelled' : input.status ?? 'awaiting_review';
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
  status: ExternalEditSessionTerminalStatus,
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
