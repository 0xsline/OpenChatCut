import type { AgentContext } from './context';
import {
  captureExternalToolActions,
  createExternalEditSession,
  externalDraftContext,
  finishExternalEditSession,
  forkExternalEditSession,
  isExternalEditSessionStale,
  revisionOf,
  restoreExternalEditSession,
  reviewExternalEditSession,
  type ExternalEditSession,
} from './external-edit-session';
import { executeTool } from './tools';
import { isExternalDraftTool } from './external-tool-policy';
import { isProposalStale, type Proposal } from './proposal';
import { replayActions } from '../editor/store';
import { saveProject } from '../persist/projectStore';
import {
  saveExternalProposal,
  type StoredExternalProposal,
} from '../persist/externalProposalStore';

export interface ExternalProposalSnapshot {
  proposal: Proposal | null;
  stale: boolean;
}

const ACTIVE_STATUSES = new Set<ExternalEditSession['status']>(['drafting', 'awaiting_review']);

function requiredSessionId(args: Record<string, unknown>): string {
  const value = args.editSessionId;
  if (typeof value !== 'string' || !value.trim()) throw new Error('editSessionId is required');
  return value.trim();
}

function findActiveSession(sessions: Map<string, ExternalEditSession>): ExternalEditSession | undefined {
  return [...sessions.values()].find((session) => ACTIVE_STATUSES.has(session.status));
}

function storedSession(
  session: ExternalEditSession,
  status: StoredExternalProposal['status'] = 'awaiting_review',
  appliedOperationCount?: number,
): StoredExternalProposal {
  return {
    sessionId: session.id,
    clientName: session.clientName,
    status,
    baseRevision: session.baseRevision,
    createdAt: session.createdAt,
    operationCount: session.operationCount,
    appliedOperationCount,
    proposal: session.proposal,
  };
}

export class ExternalBridgeRuntime {
  private sessions = new Map<string, ExternalEditSession>();
  private proposalSessionId: string | null = null;
  private readonly projectId: string;
  private readonly getContext: () => AgentContext;
  private readonly publish: (snapshot: ExternalProposalSnapshot) => void;

  constructor(
    projectId: string,
    getContext: () => AgentContext,
    publish: (snapshot: ExternalProposalSnapshot) => void,
  ) {
    this.projectId = projectId;
    this.getContext = getContext;
    this.publish = publish;
  }

  hydrate(pending: StoredExternalProposal | null): void {
    this.sessions = new Map();
    this.proposalSessionId = null;
    if (!pending) {
      this.publish({ proposal: null, stale: false });
      return;
    }
    const session = restoreExternalEditSession(pending, this.getContext().getDoc());
    this.sessions.set(session.id, session);
    if (session.status === 'awaiting_review') {
      this.proposalSessionId = session.id;
      const stale = Boolean(session.proposal && isProposalStale(session.proposal, this.getContext().getDoc()));
      this.publish({ proposal: session.proposal, stale });
    } else {
      this.publish({ proposal: null, stale: false });
    }
  }

  async execute(name: string, rawArgs: Record<string, unknown>): Promise<unknown> {
    const args = { ...rawArgs };
    if (name === 'begin_edit_session') return this.begin(args.clientName);
    const session = this.requireSession(requiredSessionId(args));
    delete args.editSessionId;
    if (name === 'get_edit_session') return this.info(session);
    if (name === 'discard_edit_session') return this.discard(session);
    if (name === 'review_edit_session') return this.review(session, args.summary);
    return this.runEditorTool(session, name, args);
  }

  async apply(selected: Set<number>, force = false): Promise<void> {
    const session = this.currentProposalSession();
    const proposal = session?.proposal;
    if (!session || !proposal) return;
    const context = this.getContext();
    const currentDoc = context.getDoc();
    if (!force && isProposalStale(proposal, currentDoc)) {
      this.publish({ proposal, stale: true });
      return;
    }
    const chosen = proposal.options[0].operations.filter((_, index) => selected.has(index));
    const result = replayActions(currentDoc, chosen.flatMap((operation) => operation.actions));
    const saveResult = await saveProject(this.projectId, result);
    if (!saveResult.saved) {
      throw new Error('The edited project could not be saved. The proposal remains pending.');
    }
    const latestDoc = context.getDoc();
    if (revisionOf(latestDoc) !== revisionOf(currentDoc)) {
      const restored = await saveProject(this.projectId, latestDoc);
      this.publish({ proposal, stale: true });
      if (!restored.saved) {
        throw new Error('The project changed while applying and its saved copy could not be restored. Reload before continuing.');
      }
      throw new Error(`Edit session ${session.id} became stale while applying; the proposal remains pending.`);
    }
    await saveExternalProposal(this.projectId, storedSession(session, 'applied', chosen.length));
    const commitDoc = context.getDoc();
    if (revisionOf(commitDoc) !== revisionOf(currentDoc)) {
      await saveExternalProposal(this.projectId, storedSession(session));
      const restored = await saveProject(this.projectId, commitDoc);
      this.publish({ proposal, stale: true });
      if (!restored.saved) {
        throw new Error('The project changed while applying and its saved copy could not be restored. Reload before continuing.');
      }
      throw new Error(`Edit session ${session.id} became stale while applying; the proposal remains pending.`);
    }
    context.commands.applyDoc(result);
    this.finishInMemory(session, 'applied', chosen.length);
    if (!saveResult.indexUpdated) {
      throw new Error('The edit was applied, but the project list timestamp could not be updated.');
    }
  }

  async reject(): Promise<void> {
    const session = this.currentProposalSession();
    if (session) await this.complete(session, 'rejected');
  }

  private begin(clientName: unknown): unknown {
    const active = findActiveSession(this.sessions);
    if (active) throw new Error(`Resolve or discard active edit session ${active.id} first.`);
    const context = this.getContext();
    const session = createExternalEditSession(context.getDoc(), clientName);
    this.sessions.set(session.id, session);
    return this.info(session);
  }

  private async review(session: ExternalEditSession, summary: unknown): Promise<unknown> {
    const reviewed = reviewExternalEditSession(session, summary);
    await saveExternalProposal(this.projectId, storedSession(reviewed));
    this.sessions.set(session.id, reviewed);
    this.proposalSessionId = reviewed.id;
    const stale = Boolean(reviewed.proposal && isProposalStale(reviewed.proposal, this.getContext().getDoc()));
    this.publish({ proposal: reviewed.proposal, stale });
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    return this.info(reviewed);
  }

  private async discard(session: ExternalEditSession): Promise<unknown> {
    if (!ACTIVE_STATUSES.has(session.status)) return this.info(session);
    const finished = finishExternalEditSession(session, 'discarded');
    await saveExternalProposal(this.projectId, storedSession(session, 'discarded'));
    this.sessions.set(session.id, finished);
    if (this.proposalSessionId === session.id) {
      this.proposalSessionId = null;
      this.publish({ proposal: null, stale: false });
    }
    return this.info(finished);
  }

  private async runEditorTool(
    session: ExternalEditSession,
    name: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    if (!isExternalDraftTool(name)) throw new Error(`Tool ${name} is not available in isolated edit sessions.`);
    if (session.status !== 'drafting') {
      throw new Error(`Edit session ${session.id} is ${session.status}; editor tools require drafting status.`);
    }
    if (isExternalEditSessionStale(session, this.getContext().getDoc())) {
      throw new Error(`Edit session ${session.id} is stale; discard it and begin a new session.`);
    }
    const candidate = forkExternalEditSession(session);
    const result = await executeTool(name, args, externalDraftContext(candidate, this.getContext()));
    this.sessions.set(session.id, captureExternalToolActions(candidate, name, args));
    return result;
  }

  private requireSession(sessionId: string): ExternalEditSession {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Unknown edit session ${sessionId}`);
    return session;
  }

  private currentProposalSession(): ExternalEditSession | undefined {
    return this.proposalSessionId ? this.sessions.get(this.proposalSessionId) : undefined;
  }

  private async complete(
    session: ExternalEditSession,
    status: 'applied' | 'rejected',
    appliedOperationCount?: number,
  ): Promise<void> {
    await saveExternalProposal(this.projectId, storedSession(session, status, appliedOperationCount));
    this.finishInMemory(session, status, appliedOperationCount);
  }

  private finishInMemory(
    session: ExternalEditSession,
    status: 'applied' | 'rejected',
    appliedOperationCount?: number,
  ): void {
    this.sessions.set(session.id, finishExternalEditSession(session, status, appliedOperationCount));
    this.proposalSessionId = null;
    this.publish({ proposal: null, stale: false });
  }

  private info(session: ExternalEditSession): Record<string, unknown> {
    const currentDoc = this.getContext().getDoc();
    return {
      editSessionId: session.id,
      status: session.status,
      clientName: session.clientName,
      baseRevision: session.baseRevision,
      operationCount: session.operationCount,
      appliedOperationCount: session.appliedOperationCount,
      stale: ACTIVE_STATUSES.has(session.status) ? isExternalEditSessionStale(session, currentDoc) : undefined,
      editorUrl: typeof window === 'undefined' ? undefined : window.location.href,
      approvalLocation: session.status === 'awaiting_review' ? 'OpenChatCut project UI' : undefined,
      updatedAt: new Date(session.updatedAt).toISOString(),
    };
  }
}
