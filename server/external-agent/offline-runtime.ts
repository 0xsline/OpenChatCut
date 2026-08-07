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
import { isExternalServerDirectCall, isExternalServerDirectTool } from '../../src/agent/external-tool-policy.ts';
import type { AgentContext } from '../../src/agent/context.ts';
import { ExternalEditorCallError, isProjectConnected } from './broker.ts';
import { executeOfflineTool } from './offline-executor.ts';
import {
  commitOfflineStoredProject,
  deleteOfflineEditCheckpoint,
  loadOfflineEditCheckpoint,
  loadOfflineStoredProject,
  saveOfflineEditCheckpoint,
  type OfflineProjectCommitInput,
  type OfflineProjectCommitResult,
  type OfflineStoredProject,
} from './offline-project-store.ts';

const ACTIVE_SESSION_STATUSES: Record<string, true> = {
  drafting: true,
  awaiting_review: true,
};

export interface OfflineEditorBinding {
  mode: 'offline';
  projectId: string;
  baseRevision: string;
}

export interface OfflineEditPersistence {
  loadProject: (projectId: string) => Promise<OfflineStoredProject | null>;
  commitProject: (input: OfflineProjectCommitInput) => Promise<OfflineProjectCommitResult>;
  loadCheckpoint?: typeof loadOfflineEditCheckpoint;
  saveCheckpoint?: typeof saveOfflineEditCheckpoint;
  deleteCheckpoint?: typeof deleteOfflineEditCheckpoint;
}

export interface OfflineRuntimeDependencies {
  persistence?: OfflineEditPersistence;
  isBrowserConnected?: (projectId: string) => boolean;
  executeTool?: typeof executeOfflineTool;
}

interface VersionedOfflineSession {
  readonly session: ExternalEditSession;
  readonly generation: number;
}

const DEFAULT_PERSISTENCE: OfflineEditPersistence = {
  loadProject: loadOfflineStoredProject,
  commitProject: commitOfflineStoredProject,
  loadCheckpoint: loadOfflineEditCheckpoint,
  saveCheckpoint: saveOfflineEditCheckpoint,
  deleteCheckpoint: deleteOfflineEditCheckpoint,
};

function requiredSessionId(args: Record<string, unknown>): string {
  const value = args.editSessionId;
  if (typeof value !== 'string' || !value.trim()) throw new Error('editSessionId is required');
  return value.trim();
}

function toolReturnedError(result: unknown): boolean {
  return result !== null
    && typeof result === 'object'
    && !Array.isArray(result)
    && 'error' in result
    && typeof result.error === 'string';
}

export class OfflineExternalEditRuntime {
  private readonly sessions = new Map<string, VersionedOfflineSession>();
  private readonly projectId: string;
  private readonly editorUrl: string;
  private readonly persistence: OfflineEditPersistence;
  private readonly browserConnected: (projectId: string) => boolean;
  private readonly executeTool: typeof executeOfflineTool;
  private operationTail: Promise<void> = Promise.resolve();
  private expectedRevision: string;
  private baseDoc: OfflineStoredProject['doc'];
  private disposed = false;

  private constructor(
    snapshot: OfflineStoredProject,
    editorUrl: string,
    dependencies: OfflineRuntimeDependencies,
  ) {
    this.projectId = snapshot.projectId;
    this.expectedRevision = snapshot.revision;
    this.baseDoc = snapshot.doc;
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
    const snapshot = await persistence.loadProject(projectId);
    if (!snapshot) {
      throw new ExternalEditorCallError('rejected', `Stored project ${projectId} does not exist or is invalid.`);
    }
    if (browserConnected(projectId)) {
      throw new ExternalEditorCallError('stale', `Project ${projectId} opened in an editor while the offline binding was starting.`);
    }
    return new OfflineExternalEditRuntime(snapshot, editorUrl, dependencies);
  }

  binding(): OfflineEditorBinding {
    return { mode: 'offline', projectId: this.projectId, baseRevision: this.expectedRevision };
  }

  async validateAvailability(): Promise<void> {
    return this.runExclusive(() => this.validateAvailabilityLocked());
  }

  async execute(name: string, rawArgs: Record<string, unknown>): Promise<unknown> {
    return this.runExclusive(async () => {
      await this.validateAvailabilityLocked();
      const args = { ...rawArgs };
      if (name === 'begin_edit_session') return this.begin(args.clientName, args.approvalMode);
      const state = this.requireSession(requiredSessionId(args));
      if (name === 'get_edit_session') return this.info(state.session);
      if (name === 'discard_edit_session') return this.discard(state);
      if (name === 'review_edit_session') return this.review(state, args.summary);
      delete args.editSessionId;
      return this.runEditorTool(state, name, args);
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    void this.runExclusive(() => {
      this.failActiveSessions('cancelled');
    });
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
    const stored = await this.persistence.loadProject(this.projectId);
    if (!stored || stored.revision !== this.expectedRevision) {
      this.failActiveSessions('stale');
      throw new ExternalEditorCallError(
        'stale',
        `Stored project ${this.projectId} changed during the offline edit. Start a new MCP session.`,
      );
    }
    this.baseDoc = stored.doc;
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
    this.sessions.set(session.id, { session, generation: 0 });
    return { ...this.info(session), resumed: checkpoint !== null && checkpoint !== undefined };
  }

  private async discard(state: VersionedOfflineSession): Promise<Record<string, unknown>> {
    if (ACTIVE_SESSION_STATUSES[state.session.status] === true) {
      await this.persistence.deleteCheckpoint?.(this.projectId, state.session.id);
      this.publishSession(state, finishExternalEditSession(state.session, 'cancelled'));
    }
    return this.info(this.requireSession(state.session.id).session);
  }

  private async runEditorTool(
    state: VersionedOfflineSession,
    name: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    if (!isExternalServerDirectTool(name)) {
      throw new ExternalEditorCallError(
        'rejected',
        `Tool ${name} requires the browser editor. Open ${this.editorUrl} for visual/canvas inspection, generation, upload, network, preset, render, or export tools.`,
      );
    }
    if (!isExternalServerDirectCall(name, args)) {
      throw new ExternalEditorCallError(
        'rejected',
        `Tool ${name} action ${String(args.action ?? '')} uses browser-backed data. Open ${this.editorUrl} to run it.`,
      );
    }
    const session = state.session;
    if (session.status !== 'drafting') {
      throw new Error(`Edit session ${session.id} is ${session.status}; editor tools require drafting status.`);
    }
    const candidate = forkExternalEditSession(session);
    const result = await this.executeTool(name, args, externalDraftContext(candidate, this.context(candidate)));
    await this.validateAvailabilityLocked();
    if (!toolReturnedError(result)) {
      const captured = captureExternalToolActions(candidate, name, args);
      await this.persistCheckpoint(state, captured);
      this.publishSession(state, captured);
    }
    return result;
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
    const reviewedState = this.publishSession(state, reviewExternalEditSession(session, summary));
    let result: OfflineProjectCommitResult;
    try {
      result = await this.commitReviewedDraft(reviewedState, draftDoc);
    } catch {
      const outcome = this.disposed ? 'cancelled' : 'failed';
      this.finishIfCurrent(reviewedState, outcome);
      const message = this.disposed
        ? 'The MCP transport closed before commit; the incremental draft checkpoint was preserved.'
        : 'The offline project commit failed; start a new MCP session to resume the saved draft.';
      throw new ExternalEditorCallError(outcome, message);
    }
    if (result.status !== 'applied' || !result.revision) {
      const outcome = this.disposed
        ? 'cancelled'
        : result.status === 'metadata-conflict'
          ? 'failed'
          : 'stale';
      this.finishIfCurrent(reviewedState, outcome);
      const message = this.disposed
        ? 'The MCP transport closed before commit; the incremental draft checkpoint was preserved.'
        : result.status === 'browser-takeover'
          ? `Project ${this.projectId} opened in a browser before commit. Start a new MCP session at ${this.editorUrl}.`
          : result.status === 'stale'
            ? `Stored project ${this.projectId} changed before commit. Start a new MCP session.`
            : 'Project metadata kept changing; no offline edits were written.';
      throw new ExternalEditorCallError(outcome, message);
    }
    if (this.disposed || !this.isCurrent(reviewedState, 'awaiting_review')) {
      const outcome = this.disposed ? 'cancelled' : 'stale';
      this.finishIfCurrent(reviewedState, outcome);
      throw new ExternalEditorCallError(
        outcome,
        this.disposed
          ? 'The MCP transport closed before commit; the incremental draft checkpoint was preserved.'
          : `Edit session ${session.id} changed before the commit result was published.`,
      );
    }
    this.expectedRevision = result.revision;
    this.baseDoc = draftDoc;
    let cleanupWarning: string | undefined;
    try {
      await this.persistence.deleteCheckpoint?.(this.projectId, session.id);
    } catch {
      cleanupWarning = 'The applied draft checkpoint could not be removed; its stale revision prevents reuse.';
    }
    const applied = finishExternalEditSession(
      reviewedState.session,
      'applied',
      reviewedState.session.operationCount,
    );
    const info = this.info(this.publishSession(reviewedState, applied).session);
    return cleanupWarning ? { ...info, warning: cleanupWarning } : info;
  }

  private async commitReviewedDraft(
    state: VersionedOfflineSession,
    doc: OfflineStoredProject['doc'],
  ): Promise<OfflineProjectCommitResult> {
    return this.persistence.commitProject({
      projectId: this.projectId,
      expectedRevision: this.expectedRevision,
      doc,
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
    if (!state) throw new Error(`Unknown edit session ${sessionId}`);
    return state;
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
      editorUrl: this.editorUrl,
      updatedAt: new Date(session.updatedAt).toISOString(),
    };
  }
}
