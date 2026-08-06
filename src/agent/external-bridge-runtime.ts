import type { AgentContext } from './context';
import {
  captureExternalToolActions,
  createExternalEditSession,
  ExternalEditSessionOutcomeError,
  externalDraftContext,
  finishExternalEditSession,
  forkExternalEditSession,
  isExternalEditSessionStale,
  revisionOf,
  restoreExternalEditSession,
  reviewExternalEditSession,
  type ExternalEditSession,
  type ExternalEditSessionTerminalStatus,
} from './external-edit-session';
import { executeTool } from './tools';
import { isExternalDraftTool, isExternalGlobalReadTool, isExternalRealTool } from './external-tool-policy';
import { isProposalStale, type Proposal } from './proposal';
import { replayActions } from '../editor/store';
import { saveProject } from '../persist/projectStore';
import { saveAutomaticVersion } from '../persist/versionStore';
import {
  saveExternalProposal,
  type StoredExternalProposal,
} from '../persist/externalProposalStore';

export interface ExternalProposalSnapshot {
  proposal: Proposal | null;
  stale: boolean;
}

/** Confirmation request for a real-project tool (generation/export/import/…)
 * issued from an external session; the user decides in the OpenChatCut UI. */
export interface ExternalGuardRequest {
  id: string;
  sessionId: string;
  tool: string;
  summary: string;
}

export interface ExternalBridgeBinding {
  projectId: string;
  editorInstanceId: string;
  baseRevision: string;
}

const ACTIVE_STATUSES = new Set<ExternalEditSession['status']>(['drafting', 'awaiting_review']);
const INDEX_UPDATE_WARNING = 'The edit was applied, but the project list timestamp could not be updated.';

interface ExternalBridgePersistence {
  saveProject: typeof saveProject;
  saveAutomaticVersion: typeof saveAutomaticVersion;
  saveExternalProposal: typeof saveExternalProposal;
}

const DEFAULT_PERSISTENCE: ExternalBridgePersistence = {
  saveProject,
  saveAutomaticVersion,
  saveExternalProposal,
};


function throwIfCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new ExternalEditSessionOutcomeError(
      'cancelled',
      'The external editor call was cancelled before it completed.',
    );
  }
}

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
    approvalMode: session.approvalMode,
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
  private terminalRevisions = new Map<string, string>();
  private sessionWarnings = new Map<string, string>();
  private proposalSessionId: string | null = null;
  private readonly projectId: string;
  private readonly editorInstanceId: string;
  private readonly getContext: () => AgentContext;
  private readonly publish: (snapshot: ExternalProposalSnapshot) => void;
  private readonly persistence: ExternalBridgePersistence;
  /** sessionId → tools the user has confirmed for real-project execution. */
  private readonly confirmedRealTools = new Map<string, Set<string>>();
  /** pending confirmation id → tool name, so confirm/deny can resolve by id. */
  private readonly pendingGuardById = new Map<string, { sessionId: string; tool: string }>();
  /** UI hook: a real-project tool needs the user's confirmation. */
  onGuardRequest: ((request: ExternalGuardRequest) => void) | null = null;

  constructor(
    projectId: string,
    editorInstanceId: string,
    getContext: () => AgentContext,
    publish: (snapshot: ExternalProposalSnapshot) => void,
    persistence: ExternalBridgePersistence = DEFAULT_PERSISTENCE,
  ) {
    this.projectId = projectId;
    this.editorInstanceId = editorInstanceId;
    this.getContext = getContext;
    this.publish = publish;
    this.persistence = persistence;
  }

  binding(): ExternalBridgeBinding {
    return {
      projectId: this.projectId,
      editorInstanceId: this.editorInstanceId,
      baseRevision: revisionOf(this.getContext().getDoc()),
    };
  }

  async hydrate(pending: StoredExternalProposal | null): Promise<void> {
    this.sessions = new Map();
    this.terminalRevisions = new Map();
    this.sessionWarnings = new Map();
    this.proposalSessionId = null;
    if (!pending) {
      this.publish({ proposal: null, stale: false });
      return;
    }
    const session = restoreExternalEditSession(pending, this.getContext().getDoc());
    this.sessions.set(session.id, session);
    if (session.status === 'awaiting_review') {
      this.proposalSessionId = session.id;
      if (session.approvalMode === 'auto') {
        const count = session.proposal?.options[0].operations.length ?? 0;
        await this.apply(new Set(Array.from({ length: count }, (_, index) => index)), false, false);
        return;
      }
      const stale = Boolean(session.proposal && isProposalStale(session.proposal, this.getContext().getDoc()));
      this.publish({ proposal: session.proposal, stale });
    } else {
      this.publish({ proposal: null, stale: false });
    }
  }

  async execute(
    name: string,
    rawArgs: Record<string, unknown>,
    binding: ExternalBridgeBinding,
    signal?: AbortSignal,
  ): Promise<unknown> {
    throwIfCancelled(signal);
    const args = { ...rawArgs };
    if (name === 'begin_edit_session') {
      await this.validateBinding(binding);
      throwIfCancelled(signal);
      return this.begin(args.clientName, args.approvalMode);
    }
    if (isExternalGlobalReadTool(name)) {
      await this.validateBinding(binding);
      throwIfCancelled(signal);
      return executeTool(name, args, this.getContext());
    }
    const sessionId = requiredSessionId(args);
    const session = this.sessions.get(sessionId);
    if (name === 'discard_edit_session') {
      // Cross-transport release: a client that lost its connection must be
      // able to discard a stale session to unblock a new begin. Discard only
      // abandons the draft — it never writes the project — so binding strictness
      // is waived here.
      if (!session) {
        await this.validateBinding(binding);
        throw new Error(`Unknown edit session ${sessionId}`);
      }
      throwIfCancelled(signal);
      return this.discard(session);
    }
    if (name === 'get_edit_session') {
      if (!session) {
        await this.validateBinding(binding);
        throw new Error(`Unknown edit session ${sessionId}`);
      }
      await this.validateTerminalReadBinding(binding, session);
      throwIfCancelled(signal);
      return this.info(session);
    }
    await this.validateBinding(binding);
    throwIfCancelled(signal);
    const requiredSession = session ?? this.requireSession(sessionId);
    delete args.editSessionId;
    if (name === 'discard_edit_session') return this.discard(requiredSession);
    if (name === 'review_edit_session') return this.review(requiredSession, args.summary, signal);
    if (isExternalRealTool(name)) {
      return this.runRealTool(requiredSession, name, args, signal);
    }
    return this.runEditorTool(requiredSession, name, args, signal);
  }

  /** Real-project tools (generation/export/import/transcription/analysis) act on
   * the live project. The first call per session asks the user to confirm in
   * the OpenChatCut UI; once confirmed the tool runs like it does internally. */
  private async runRealTool(
    session: ExternalEditSession,
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (session.status !== 'drafting') {
      throw new Error(`Edit session ${session.id} is ${session.status}; real-project tools require drafting status.`);
    }
    throwIfCancelled(signal);
    const confirmed = this.confirmedRealTools.get(session.id);
    // approvalMode auto is the external YOLO: the user chose full automation
    // for this session, so real-project tools (paid ones included) run
    // directly. Manual sessions gate the first call per tool on a card.
    if (session.approvalMode === 'auto' || confirmed?.has(name)) {
      return executeTool(name, args, this.getContext());
    }
    const guardId = `${session.id}:${name}:${crypto.randomUUID().slice(0, 8)}`;
    this.pendingGuardById.set(guardId, { sessionId: session.id, tool: name });
    this.onGuardRequest?.({
      id: guardId,
      sessionId: session.id,
      tool: name,
      summary: typeof args.summary === 'string' && args.summary.trim()
        ? args.summary.trim()
        : name,
    });
    return {
      needs_confirmation: true,
      confirmationId: guardId,
      tool: name,
      note: '这个操作会作用于真实工程。请在 OpenChatCut 中确认后重试同一次调用。',
    };
  }

  /** Resolve a pending real-tool confirmation (UI callback). */
  confirmRealTool(guardId: string, allow: boolean): void {
    const entry = this.pendingGuardById.get(guardId);
    if (!entry) return;
    this.pendingGuardById.delete(guardId);
    if (allow) {
      const set = this.confirmedRealTools.get(entry.sessionId) ?? new Set<string>();
      set.add(entry.tool);
      this.confirmedRealTools.set(entry.sessionId, set);
    }
  }

  /** Current pending guard (UI display) plus a resolver. */
  pendingGuard(): ExternalGuardRequest | null {
    const first = this.pendingGuardById.entries().next().value as [string, { sessionId: string; tool: string }] | undefined;
    if (!first) return null;
    const [id, entry] = first;
    return { id, sessionId: entry.sessionId, tool: entry.tool, summary: entry.tool };
  }

  async apply(
    selected: Set<number>,
    force = false,
    exposeProposal = true,
    signal?: AbortSignal,
  ): Promise<void> {
    const session = this.currentProposalSession();
    const proposal = session?.proposal;
    if (!session || !proposal) return;
    throwIfCancelled(signal);
    const context = this.getContext();
    const currentDoc = context.getDoc();
    if (!force && isProposalStale(proposal, currentDoc)) {
      if (exposeProposal) {
        this.publish({ proposal, stale: true });
        return;
      }
      await this.markTerminal(session, 'stale');
      throw new ExternalEditSessionOutcomeError(
        'stale',
        `Edit session ${session.id} is stale; begin a new session.`,
      );
    }
    const chosen = proposal.options[0].operations.filter((_, index) => selected.has(index));
    const result = replayActions(currentDoc, chosen.flatMap((operation) => operation.actions));
    await this.persistence.saveAutomaticVersion(this.projectId, '外部 Agent 修改前', currentDoc);
    throwIfCancelled(signal);
    const saveResult = await this.persistence.saveProject(this.projectId, result);
    if (!saveResult.saved) {
      throw new ExternalEditSessionOutcomeError(
        'failed',
        'The edited project could not be saved. The proposal remains pending.',
      );
    }
    if (signal?.aborted) {
      const restored = await this.persistence.saveProject(this.projectId, context.getDoc());
      if (!restored.saved) {
        await this.markTerminal(session, 'failed');
        throw new ExternalEditSessionOutcomeError(
          'failed',
          'The cancelled edit could not restore the original saved project. Reload before continuing.',
        );
      }
      await this.markTerminal(session, 'cancelled');
      throwIfCancelled(signal);
    }
    const latestDoc = context.getDoc();
    if (revisionOf(latestDoc) !== revisionOf(currentDoc)) {
      const restored = await this.persistence.saveProject(this.projectId, latestDoc);
      if (exposeProposal) this.publish({ proposal, stale: true });
      if (!restored.saved) {
        await this.markTerminal(session, 'failed');
        throw new ExternalEditSessionOutcomeError(
          'failed',
          'The project changed while applying and its saved copy could not be restored. Reload before continuing.',
        );
      }
      await this.markTerminal(session, 'stale');
      throw new ExternalEditSessionOutcomeError(
        'stale',
        `Edit session ${session.id} became stale while applying.`,
      );
    }
    await this.persistence.saveExternalProposal(
      this.projectId,
      storedSession(session, 'applied', chosen.length),
    );
    const commitDoc = context.getDoc();
    if (signal?.aborted) {
      const restored = await this.persistence.saveProject(this.projectId, commitDoc);
      if (!restored.saved) {
        await this.markTerminal(session, 'failed');
        throw new ExternalEditSessionOutcomeError(
          'failed',
          'The cancelled edit could not restore the original saved project. Reload before continuing.',
        );
      }
      await this.markTerminal(session, 'cancelled');
      throwIfCancelled(signal);
    }
    if (revisionOf(commitDoc) !== revisionOf(currentDoc)) {
      const restored = await this.persistence.saveProject(this.projectId, commitDoc);
      if (exposeProposal) this.publish({ proposal, stale: true });
      if (!restored.saved) {
        await this.markTerminal(session, 'failed');
        throw new ExternalEditSessionOutcomeError(
          'failed',
          'The project changed while applying and its saved copy could not be restored. Reload before continuing.',
        );
      }
      await this.markTerminal(session, 'stale');
      throw new ExternalEditSessionOutcomeError(
        'stale',
        `Edit session ${session.id} became stale while applying.`,
      );
    }
    context.commands.applyDoc(result);
    this.finishInMemory(session, 'applied', chosen.length, revisionOf(result));
    if (!saveResult.indexUpdated) {
      this.sessionWarnings.set(session.id, INDEX_UPDATE_WARNING);
    }
  }

  async reject(): Promise<void> {
    const session = this.currentProposalSession();
    if (session) await this.complete(session, 'rejected');
  }

  private begin(clientName: unknown, approvalMode: unknown): unknown {
    const active = findActiveSession(this.sessions);
    if (active) throw new Error(`Resolve or discard active edit session ${active.id} first.`);
    const context = this.getContext();
    const session = createExternalEditSession(context.getDoc(), clientName, approvalMode);
    this.sessions.set(session.id, session);
    return this.info(session);
  }

  private async review(
    session: ExternalEditSession,
    summary: unknown,
    signal?: AbortSignal,
  ): Promise<unknown> {
    throwIfCancelled(signal);
    const reviewed = reviewExternalEditSession(session, summary);
    await this.persistence.saveExternalProposal(this.projectId, storedSession(reviewed));
    if (signal?.aborted) {
      await this.markTerminal(reviewed, 'cancelled');
      throwIfCancelled(signal);
    }
    this.sessions.set(session.id, reviewed);
    this.proposalSessionId = reviewed.id;
    if (reviewed.approvalMode === 'auto') {
      const count = reviewed.proposal?.options[0].operations.length ?? 0;
      await this.apply(
        new Set(Array.from({ length: count }, (_, index) => index)),
        false,
        false,
        signal,
      );
      return this.info(this.requireSession(reviewed.id));
    }
    const stale = Boolean(reviewed.proposal && isProposalStale(reviewed.proposal, this.getContext().getDoc()));
    this.publish({ proposal: reviewed.proposal, stale });
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    return this.info(reviewed);
  }

  private async discard(session: ExternalEditSession): Promise<unknown> {
    if (!ACTIVE_STATUSES.has(session.status)) return this.info(session);
    await this.markTerminal(session, 'cancelled');
    return this.info(this.requireSession(session.id));
  }

  private async runEditorTool(
    session: ExternalEditSession,
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (!isExternalDraftTool(name)) throw new Error(`Tool ${name} is not available in isolated edit sessions.`);
    if (session.status !== 'drafting') {
      throw new Error(`Edit session ${session.id} is ${session.status}; editor tools require drafting status.`);
    }
    if (isExternalEditSessionStale(session, this.getContext().getDoc())) {
      await this.markTerminal(session, 'stale');
      throw new ExternalEditSessionOutcomeError(
        'stale',
        `Edit session ${session.id} is stale; begin a new session.`,
      );
    }
    throwIfCancelled(signal);
    const candidate = forkExternalEditSession(session);
    const result = await executeTool(name, args, externalDraftContext(candidate, this.getContext()));
    throwIfCancelled(signal);
    if (isExternalEditSessionStale(session, this.getContext().getDoc())) {
      await this.markTerminal(session, 'stale');
      throw new ExternalEditSessionOutcomeError(
        'stale',
        `Edit session ${session.id} became stale while ${name} was running.`,
      );
    }
    this.sessions.set(session.id, captureExternalToolActions(candidate, name, args));
    return result;
  }

  private async validateTerminalReadBinding(
    binding: ExternalBridgeBinding,
    session: ExternalEditSession,
  ): Promise<void> {
    if (
      binding.projectId !== this.projectId
      || binding.editorInstanceId !== this.editorInstanceId
    ) {
      await this.validateBinding(binding);
      return;
    }
    const currentRevision = revisionOf(this.getContext().getDoc());
    if (binding.baseRevision === currentRevision) return;
    if (
      (session.status === 'applied' || session.status === 'rejected')
      && this.terminalRevisions.get(session.id) === currentRevision
    ) return;
    await this.validateBinding(binding);
  }

  private async validateBinding(binding: ExternalBridgeBinding): Promise<void> {
    if (
      binding.projectId !== this.projectId
      || binding.editorInstanceId !== this.editorInstanceId
    ) {
      throw new ExternalEditSessionOutcomeError(
        'stale',
        'The editor call belongs to a different project or editor instance.',
      );
    }
    if (binding.baseRevision === revisionOf(this.getContext().getDoc())) return;
    const active = findActiveSession(this.sessions);
    if (active) await this.markTerminal(active, 'stale');
    throw new ExternalEditSessionOutcomeError(
      'stale',
      `Project ${this.projectId} changed; re-initialize the MCP session.`,
    );
  }
  private requireSession(sessionId: string): ExternalEditSession {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Unknown edit session ${sessionId}`);
    return session;
  }

  private currentProposalSession(): ExternalEditSession | undefined {
    return this.proposalSessionId ? this.sessions.get(this.proposalSessionId) : undefined;
  }

  private async markTerminal(
    session: ExternalEditSession,
    status: ExternalEditSessionTerminalStatus,
    appliedOperationCount?: number,
  ): Promise<void> {
    await this.persistence.saveExternalProposal(
      this.projectId,
      storedSession(session, status, appliedOperationCount),
    );
    this.finishInMemory(session, status, appliedOperationCount);
  }
  private async complete(
    session: ExternalEditSession,
    status: Extract<ExternalEditSessionTerminalStatus, 'applied' | 'rejected'>,
    appliedOperationCount?: number,
  ): Promise<void> {
    await this.markTerminal(session, status, appliedOperationCount);
  }

  private finishInMemory(
    session: ExternalEditSession,
    status: ExternalEditSessionTerminalStatus,
    appliedOperationCount?: number,
    terminalRevision?: string,
  ): void {
    this.sessions.set(session.id, finishExternalEditSession(session, status, appliedOperationCount));
    this.sessionWarnings.delete(session.id);
    if (status === 'applied' || status === 'rejected') {
      this.terminalRevisions.set(session.id, terminalRevision ?? revisionOf(this.getContext().getDoc()));
    } else {
      this.terminalRevisions.delete(session.id);
    }
    if (this.proposalSessionId === session.id) this.proposalSessionId = null;
    this.publish({ proposal: null, stale: status === 'stale' });
  }

  private info(session: ExternalEditSession): Record<string, unknown> {
    const currentDoc = this.getContext().getDoc();
    return {
      editSessionId: session.id,
      status: session.status,
      clientName: session.clientName,
      approvalMode: session.approvalMode,
      baseRevision: session.baseRevision,
      operationCount: session.operationCount,
      appliedOperationCount: session.appliedOperationCount,
      warning: this.sessionWarnings.get(session.id),
      stale: ACTIVE_STATUSES.has(session.status) ? isExternalEditSessionStale(session, currentDoc) : undefined,
      editorUrl: typeof window === 'undefined' ? undefined : window.location.href,
      approvalLocation: session.status === 'awaiting_review' && session.approvalMode === 'manual'
        ? 'OpenChatCut project UI'
        : undefined,
      updatedAt: new Date(session.updatedAt).toISOString(),
    };
  }
}
