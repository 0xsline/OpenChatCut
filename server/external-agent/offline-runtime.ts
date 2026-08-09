import { randomUUID } from 'node:crypto';
import {
  captureExternalToolActions,
  checkpointExternalEditSession,
  createExternalEditSession,
  externalDraftContext,
  finishExternalEditSession,
  forkExternalEditSession,
  restoreDraftingExternalEditSession,
  reviewExternalEditSession,
  type ExternalEditSession,
  type ExternalEditSessionTerminalStatus,
} from '../../src/agent/external-edit-session.ts';
import { assertOfflineToolAllowed } from './offline-tool-authorization.ts';
import type { AgentContext } from '../../src/agent/context.ts';
import { ExternalEditorCallError, isProjectConnected } from './broker.ts';
import { executeOfflineTool } from './offline-executor.ts';
import { captureCheckpointedToolOutcome } from './offline-outcome.ts';
import {
  externalToolFailureOutcome,
  externalToolResultFailure,
  type ExternalSessionRunLedger,
} from '../../src/agent/external-run-ledger.ts';
import { redactTextForAgentRuntime } from '../../src/agent/runtime-artifact.ts';
import type {
  OfflineProjectCommitResult,
  OfflineStoredProject,
} from './offline-project-store.ts';
import type { ProjectEditOwnershipClaim } from './project-edit-ownership.ts';
import { openOfflineSessionRun } from './offline-run-recovery.ts';
import {
  failedOfflineCommit,
  isAppliedOfflineCommit,
  publishAppliedOfflineReview,
  publishOfflineReviewFailure,
  rejectedOfflineCommit,
  type AppliedOfflineCommit,
  type OfflineReviewFailure,
} from './offline-review-outcome.ts';
import {
  ACTIVE_SESSION_STATUSES,
  DEFAULT_PERSISTENCE,
  requiredSessionId,
  validateOfflineInvocation,
  type OfflineEditPersistence,
  type OfflineEditorBinding,
  type OfflineRuntimeDependencies,
  type VersionedOfflineSession,
} from './offline-runtime-support.ts';

export type {
  OfflineEditPersistence,
  OfflineEditorBinding,
  OfflineRuntimeDependencies,
};

export class OfflineExternalEditRuntime {
  private readonly sessions = new Map<string, VersionedOfflineSession>();
  private readonly runs = new Map<string, ExternalSessionRunLedger>();
  private readonly projectId: string;
  private readonly editorUrl: string;
  private readonly persistence: OfflineEditPersistence;
  private readonly browserConnected: (projectId: string) => boolean;
  private readonly executeTool: typeof executeOfflineTool;
  private operationTail: Promise<void> = Promise.resolve();
  private expectedRevision: string;
  private baseDoc: OfflineStoredProject['doc'];
  private ownership: ProjectEditOwnershipClaim;
  private disposed = false;
  private disposal: Promise<void> | null = null;

  private constructor(
    snapshot: OfflineStoredProject,
    ownership: ProjectEditOwnershipClaim,
    editorUrl: string,
    dependencies: OfflineRuntimeDependencies,
  ) {
    this.projectId = snapshot.projectId;
    this.expectedRevision = snapshot.revision;
    this.baseDoc = snapshot.doc;
    this.ownership = ownership;
    this.editorUrl = editorUrl;
    this.persistence = dependencies.persistence ?? DEFAULT_PERSISTENCE;
    this.browserConnected = dependencies.isBrowserConnected ?? isProjectConnected;
    this.executeTool = dependencies.executeTool ?? executeOfflineTool;
  }

  static async create(
    projectId: string,
    editorUrl: string,
    dependencies: OfflineRuntimeDependencies = {},
  ): Promise<OfflineExternalEditRuntime> {
    const browserConnected = dependencies.isBrowserConnected ?? isProjectConnected;
    if (browserConnected(projectId)) {
      throw new ExternalEditorCallError('rejected', `Project ${projectId} is open in an editor; use the browser binding.`);
    }
    const persistence = dependencies.persistence ?? DEFAULT_PERSISTENCE;
    const claimed = await persistence.claimProject(projectId, randomUUID());
    if (claimed.status !== 'claimed') {
      const message = claimed.status === 'missing'
        ? `Stored project ${projectId} does not exist or is invalid.`
        : claimed.status === 'busy'
          ? `Project ${projectId} already has an active browser or offline editor.`
          : `Project ${projectId} has an unsupported or corrupt ownership record.`;
      throw new ExternalEditorCallError('rejected', message);
    }
    const snapshot = { projectId, doc: claimed.doc, revision: claimed.revision };
    return new OfflineExternalEditRuntime(snapshot, claimed.claim, editorUrl, dependencies);
  }
  binding(): OfflineEditorBinding {
    return { mode: 'offline', projectId: this.projectId, baseRevision: this.expectedRevision };
  }
  async validateAvailability(): Promise<void> {
    return this.runExclusive(() => this.validateAvailabilityLocked());
  }

  async execute(name: string, rawArgs: Record<string, unknown>): Promise<unknown> {
    validateOfflineInvocation(name, rawArgs);
    const terminal = name === 'get_edit_session' ? this.sessions.get(requiredSessionId(rawArgs)) : undefined;
    if (terminal && !ACTIVE_SESSION_STATUSES[terminal.session.status]) return this.info(terminal.session);
    const releaseAfter = name === 'review_edit_session' || name === 'discard_edit_session';
    return this.runExclusive(async () => {
      try {
        await this.validateAvailabilityLocked();
        const args = { ...rawArgs };
        if (name === 'begin_edit_session') return await this.begin(args.clientName, args.approvalMode);
        const state = this.requireSession(requiredSessionId(args));
        if (name === 'get_edit_session') return this.info(state.session);
        if (name === 'discard_edit_session') return await this.discard(state);
        if (name === 'review_edit_session') return await this.review(state, args.summary);
        delete args.editSessionId;
        return await this.runEditorTool(state, name, args);
      } catch (error) {
        if (error instanceof ExternalEditorCallError) throw error;
        const message = error instanceof Error ? error.message : String(error);
        throw new ExternalEditorCallError('failed', message);
      } finally {
        if (releaseAfter) {
          await this.persistence.releaseOwnership(this.ownership).catch((error: unknown) =>
            process.emitWarning(`Failed to release terminal offline project ownership: ${
              error instanceof Error ? error.message : String(error)}`));
        }
      }
    });
  }

  dispose(): Promise<void> {
    if (this.disposal) return this.disposal;
    this.disposed = true;
    for (const run of this.runs.values()) run.dispose();
    this.failActiveSessions('cancelled');
    this.disposal = this.persistence.releaseOwnership(this.ownership).catch((error: unknown) => {
      process.emitWarning(
        `Failed to release offline project ownership: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
    return this.disposal;
  }

  private async validateAvailabilityLocked(): Promise<void> {
    if (this.disposed) {
      this.failActiveSessions('cancelled');
      throw new ExternalEditorCallError('cancelled', 'The MCP transport session is closed or expired.');
    }
    if (this.browserConnected(this.projectId)) {
      this.failActiveSessions('stale');
      throw new ExternalEditorCallError(
        'stale',
        `Project ${this.projectId} is now open in a browser editor. Start a new MCP session and use ${this.editorUrl}.`,
      );
    }
    const renewed = await this.persistence.renewOwnership(this.ownership, this.expectedRevision);
    if (renewed.status !== 'renewed') {
      this.failActiveSessions('stale');
      throw new ExternalEditorCallError(
        'stale',
        `Stored project ${this.projectId} changed ownership or revision during the offline edit. Start a new MCP session.`,
      );
    }
    this.ownership = renewed.claim;
    this.baseDoc = renewed.doc;
  }

  private async begin(
    clientName: unknown,
    approvalMode: unknown,
  ): Promise<Record<string, unknown>> {
    const active = [...this.sessions.values()]
      .find(({ session }) => ACTIVE_SESSION_STATUSES[session.status] === true);
    if (active) throw new Error(`Resolve or discard active edit session ${active.session.id} first.`);
    if (approvalMode !== 'auto') {
      throw new ExternalEditorCallError(
        'rejected',
        `Offline editing requires approvalMode="auto". Open ${this.editorUrl} for manual approval.`,
      );
    }
    const checkpoint = await this.persistence.loadCheckpoint?.(
      this.projectId,
      this.expectedRevision,
    );
    const session = checkpoint
      ? restoreDraftingExternalEditSession(checkpoint, this.baseDoc)
      : createExternalEditSession(this.baseDoc, clientName, approvalMode);
    const run = await openOfflineSessionRun(
      this.projectId,
      session,
      checkpoint !== null && checkpoint !== undefined,
    );
    this.runs.set(session.id, run);
    this.sessions.set(session.id, { session, generation: 0 });
    return { ...this.info(session), resumed: checkpoint !== null && checkpoint !== undefined };
  }

  private async discard(state: VersionedOfflineSession): Promise<Record<string, unknown>> {
    if (ACTIVE_SESSION_STATUSES[state.session.status] === true) {
      await this.persistence.deleteCheckpoint?.(this.projectId, state.session.id, this.ownership);
      this.publishSession(state, finishExternalEditSession(state.session, 'cancelled'));
      await this.runs.get(state.session.id)?.finalize(
        'aborted',
        'Offline external edit session cancelled.',
      );
    }
    return this.info(this.requireSession(state.session.id).session);
  }

  private async runEditorTool(
    state: VersionedOfflineSession,
    name: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    assertOfflineToolAllowed(name, args, this.editorUrl);
    const session = state.session;
    if (session.status !== 'drafting') {
      throw new ExternalEditorCallError(
        'rejected',
        `Edit session ${session.id} is ${session.status}; editor tools require drafting status.`,
      );
    }
    const run = this.requireRun(session.id);
    const invocation = await run.requested(name, args);
    const candidate = forkExternalEditSession(session);
    let result: unknown;
    let started = false;
    try {
      await run.started(invocation);
      started = true;
      result = await this.executeTool(name, args, externalDraftContext(candidate, this.context(candidate)));
      await this.validateAvailabilityLocked();
    } catch (error) {
      await run.captureToolOutcome(
        invocation,
        externalToolFailureOutcome(invocation, error, started),
      );
      if (error instanceof ExternalEditorCallError) throw error;
      const message = redactTextForAgentRuntime(
        error instanceof Error ? error.message : String(error),
      ).slice(0, 1_200);
      throw new ExternalEditorCallError('failed', message);
    }
    const failure = externalToolResultFailure(invocation, result);
    if (failure) {
      const projected = await run.captureToolOutcome(invocation, failure, result);
      throw new ExternalEditorCallError('failed', this.projectedFailureMessage(projected));
    }
    const captured = captureExternalToolActions(candidate, name, args);
    await this.persistCheckpoint(state, captured);
    this.publishSession(state, captured);
    return captureCheckpointedToolOutcome(run, invocation, result);
  }

  private async review(
    state: VersionedOfflineSession,
    summary: unknown,
  ): Promise<Record<string, unknown>> {
    const session = state.session;
    if (session.approvalMode !== 'auto') {
      throw new ExternalEditorCallError('rejected', `Open ${this.editorUrl} to review a manual edit session.`);
    }
    const draftDoc = session.draft?.getDoc();
    if (!draftDoc) throw new Error(`Edit session ${session.id} is ${session.status}, not drafting.`);
    const run = this.requireRun(session.id);
    const reviewedState = this.publishSession(state, reviewExternalEditSession(session, summary));
    const proposalId = reviewedState.session.proposal?.id;
    if (proposalId) await run.proposal(proposalId, 'created');
    let result: OfflineProjectCommitResult;
    try {
      result = await this.commitReviewedDraft(reviewedState, draftDoc);
    } catch {
      return this.failReview(reviewedState, run, proposalId, failedOfflineCommit(this.disposed));
    }
    if (!isAppliedOfflineCommit(result)) {
      return this.failReview(reviewedState, run, proposalId, rejectedOfflineCommit({
        result,
        disposed: this.disposed,
        projectId: this.projectId,
        editorUrl: this.editorUrl,
      }));
    }
    return this.publishReviewedCommit(reviewedState, draftDoc, run, proposalId, result);
  }

  private async failReview(
    state: VersionedOfflineSession,
    run: ExternalSessionRunLedger,
    proposalId: string | undefined,
    failure: OfflineReviewFailure,
  ): Promise<never> {
    this.finishIfCurrent(state, failure.outcome);
    await publishOfflineReviewFailure(run, proposalId, failure);
    throw new ExternalEditorCallError(failure.outcome, failure.message);
  }

  private async publishReviewedCommit(
    state: VersionedOfflineSession,
    draftDoc: OfflineStoredProject['doc'],
    run: ExternalSessionRunLedger,
    proposalId: string | undefined,
    result: AppliedOfflineCommit,
  ): Promise<Record<string, unknown>> {
    this.expectedRevision = result.revision;
    this.ownership = result.ownership;
    this.baseDoc = draftDoc;
    let warning: string | undefined;
    try {
      await this.persistence.deleteCheckpoint?.(this.projectId, state.session.id, this.ownership);
    } catch {
      warning = 'The applied draft checkpoint could not be removed; its stale revision prevents reuse.';
    }
    const applied = finishExternalEditSession(
      state.session,
      'applied',
      state.session.operationCount,
    );
    const info = this.info(this.publishAppliedSession(state, applied).session);
    warning = await publishAppliedOfflineReview(run, proposalId, warning);
    return warning ? { ...info, warning } : info;
  }

  private async commitReviewedDraft(
    state: VersionedOfflineSession,
    doc: OfflineStoredProject['doc'],
  ): Promise<OfflineProjectCommitResult> {
    return this.persistence.commitProject({
      projectId: this.projectId,
      expectedRevision: this.expectedRevision,
      doc,
      ownership: this.ownership,
      canCommit: () => (
        !this.disposed
        && !this.browserConnected(this.projectId)
        && this.isCurrent(state, 'awaiting_review')
      ),
    });
  }
  private async persistCheckpoint(
    state: VersionedOfflineSession,
    session: ExternalEditSession,
  ): Promise<void> {
    if (!this.persistence.saveCheckpoint) return;
    const result = await this.persistence.saveCheckpoint({
      projectId: this.projectId,
      expectedRevision: this.expectedRevision,
      checkpoint: checkpointExternalEditSession(session),
      ownership: this.ownership,
      canSave: () => (
        !this.disposed
        && !this.browserConnected(this.projectId)
        && this.isCurrent(state, 'drafting')
      ),
    });
    if (result === 'saved') return;
    const outcome = this.disposed ? 'cancelled' : 'stale';
    this.finishIfCurrent(state, outcome);
    const reason = result === 'browser-takeover'
      ? `Project ${this.projectId} opened in a browser before the draft checkpoint was saved.`
      : `Stored project ${this.projectId} changed before the draft checkpoint was saved.`;
    throw new ExternalEditorCallError(outcome, `${reason} Start a new MCP session.`);
  }

  private runExclusive<T>(operation: () => Promise<T> | T): Promise<T> {
    const result = this.operationTail.then(operation, operation);
    this.operationTail = result.then(() => undefined, () => undefined);
    return result;
  }

  private isCurrent(
    expected: VersionedOfflineSession,
    status?: ExternalEditSession['status'],
  ): boolean {
    const current = this.sessions.get(expected.session.id);
    return current?.session === expected.session
      && current.generation === expected.generation
      && (status === undefined || current.session.status === status);
  }

  private publishSession(
    expected: VersionedOfflineSession,
    session: ExternalEditSession,
  ): VersionedOfflineSession {
    if (!this.isCurrent(expected)) {
      const outcome = this.disposed ? 'cancelled' : 'stale';
      throw new ExternalEditorCallError(
        outcome,
        `Edit session ${expected.session.id} changed while an offline operation was running.`,
      );
    }
    const next = { session, generation: expected.generation + 1 };
    this.sessions.set(session.id, next);
    return next;
  }

  private publishAppliedSession(
    expected: VersionedOfflineSession,
    session: ExternalEditSession,
  ): VersionedOfflineSession {
    if (this.isCurrent(expected)) return this.publishSession(expected, session);
    const current = this.sessions.get(expected.session.id);
    if (!this.disposed || !current) {
      throw new ExternalEditorCallError('stale',
        `Edit session ${expected.session.id} changed while an offline operation was running.`);
    }
    const next = { session, generation: current.generation + 1 };
    this.sessions.set(session.id, next);
    return next;
  }

  private finishIfCurrent(
    expected: VersionedOfflineSession,
    status: ExternalEditSessionTerminalStatus,
  ): void {
    if (this.isCurrent(expected)) {
      this.publishSession(expected, finishExternalEditSession(expected.session, status));
    }
  }

  private context(session: ExternalEditSession): AgentContext {
    if (!session.draft) throw new Error(`Edit session ${session.id} is no longer writable.`);
    return {
      commands: session.draft.commands,
      getState: session.draft.getState,
      getDoc: session.draft.getDoc,
      getCreativeMode: () => null,
      templates: [],
      audio: [],
      getProjectId: () => this.projectId,
      getApprovalMode: () => 'auto',
    };
  }

  private requireSession(sessionId: string): VersionedOfflineSession {
    const state = this.sessions.get(sessionId);
    if (!state) {
      throw new ExternalEditorCallError('rejected', `Unknown edit session ${sessionId}`);
    }
    return state;
  }

  private requireRun(sessionId: string): ExternalSessionRunLedger {
    const run = this.runs.get(sessionId);
    if (!run) throw new Error(`Agent run for offline edit session ${sessionId} is unavailable.`);
    return run;
  }

  private projectedFailureMessage(projected: unknown): string {
    if (projected && typeof projected === 'object' && !Array.isArray(projected)) {
      if ('error' in projected && typeof projected.error === 'string') {
        return projected.error.slice(0, 1_200);
      }
      if ('artifactId' in projected && typeof projected.artifactId === 'string') {
        return `The tool returned an archived error result. Read artifact ${projected.artifactId} for details.`;
      }
    }
    return 'The tool returned an error result.';
  }

  private failActiveSessions(status: Extract<ExternalEditSessionTerminalStatus, 'cancelled' | 'stale'>): void {
    for (const state of this.sessions.values()) {
      if (ACTIVE_SESSION_STATUSES[state.session.status] === true) {
        this.publishSession(state, finishExternalEditSession(state.session, status));
      }
    }
  }

  private info(session: ExternalEditSession): Record<string, unknown> {
    return {
      editSessionId: session.id,
      status: session.status,
      clientName: session.clientName,
      approvalMode: session.approvalMode,
      baseRevision: session.baseRevision,
      operationCount: session.operationCount,
      appliedOperationCount: session.appliedOperationCount,
      bindingMode: 'offline',
      agentRunId: this.runs.get(session.id)?.runId,
      editorUrl: this.editorUrl,
      updatedAt: new Date(session.updatedAt).toISOString(),
    };
  }
}
