import type { AgentContext } from './context';
import type { ProjectDoc } from '../editor/types';
import {
  createExternalEditSession, ExternalEditSessionOutcomeError, finishExternalEditSession,
  revisionOf, reviewExternalEditSession, type ExternalEditSession,
  type ExternalEditSessionTerminalStatus,
} from './external-edit-session';
import { hydrateStoredExternalBridge } from './external-bridge-hydration';
import {
  EXTERNAL_ACTIVE_STATUSES, externalSessionId, externalSessionInfo,
  findActiveExternalSession, storedExternalSession, throwIfExternalCallCancelled,
  validateExternalBridgeBinding,
} from './external-bridge-session';
import { commitExternalProposal, type ExternalBridgePersistence } from './external-proposal-apply';
import { ExternalApprovalGate } from './external-approval-gate';
import { ExternalSessionRunLedger, invocationFromApproval } from './external-run-ledger';
import { validateExternalInvocation } from './external-tool-schemas';
import { executeTool } from './tools';
import { isExternalGlobalReadTool, isExternalRealTool } from './external-tool-policy';
import { isProposalStale, type Proposal } from './proposal';
import { saveProject } from '../persist/projectStore';
import { saveAutomaticVersion } from '../persist/versionStore';
import { saveExternalProposal, type StoredExternalProposal } from '../persist/externalProposalStore';
import { formatToolApprovalDetails, type ApprovalDetail } from './approval-details';
import { redactTextForAgentRuntime } from './runtime-artifact';
import { effectiveToolInvocationArgs } from './execution-policy';
export interface ExternalProposalSnapshot { proposal: Proposal | null; stale: boolean }
/** Confirmation request for a real-project tool (generation/export/import/…)
 * issued from an external session; the user decides in the OpenChatCut UI. */
export interface ExternalGuardRequest { id: string; sessionId: string; tool: string; summary: string; details: readonly ApprovalDetail[]; argsDigest: string; operationId?: string }
export interface ExternalBridgeBinding { projectId: string; editorInstanceId: string; baseRevision: string }
const INDEX_UPDATE_WARNING = 'The edit was applied, but the project list timestamp could not be updated.';
const DEFAULT_PERSISTENCE: ExternalBridgePersistence = { saveProject, saveAutomaticVersion, saveExternalProposal };
export class ExternalBridgeRuntime {
  private sessions = new Map<string, ExternalEditSession>(); private terminalRevisions = new Map<string, string>();
  private sessionWarnings = new Map<string, string>(); private proposalSessionId: string | null = null;
  private readonly projectId: string; private readonly editorInstanceId: string;
  private readonly getContext: () => AgentContext;
  private readonly publish: (snapshot: ExternalProposalSnapshot) => void;
  private readonly persistence: ExternalBridgePersistence;
  private readonly runs = new Map<string, ExternalSessionRunLedger>();
  private readonly approvalGate = new ExternalApprovalGate();
  onGuardRequest: ((request: ExternalGuardRequest) => void) | null = null;
  constructor(
    projectId: string, editorInstanceId: string, getContext: () => AgentContext,
    publish: (snapshot: ExternalProposalSnapshot) => void,
    persistence: ExternalBridgePersistence = DEFAULT_PERSISTENCE,
  ) {
    this.projectId = projectId; this.editorInstanceId = editorInstanceId;
    this.getContext = getContext; this.publish = publish; this.persistence = persistence;
  }

  binding(): ExternalBridgeBinding {
    return {
      projectId: this.projectId, editorInstanceId: this.editorInstanceId,
      baseRevision: revisionOf(this.getContext().getDoc()),
    };
  }
  async hydrate(pending: StoredExternalProposal | null): Promise<void> {
    this.reset();
    await hydrateStoredExternalBridge({
      pending,
      projectId: this.projectId,
      currentDoc: this.getContext().getDoc(),
      executeTool,
      save: this.persistence.saveExternalProposal,
      install: ({ session, run }) => {
        this.sessions.set(session.id, session);
        if (run) this.runs.set(session.id, run);
        if (session.status === 'awaiting_review') this.proposalSessionId = session.id;
      },
      publish: this.publish,
      applyAutomatic: async (count) => this.apply(
        new Set(Array.from({ length: count }, (_, index) => index)), false, false,
      ),
    });
  }

  dispose(): void { void this.disconnect().catch(() => undefined); }

  async disconnect(): Promise<void> {
    const runs = [...this.runs.values()];
    this.runs.clear(); this.approvalGate.clear();
    await Promise.all(runs.map((run) => run.disconnect()));
  }

  private reset(): void {
    this.dispose(); this.sessions = new Map();
    this.terminalRevisions = new Map(); this.sessionWarnings = new Map();
    this.proposalSessionId = null;
  }

  async execute(
    name: string,
    rawArgs: Record<string, unknown>,
    binding: ExternalBridgeBinding,
    signal?: AbortSignal,
  ): Promise<unknown> {
    throwIfExternalCallCancelled(signal);
    const invocationArgs = effectiveToolInvocationArgs(
      name,
      validateExternalInvocation(name, rawArgs),
    );
    if (name === 'begin_edit_session') {
      await this.validateBinding(binding);
      throwIfExternalCallCancelled(signal);
      return this.begin(invocationArgs.clientName, invocationArgs.approvalMode);
    }
    if (isExternalGlobalReadTool(name)) {
      await this.validateBinding(binding);
      throwIfExternalCallCancelled(signal);
      return this.runGlobalReadTool(name, invocationArgs, signal);
    }
    const sessionId = externalSessionId(rawArgs);
    const session = this.sessions.get(sessionId);
    if (name === 'discard_edit_session') {
      if (!session) {
        await this.validateBinding(binding);
        throw new ExternalEditSessionOutcomeError('rejected', `Unknown edit session ${sessionId}`);
      }
      throwIfExternalCallCancelled(signal);
      return this.discard(session);
    }
    if (name === 'get_edit_session') {
      if (!session) {
        await this.validateBinding(binding);
        throw new ExternalEditSessionOutcomeError('rejected', `Unknown edit session ${sessionId}`);
      }
      await this.validateTerminalReadBinding(binding, session);
      throwIfExternalCallCancelled(signal);
      return this.info(session);
    }
    await this.validateBinding(binding);
    throwIfExternalCallCancelled(signal);
    const requiredSession = session ?? this.requireSession(sessionId);
    if (name === 'review_edit_session') {
      return this.review(requiredSession, invocationArgs.summary, signal);
    }
    if (isExternalRealTool(name, invocationArgs)) {
      return this.runRealTool(requiredSession, name, invocationArgs, signal);
    }
    return this.runEditorTool(requiredSession, name, invocationArgs, signal);
  }

  private async runGlobalReadTool(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const run = await ExternalSessionRunLedger.start(this.projectId, 'external-connected', `global_${crypto.randomUUID()}`, 'external-connected', executeTool);
    try {
      const invocation = await run.requested(name, args);
      const result = await run.executeApprovedTool(invocation, args, this.getContext(), signal);
      await run.finalize('completed', `External global read ${name} completed.`);
      return result;
    } catch (error) {
      await run.finalize('failed', `External global read ${name} failed.`).catch(() => undefined);
      throw error;
    } finally {
      run.dispose();
    }
  }

  private async runRealTool(
    session: ExternalEditSession,
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (session.status !== 'drafting') {
      throw new ExternalEditSessionOutcomeError(
        'rejected',
        `Edit session ${session.id} is ${session.status}; real-project tools require drafting status.`,
      );
    }
    const run = this.requireRun(session.id);
    const operationId = typeof args.operationId === 'string' ? args.operationId : undefined;
    const approved = await this.approvalGate.consume({
      sessionId: session.id, runId: run.runId, tool: name, args, operationId,
    });
    if (!approved) {
      // auto (YOLO) sessions skip the confirmation card entirely — the
      // client explicitly opted into unapproved real-project execution.
      if (session.approvalMode === 'auto') {
        const invocation = await run.requested(name, args, true);
        return run.executeApprovedTool(invocation, args, this.getContext(), signal);
      }
      return this.requestRealToolApproval(session, run, name, args);
    }
    return run.executeApprovedTool(
      invocationFromApproval(approved),
      args,
      this.getContext(),
      signal,
    );
  }

  private async requestRealToolApproval(
    session: ExternalEditSession,
    run: ExternalSessionRunLedger,
    tool: string,
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const invocation = await run.requested(tool, args, true);
    const presentation = formatToolApprovalDetails(tool, args);
    const guard = await this.approvalGate.request({
      sessionId: session.id,
      runId: run.runId,
      toolCallId: invocation.toolCallId,
      tool,
      argsDigest: invocation.argsDigest,
      operationId: invocation.operationId,
      summary: presentation.summary,
      details: presentation.details,
    }, (entry) => run.approvalRequested(entry));
    this.onGuardRequest?.({
      id: guard.guardId, sessionId: session.id, tool,
      summary: guard.summary, details: guard.details,
      argsDigest: guard.argsDigest,
      operationId: guard.operationId ? redactTextForAgentRuntime(guard.operationId) : undefined,
    });
    return {
      needs_confirmation: true,
      confirmationId: guard.guardId,
      tool,
      note: '这个操作会作用于真实工程。请在 OpenChatCut 中确认后重试同一次调用。',
    };
  }
  async confirmRealTool(guardId: string, allow: boolean): Promise<void> {
    await this.approvalGate.resolve(guardId, allow, async (binding, decision) => {
      const run = this.runs.get(binding.sessionId);
      if (!run || run.runId !== binding.runId) {
        throw new Error(`Agent run ${binding.runId} is not active.`);
      }
      await run.approvalDecision(binding, decision);
    });
  }
  pendingGuard(): ExternalGuardRequest | null {
    const pending = this.approvalGate.pending();
    return pending ? {
      id: pending.guardId, sessionId: pending.sessionId, tool: pending.tool,
      summary: pending.summary, details: pending.details,
      argsDigest: pending.argsDigest,
      operationId: pending.operationId ? redactTextForAgentRuntime(pending.operationId) : undefined,
    } : null;
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
    const run = this.requireRun(session.id);
    await run.confirmOwnership();
    throwIfExternalCallCancelled(signal);
    const context = this.getContext();
    const committed = await commitExternalProposal({
      projectId: this.projectId,
      session,
      proposal,
      selected,
      force,
      exposeProposal,
      signal,
      context,
      persistence: this.persistence,
      publishStale: () => this.publish({ proposal, stale: true }),
      markTerminal: (status) => this.markTerminal(session, status),
    });
    if (committed.status === 'stale-exposed') return;
    await this.finishCommittedApply(
      session, committed.result, committed.appliedOperationCount, committed.indexUpdated,
    );
  }
  private async finishCommittedApply(
    session: ExternalEditSession, result: ProjectDoc, appliedOperationCount: number,
    indexUpdated: boolean,
  ): Promise<void> {
    let warning: string | undefined;
    this.finishInMemory(session, 'applied', appliedOperationCount, revisionOf(result));
    try {
      await this.recordRunTerminal(session, 'applied');
    } catch {
      warning = warning ? `${warning} The applied run ledger could not be finalized.`
        : 'The edit was applied, but the run ledger could not be finalized.';
    }
    if (!indexUpdated) warning = warning ? `${warning} ${INDEX_UPDATE_WARNING}` : INDEX_UPDATE_WARNING;
    if (warning) this.sessionWarnings.set(session.id, warning);
  }

  /** Discard the edit sessions orphaned by a disconnected MCP transport. */
  async discardOwnerSessions(sessionIds: readonly string[]): Promise<void> {
    for (const sessionId of sessionIds) {
      const session = this.sessions.get(sessionId);
      if (!session || !EXTERNAL_ACTIVE_STATUSES.has(session.status)) continue;
      try {
        await this.discard(session);
      } catch {
        // Best-effort: the store record is terminal; an orphan must never wedge begin_edit_session.
      }
    }
  }

  async reject(): Promise<void> {
    const session = this.currentProposalSession();
    if (!session) return;
    await this.requireRun(session.id).confirmOwnership();
    await this.complete(session, 'rejected');
  }

  private async begin(clientName: unknown, approvalMode: unknown): Promise<unknown> {
    const active = findActiveExternalSession(this.sessions);
    if (active) {
      throw new ExternalEditSessionOutcomeError(
        'rejected',
        'An edit session is already active. Resolve it before starting another.',
      );
    }
    const session = createExternalEditSession(this.getContext().getDoc(), clientName, approvalMode);
    const run = await ExternalSessionRunLedger.start(this.projectId, session.clientName, session.id, 'external-connected', executeTool);
    this.runs.set(session.id, run);
    this.sessions.set(session.id, session);
    await this.persistence.saveExternalProposal(this.projectId,
      storedExternalSession(session, 'drafting', undefined, run.runId));
    return this.info(session);
  }

  private async review(
    session: ExternalEditSession,
    summary: unknown,
    signal?: AbortSignal,
  ): Promise<unknown> {
    throwIfExternalCallCancelled(signal);
    const run = this.requireRun(session.id);
    const reviewResult = reviewExternalEditSession(session, summary);
    const reviewed = reviewResult.proposal
      ? {
        ...reviewResult,
        proposal: { ...reviewResult.proposal, agentRunId: run.runId },
      }
      : reviewResult;
    const proposalId = reviewed.proposal?.id;
    if (proposalId) await run.proposal(proposalId, 'created');
    await this.persistence.saveExternalProposal(this.projectId, storedExternalSession(reviewed));
    if (signal?.aborted) {
      await this.markTerminal(reviewed, 'cancelled');
      throwIfExternalCallCancelled(signal);
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
    if (!EXTERNAL_ACTIVE_STATUSES.has(session.status)) return this.info(session);
    await this.markTerminal(session, 'cancelled');
    return this.info(this.requireSession(session.id));
  }

  private async runEditorTool(
    session: ExternalEditSession,
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const run = this.requireRun(session.id);
    const executed = await run.executeDraftTool({
      session,
      name,
      args,
      context: this.getContext(),
      signal,
      markStale: () => this.markTerminal(session, 'stale'),
    });
    await this.persistence.saveExternalProposal(this.projectId,
      storedExternalSession(executed.session, 'drafting', undefined, run.runId));
    this.sessions.set(session.id, executed.session);
    return executed.result;
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

  private validateBinding(binding: ExternalBridgeBinding): Promise<void> {
    return validateExternalBridgeBinding({
      binding,
      projectId: this.projectId,
      editorInstanceId: this.editorInstanceId,
      sessions: this.sessions,
      currentDoc: this.getContext().getDoc(),
      markStale: (session) => this.markTerminal(session, 'stale'),
    });
  }
  private requireSession(sessionId: string): ExternalEditSession {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new ExternalEditSessionOutcomeError('rejected', `Unknown edit session ${sessionId}`);
    }
    return session;
  }

  private requireRun(sessionId: string): ExternalSessionRunLedger {
    const run = this.runs.get(sessionId);
    if (!run) throw new Error(`Agent run for edit session ${sessionId} is unavailable.`);
    return run;
  }

  private currentProposalSession(): ExternalEditSession | undefined {
    return this.proposalSessionId ? this.sessions.get(this.proposalSessionId) : undefined;
  }

  private async markTerminal(
    session: ExternalEditSession,
    status: ExternalEditSessionTerminalStatus,
    appliedOperationCount?: number,
  ): Promise<void> {
    const stored = storedExternalSession(
      session, status, appliedOperationCount, this.runs.get(session.id)?.runId,
    );
    await this.persistence.saveExternalProposal(this.projectId, stored);
    await this.recordRunTerminal(session, status);
    this.finishInMemory(session, status, appliedOperationCount);
  }

  private async recordRunTerminal(
    session: ExternalEditSession,
    status: ExternalEditSessionTerminalStatus,
  ): Promise<void> {
    for (const approval of this.approvalGate.pendingForSession(session.id)) {
      await this.confirmRealTool(approval.guardId, false);
    }
    this.approvalGate.clearSessionAllowances(session.id);
    const run = this.runs.get(session.id);
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
    return externalSessionInfo({
      session,
      currentDoc: this.getContext().getDoc(),
      warning: this.sessionWarnings.get(session.id),
      runId: this.runs.get(session.id)?.runId,
    });
  }
}
