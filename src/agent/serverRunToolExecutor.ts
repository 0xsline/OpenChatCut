import type { AgentContext } from './context';
import { agentAutoApply } from './approval-mode';
import { TOOL_SCHEMAS } from './tools';
import { executeCodexTool } from './runtime';
import { ToolActivation } from './tool-activation';
import type { AgentSettings } from './settings/agentSettings';
import { draftContext } from './useAgentRun';
import { makeDraft, type DraftEngine } from '../editor/store';
import type { ProjectDoc } from '../editor/types';
import type { DisplayMessage, LiveTool, PendingGuard } from './agent-session';
import { isCostAllowed, rememberCostAllowed, type GuardDecision } from './skills/costGuard';
import type { AgentEvent } from './runtime';
import {
  SERVER_RUN_CAPABILITY_HEADER,
  type ServerRunToolAction,
} from './serverRunProtocol';
import { permanentServerRunRecoveryError } from './serverRunRecovery';
import { ServerRunToolRequestQueue } from './serverRunEvents';
import {
  beginStoredToolAttempt,
  captureStoredToolResult,
  clearStoredToolAttempt,
  findStoredToolAttempt,
  patchStoredServerRun,
  storedClaimIdentity,
  type StoredToolAttempt,
} from './serverRunSessionStorage';
import { projectServerRunToolResult } from './serverRunToolResult';
import {
  permanentToolHttpStatus, scheduleServerRunToolResultRetry,
  type BrowserToolRequest, type ToolClaimResponse,
} from './serverRunToolTransport';
import {
  browserServerRunLockManager,
  withServerRunToolLock,
  type ServerRunLockManager,
} from './serverRunToolLock';
export {
  serverRunToolLockName,
  withServerRunToolLock,
  type ServerRunLockManager,
} from './serverRunToolLock';
import {
  reconcileStoredServerRunToolAttempts,
  type RecoveredServerTool,
} from './serverRunToolRecovery';
export type { RecoveredServerTool } from './serverRunToolRecovery';


export interface ServerToolExecutorCallbacks {
  readonly ctx: () => AgentContext;
  readonly settings: () => AgentSettings;
  readonly onToolAction: (action: ServerRunToolAction) => void | Promise<void>;
  readonly updateMessages: (
    update: (messages: DisplayMessage[]) => DisplayMessage[],
  ) => void;
  readonly setPendingGuard: (guard: PendingGuard | null) => void;
  readonly setLiveTool: (tool: LiveTool | null) => void;
  readonly retryStream: (runId: string) => void;
  readonly abandonRecovery: (runId: string, error: unknown) => void;
}

export interface ServerToolExecutorStart {
  readonly capability: string;
  readonly baseDoc: ProjectDoc;
  readonly draftDoc?: ProjectDoc;
  readonly activation: ToolActivation;
  readonly runId: string;
  readonly abort: AbortController;
  readonly recovered: ReadonlyMap<string, RecoveredServerTool>;
}



export class ServerRunToolExecutor {
  private readonly projectId: string;
  private claimId: string | null = null;
  private readonly requestQueue = new ServerRunToolRequestQueue();
  private callbacks: ServerToolExecutorCallbacks;
  private active = new Set<string>();
  private recovered = new Map<string, RecoveredServerTool>();
  private activation = new ToolActivation(TOOL_SCHEMAS, []);
  private draft: DraftEngine | null = null;
  private baseDoc: ProjectDoc | null = null;
  private runId: string | null = null;
  private capability: string | null = null;
  private abort: AbortController | null = null;
  private guardResolve: ((decision: GuardDecision) => void) | null = null;
  private readonly lockManager: ServerRunLockManager | null;

  constructor(
    projectId: string,
    callbacks: ServerToolExecutorCallbacks,
    lockManager: ServerRunLockManager | null = browserServerRunLockManager(),
  ) {
    this.projectId = projectId;
    this.callbacks = callbacks;
    this.lockManager = lockManager;
  }

  configure(callbacks: ServerToolExecutorCallbacks): void {
    this.callbacks = callbacks;
  }

  private recoveredActivation(input: ServerToolExecutorStart): ToolActivation {
    let activation = input.activation;
    for (const outcome of input.recovered.values()) {
      if (!outcome.name || outcome.error !== undefined) continue;
      activation = activation.withToolResult(outcome.name, outcome.result).activation;
    }
    return activation;
  }

  start(input: ServerToolExecutorStart): void {
    this.claimId = storedClaimIdentity(this.projectId);
    this.capability = input.capability;
    this.active.clear();
    this.recovered = new Map(input.recovered);
    this.activation = this.recoveredActivation(input);
    this.baseDoc = input.baseDoc;
    this.draft = input.draftDoc ? makeDraft(input.draftDoc) : null;
    this.runId = input.runId;
    this.abort = input.abort;
    patchStoredServerRun(this.projectId, {
      activeToolNames: this.activation.names(),
    });
  }

  stop(): void {
    this.guardResolve?.('deny');
    this.guardResolve = null;
    this.callbacks.setPendingGuard(null);
    this.abort?.abort();
  }

  confirmGuard(decision: GuardDecision): void {
    const resolve = this.guardResolve;
    this.guardResolve = null;
    this.callbacks.setPendingGuard(null);
    resolve?.(decision);
  }

  private async claim(
    runId: string,
    toolCallId: string,
    argsDigest: string,
  ): Promise<ToolClaimResponse | null> {
    if (!this.capability || !this.claimId) return null;
    const response = await fetch(`/api/agent-runs/${runId}/tool-claim`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        [SERVER_RUN_CAPABILITY_HEADER]: this.capability,
      },
      body: JSON.stringify({
        projectId: this.projectId,
        toolCallId,
        argsDigest,
        claimId: this.claimId,
      }),
      signal: this.abort?.signal,
    }).catch(() => null);
    if (response && (response.status === 403
      || response.status === 404
      || response.status === 410)) {
      this.callbacks.abandonRecovery(
        runId,
        permanentServerRunRecoveryError(
          `Server tool claim is permanently unavailable: HTTP ${response.status}`,
        ),
      );
      return { claimed: false, outcome: 'run-stale' };
    }
    if (!response || (response.status !== 200 && response.status !== 409)) return null;
    return response.json().catch(() => null) as Promise<ToolClaimResponse | null>;
  }

  private async postResult(
    runId: string,
    toolCallId: string,
    outcome: RecoveredServerTool,
  ): Promise<boolean> {
    if (!this.capability || !this.claimId) return false;
    const body = outcome.error === undefined
      ? {
        projectId: this.projectId,
        toolCallId,
        argsDigest: outcome.argsDigest,
        claimId: this.claimId,
        result: projectServerRunToolResult(outcome.result),
      }
      : {
        projectId: this.projectId,
        toolCallId,
        argsDigest: outcome.argsDigest,
        claimId: this.claimId,
        error: outcome.error,
      };
    const response = await fetch(`/api/agent-runs/${runId}/tool-result`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        [SERVER_RUN_CAPABILITY_HEADER]: this.capability,
      },
      body: JSON.stringify(body),
      signal: this.abort?.signal,
    }).catch(() => null);
    if (response && permanentToolHttpStatus(response.status)) {
      this.callbacks.abandonRecovery(
        runId,
        permanentServerRunRecoveryError(
          `Server tool result is permanently unavailable: HTTP ${response.status}`,
        ),
      );
      return true;
    }
    return response?.ok === true;
  }

  private retry(runId: string, toolCallId: string): void {
    this.active.delete(toolCallId);
    this.callbacks.retryStream(runId);
  }
  private scheduleResultRetry(
    runId: string,
    toolCallId: string,
    outcome: RecoveredServerTool,
    sessionAbort = this.abort,
  ): void {
    scheduleServerRunToolResultRetry(
      () => this.postResult(runId, toolCallId, outcome),
      () => clearStoredToolAttempt(this.projectId, toolCallId),
      () => Boolean(sessionAbort
        && sessionAbort === this.abort
        && !sessionAbort.signal.aborted),
    );
  }

  private async deliverClaimedRecovered(
    runId: string,
    toolCallId: string,
    argsDigest: string,
    outcome: RecoveredServerTool,
  ): Promise<boolean> {
    const replay = outcome.argsDigest === argsDigest
      ? outcome
      : { argsDigest, error: 'Recovered tool arguments do not match the server request.' };
    if (!await this.postResult(runId, toolCallId, replay)) {
      this.scheduleResultRetry(runId, toolCallId, replay);
      return false;
    }
    clearStoredToolAttempt(this.projectId, toolCallId);
    return true;
  }

  private async rejectClaimedInterrupted(
    runId: string,
    toolCallId: string,
    argsDigest: string,
  ): Promise<boolean> {
    const outcome = {
      argsDigest,
      error: 'Browser reloaded after this tool began; the operation was not replayed automatically.',
    };
    if (!await this.postResult(runId, toolCallId, outcome)) {
      this.scheduleResultRetry(runId, toolCallId, outcome);
      return false;
    }
    clearStoredToolAttempt(this.projectId, toolCallId);
    return true;
  }
  reconcileStoredAttempts(
    runId: string,
    attempts: readonly StoredToolAttempt[],
  ): Promise<void> {
    const sessionAbort = this.abort;
    return reconcileStoredServerRunToolAttempts({
      projectId: this.projectId,
      runId,
      attempts,
      lockManager: this.lockManager,
      active: () => Boolean(
        sessionAbort && sessionAbort === this.abort && !sessionAbort.signal.aborted,
      ),
      claim: (attempt) => this.claim(runId, attempt.toolCallId, attempt.argsDigest),
      recovered: (toolCallId) => this.recovered.get(toolCallId),
      post: (toolCallId, outcome) => this.postResult(runId, toolCallId, outcome),
    });
  }

  private guardRequest(info: Omit<PendingGuard, 'resolve'>): Promise<GuardDecision> {
    // YOLO (auto-apply) mode releases every confirmation card: the user opted
    // into unapproved execution (sessionPrefs documents the intent). Mirrors
    // the built-in path in useAgentRun so server runs honor the same mode.
    if (agentAutoApply()) return Promise.resolve('allow-once');
    const rememberable = info.approval === 'project' && info.permissionKind === 'paid_external';
    if (rememberable && isCostAllowed(info.skill, this.projectId)) {
      return Promise.resolve('allow-once');
    }
    const { promise, resolve } = Promise.withResolvers<GuardDecision>();
    // Both the UI card resolve and confirmGuard must land in the same settle
    // closure so allow-scope memory is recorded regardless of entry point.
    const settle = (requested: GuardDecision): void => {
      this.guardResolve = null;
      this.callbacks.setPendingGuard(null);
      const decision = requested === 'allow-scope' && !rememberable ? 'allow-once' : requested;
      if (decision === 'allow-scope') rememberCostAllowed(info.skill, this.projectId);
      resolve(decision);
    };
    this.guardResolve = settle;
    this.callbacks.setPendingGuard({ ...info, resolve: settle });
    return promise;
  }

  private async reportFailure(
    runId: string,
    toolCallId: string,
    request: BrowserToolRequest,
    error: unknown,
    persist: boolean,
  ): Promise<boolean> {
    if (this.abort?.signal.aborted) return false;
    const message = error instanceof Error ? error.message : String(error);
    const outcome: ServerRunToolAction = {
      runId: this.runId ?? runId,
      toolCallId,
      argsDigest: request.argsDigest,
      name: request.name,
      args: request.args,
      error: message,
      actions: persist ? (this.draft?.takeActions() ?? []) : [],
      baseDoc: this.baseDoc ?? this.callbacks.ctx().getDoc(),
    };
    if (persist) {
      await Promise.resolve(this.callbacks.onToolAction(outcome)).catch(() => undefined);
    }
    const recovered = { name: request.name, argsDigest: request.argsDigest, error: message };
    void captureStoredToolResult(this.projectId, toolCallId, recovered);
    this.recovered.set(toolCallId, recovered);
    if (!await this.postResult(runId, toolCallId, recovered)) {
      this.scheduleResultRetry(runId, toolCallId, recovered);
      return false;
    }
    clearStoredToolAttempt(this.projectId, toolCallId);
    return true;
  }

  private async finishExecution(
    runId: string,
    toolCallId: string,
    request: BrowserToolRequest,
    result: unknown,
  ): Promise<boolean> {
    if (!patchStoredServerRun(this.projectId, {
      activeToolNames: this.activation.names(),
    })) {
      return this.reportFailure(
        runId,
        toolCallId,
        request,
        new Error('Browser durable storage could not save the active tool set.'),
        false,
      );
    }
    this.callbacks.updateMessages((current) => [
      ...current,
      { role: 'tool', text: '', tool: { name: request.name, args: request.args, result } },
    ]);
    const recovered = {
      name: request.name,
      argsDigest: request.argsDigest,
      result: result ?? null,
    };
    void captureStoredToolResult(this.projectId, toolCallId, recovered);
    this.recovered.set(toolCallId, recovered);
    if (!await this.postResult(runId, toolCallId, recovered)) {
      this.scheduleResultRetry(runId, toolCallId, recovered);
      return false;
    }
    clearStoredToolAttempt(this.projectId, toolCallId);
    return true;
  }

  private async execute(
    runId: string,
    toolCallId: string,
    request: BrowserToolRequest,
  ): Promise<boolean> {
    if (!this.draft) this.draft = makeDraft(this.baseDoc ?? this.callbacks.ctx().getDoc());
    this.callbacks.setLiveTool({ name: request.name, partial: '' });
    try {
      let update;
      try {
        update = await executeCodexTool({
          name: request.name,
          args: request.args,
          activation: this.activation,
          ctx: draftContext(this.callbacks.ctx(), this.draft),
          onEvent: (_event: AgentEvent) => undefined,
          settings: this.callbacks.settings(),
          onSkillGuard: (info) => this.guardRequest(info),

          toolCallId,
          signal: this.abort?.signal,
        });
      } catch (error) {
        return this.reportFailure(runId, toolCallId, request, error, true);
      }
      this.activation = update.activation;
      // ask_followup_questions-style tools surface their question through the
      // followup channel; the server path has no CodexFollowupPause plumbing,
      // so append it as a visible assistant message instead of dropping it.
      const followupText = update.execution.followupText?.trim();
      if (followupText) {
        this.callbacks.updateMessages((messages) => [
          ...messages,
          { role: 'assistant', text: followupText },
        ]);
      }
      const outcome: ServerRunToolAction = {
        runId: this.runId ?? runId,
        toolCallId,
        argsDigest: request.argsDigest,
        name: request.name,
        args: request.args,
        result: update.execution.result,
        actions: this.draft.takeActions(),
        baseDoc: this.baseDoc ?? this.callbacks.ctx().getDoc(),
      };
      try {
        await this.callbacks.onToolAction(outcome);
      } catch {
        // The tool already executed; retry the durable draft write once so
        // its actions are not lost (reportFailure with persist=false would
        // drop them and a model-side retry could double-execute).
        try {
          await this.callbacks.onToolAction(outcome);
        } catch (retryError) {
          return this.reportFailure(runId, toolCallId, request, retryError, false);
        }
      }
      return this.finishExecution(runId, toolCallId, request, update.execution.result);
    } finally {
      this.callbacks.setLiveTool(null);
    }
  }

  private async processLocked(
    runId: string,
    toolCallId: string,
    request: BrowserToolRequest,
  ): Promise<boolean> {
    const claim = await this.claim(runId, toolCallId, request.argsDigest);
    if (!claim) {
      this.retry(runId, toolCallId);
      return false;
    }
    if (!claim.claimed) return false;
    const recovered = this.recovered.get(toolCallId);
    if (recovered) {
      if (!request.admit()) return false;
      return this.deliverClaimedRecovered(runId, toolCallId, request.argsDigest, recovered);
    }
    if (findStoredToolAttempt(this.projectId, toolCallId)) {
      if (!request.admit()) return false;
      return this.rejectClaimedInterrupted(runId, toolCallId, request.argsDigest);
    }
    const durableAttempt = beginStoredToolAttempt(
      this.projectId,
      toolCallId,
      request.argsDigest,
    );
    if (!request.admit()) return false;
    if (!durableAttempt || claim.outcome === 'duplicate') {
      const error = durableAttempt
        ? 'The tool claim was recovered without a durable result; the operation was not replayed.'
        : 'Browser durable storage is unavailable; the tool was not executed.';
      const outcome = { name: request.name, argsDigest: request.argsDigest, error };
      this.recovered.set(toolCallId, outcome);
      if (!await this.postResult(runId, toolCallId, outcome)) {
        this.scheduleResultRetry(runId, toolCallId, outcome);
        return false;
      }
      clearStoredToolAttempt(this.projectId, toolCallId);
      return true;
    }
    return this.execute(runId, toolCallId, request);
  }

  private async process(
    runId: string,
    toolCallId: string,
    name: string,
    args: Record<string, unknown>,
    argsDigest: string,
    admit: () => boolean,
  ): Promise<boolean> {
    if (this.active.has(toolCallId)) return false;
    this.active.add(toolCallId);
    const request = { name, args, argsDigest, admit };
    const locked = await withServerRunToolLock(
      this.lockManager,
      this.projectId,
      runId,
      toolCallId,
      () => this.processLocked(runId, toolCallId, request),
    );
    return locked.acquired ? locked.value : false;
  }

  handle(
    runId: string,
    toolCallId: string,
    name: string,
    args: Record<string, unknown>,
    argsDigest: string,
    admit: () => boolean,
  ): Promise<boolean> {
    const sessionAbort = this.abort;
    return this.requestQueue.enqueue(runId, async () => {
      if (!sessionAbort
        || sessionAbort !== this.abort
        || sessionAbort.signal.aborted) return false;
      return this.process(runId, toolCallId, name, args, argsDigest, admit);
    });
  }
}
