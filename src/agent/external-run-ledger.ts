import {
  sha256Text,
  type AgentRunStatus,
  type AgentToolOutcome,
} from '../persist/agentRuntimeStore';
import { AgentRunRecorder, resumeAgentRun, startAgentRun } from './runtime-ledger';
import {
  policyForTool,
  type ToolExecutionPolicy,
} from './execution-policy';
import type { AgentContext } from './context';
import {
  captureExternalToolActions,
  externalDraftContext,
  ExternalEditSessionOutcomeError,
  forkExternalEditSession,
  isExternalEditSessionStale,
  type ExternalEditSession,
} from './external-edit-session';
import { isExternalDraftTool, isExternalRealTool } from './external-tool-policy';
import { throwIfExternalCallCancelled } from './external-bridge-session';
import {
  artifactPlaceholder,
  redactTextForAgentRuntime,
  sanitizeJsonForArtifact,
} from './runtime-artifact';
import { compactToolResultForModel } from './tool-result-compaction';
import type { ExternalApprovalBinding } from './external-approval-gate';

export type ExternalToolExecutor = (
  name: string,
  args: Record<string, unknown>,
  context: AgentContext,
) => Promise<unknown>;



export interface ExternalRecordedInvocation {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly argsDigest: string;
  readonly operationId?: string;
  readonly policy: ToolExecutionPolicy;
}

export function invocationFromApproval(
  binding: ExternalApprovalBinding,
): ExternalRecordedInvocation {
  return {
    toolCallId: binding.toolCallId,
    toolName: binding.tool,
    argsDigest: binding.argsDigest,
    operationId: binding.operationId,
    policy: policyForTool(binding.tool),
  };
}

export function externalToolFailureOutcome(
  invocation: ExternalRecordedInvocation,
  error: unknown,
  started: boolean,
): AgentToolOutcome {
  if (error instanceof ExternalEditSessionOutcomeError) {
    if (error.outcome === 'stale') return { kind: 'stale', summary: error.message };
    if (error.outcome === 'cancelled' && !started) {
      return { kind: 'aborted_before_side_effect', summary: error.message };
    }
  }
  const summary = error instanceof Error ? error.message : String(error);
  if (started && invocation.policy.recovery === 'outcome_unknown') {
    return { kind: 'outcome_unknown', operationId: invocation.operationId, summary };
  }
  return { kind: 'terminal_failure', operationId: invocation.operationId, summary };
}

export function externalToolResultFailure(
  invocation: ExternalRecordedInvocation,
  result: unknown,
): AgentToolOutcome | null {
  if (!result || typeof result !== 'object' || Array.isArray(result)
      || !('error' in result) || typeof result.error !== 'string') return null;
  return {
    kind: invocation.policy.recovery === 'outcome_unknown'
      ? 'outcome_unknown'
      : 'terminal_failure',
    operationId: invocation.operationId,
    summary: result.error,
  };
}
function boundedExternalToolError(error: unknown): ExternalEditSessionOutcomeError {
  const message = redactTextForAgentRuntime(
    error instanceof Error ? error.message : String(error),
  ).slice(0, 1_200) || 'External tool execution failed.';
  return error instanceof ExternalEditSessionOutcomeError
    ? new ExternalEditSessionOutcomeError(error.outcome, message)
    : new ExternalEditSessionOutcomeError('failed', message);
}


export interface ExecutedExternalDraftTool {
  readonly session: ExternalEditSession;
  readonly result: unknown;
}
export interface ExternalDraftToolInput {
  readonly session: ExternalEditSession;
  readonly name: string;
  readonly args: Record<string, unknown>;
  readonly context: AgentContext;
  readonly signal?: AbortSignal;
  readonly markStale: () => Promise<void>;
}

function requireDraftTool(
  session: ExternalEditSession,
  toolName: string,
  args: Readonly<Record<string, unknown>>,
): void {
  if (!isExternalDraftTool(toolName) || isExternalRealTool(toolName, args)) {
    throw new ExternalEditSessionOutcomeError(
      'rejected',
      `Tool ${toolName} is not available in isolated edit sessions.`,
    );
  }
  if (session.status !== 'drafting') {
    throw new ExternalEditSessionOutcomeError(
      'rejected',
      `Edit session ${session.id} is ${session.status}; editor tools require drafting status.`,
    );
  }
}

export class ExternalSessionRunLedger {
  readonly runId: string;
  private readonly recorder: AgentRunRecorder;
  private readonly executeTool?: ExternalToolExecutor;

  private constructor(recorder: AgentRunRecorder, executeTool?: ExternalToolExecutor) {
    this.recorder = recorder;
    this.executeTool = executeTool;
    this.runId = recorder.runId;
  }

  static async start(
    projectId: string,
    clientName: string,
    editSessionId: string,
    backend: 'external-connected' | 'external-offline' = 'external-connected',
    executeTool?: ExternalToolExecutor,
  ): Promise<ExternalSessionRunLedger> {
    const recorder = await startAgentRun({
      projectId,
      externalSessionId: editSessionId,
      userInput: `External edit session ${editSessionId} started by ${clientName}`,
      askOnly: false,
    });
    await recorder.configure({
      modelId: clientName,
      backend,
      askOnly: false,
    });
    return new ExternalSessionRunLedger(recorder, executeTool);
  }

  static async resume(
    projectId: string,
    runId: string,
    executeTool?: ExternalToolExecutor,
    claimedLeaseToken?: string,
  ): Promise<ExternalSessionRunLedger | null> {
    const recorder = await resumeAgentRun(projectId, runId, claimedLeaseToken);
    return recorder ? new ExternalSessionRunLedger(recorder, executeTool) : null;
  }

  async requested(
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<ExternalRecordedInvocation> {
    const toolCallId = `external_${crypto.randomUUID()}`;
    const operationId = typeof args.operationId === 'string' ? args.operationId : undefined;
    const { argsDigest } = await this.recorder.recordToolRequested({
      toolCallId,
      toolName,
      args,
      operationId,
    });
    return {
      toolCallId,
      toolName,
      argsDigest,
      operationId,
      policy: policyForTool(toolName, args),
    };
  }

  async started(invocation: ExternalRecordedInvocation): Promise<void> {
    await this.recorder.recordToolStarted(invocation);
  }

  private async captureExactSkillResult(
    invocation: ExternalRecordedInvocation,
    outcome: AgentToolOutcome,
    result: unknown,
  ): Promise<unknown> {
    try {
      const body = JSON.stringify(result);
      if (body === undefined) throw new Error('load_skill result is not JSON serializable');
      await this.recorder.recordToolOutcome({
        ...invocation,
        outcome,
        resultDigest: await sha256Text(body),
      });
      return JSON.parse(body);
    } catch {
      await this.recordProjectionFailure(invocation);
      throw new ExternalEditSessionOutcomeError(
        'failed',
        'The load_skill result could not be projected exactly.',
      );
    }
  }

  async captureToolOutcome(
    invocation: ExternalRecordedInvocation,
    outcome: AgentToolOutcome,
    result?: unknown,
  ): Promise<unknown> {
    if (result !== undefined && invocation.toolName === 'load_skill') {
      return this.captureExactSkillResult(invocation, outcome, result);
    }
    const imagePayloads = result
      && typeof result === 'object'
      && !Array.isArray(result)
      && Array.isArray((result as Record<string, unknown>).__images)
      ? (result as Record<string, unknown>).__images as unknown[]
      : [];
    const archiveResult = imagePayloads.length
      ? Object.fromEntries(Object.entries(result as Record<string, unknown>)
        .filter(([key]) => key !== '__images'))
      : result;
    const sanitized = result === undefined ? null : sanitizeJsonForArtifact(archiveResult);
    if (result !== undefined && !sanitized) {
      await this.recordProjectionFailure(invocation);
      throw new ExternalEditSessionOutcomeError(
        'failed',
        'The tool result could not be serialized safely, so no external result was returned.',
      );
    }
    let artifact = null;
    try {
      artifact = result === undefined
        ? null
        : await this.recorder.archiveToolResult({
          toolCallId: invocation.toolCallId,
          toolName: invocation.toolName,
          result: archiveResult,
          forceArchive: true,
        });
      await this.recorder.recordToolOutcome({
        ...invocation,
        outcome,
        resultDigest: artifact?.bodySha256,
        artifactId: artifact?.artifactId,
      });
    } catch {
      await this.recordProjectionFailure(invocation);
      throw new ExternalEditSessionOutcomeError(
        'failed',
        'The tool result could not be archived safely, so no external result was returned.',
      );
    }
    if (result === undefined) return undefined;
    if (imagePayloads.length) {
      const metadata = artifact
        ? artifactPlaceholder(artifact)
        : compactToolResultForModel(JSON.parse(sanitized!.body));
      return metadata && typeof metadata === 'object' && !Array.isArray(metadata)
        ? { ...metadata as Record<string, unknown>, __images: imagePayloads }
        : { result: metadata, __images: imagePayloads };
    }
    if (artifact) return artifactPlaceholder(artifact);
    return compactToolResultForModel(JSON.parse(sanitized!.body));
  }

  private async recordProjectionFailure(
    invocation: ExternalRecordedInvocation,
  ): Promise<void> {
    await this.recorder.recordToolOutcome({
      ...invocation,
      outcome: {
        kind: 'terminal_failure',
        operationId: invocation.operationId,
        code: 'external_result_projection_failed',
        summary: 'The tool result could not be safely archived or projected.',
      },
    }).catch(() => undefined);
  }

  async approvalRequested(
    binding: Omit<ExternalApprovalBinding, 'guardId'>,
  ): Promise<string> {
    const approval = await this.recorder.recordApprovalRequested({
      toolCallId: binding.toolCallId,
      toolName: binding.tool,
      argsDigest: binding.argsDigest,
      operationId: binding.operationId,
      summary: binding.summary,
    });
    return approval.approvalId;
  }

  async approvalDecision(binding: ExternalApprovalBinding, allow: boolean): Promise<void> {
    await this.recorder.recordApprovalDecision(
      binding.guardId,
      allow ? 'allowed' : 'denied',
    );
    if (!allow) {
      await this.recorder.recordToolOutcome({
        toolCallId: binding.toolCallId,
        toolName: binding.tool,
        argsDigest: binding.argsDigest,
        operationId: binding.operationId,
        outcome: { kind: 'denied', summary: 'User denied external tool execution.' },
      });
    }
  }

  async executeDraftTool(
    input: ExternalDraftToolInput,
  ): Promise<ExecutedExternalDraftTool> {
    requireDraftTool(input.session, input.name, input.args);
    const invocation = await this.requested(input.name, input.args);
    if (isExternalEditSessionStale(input.session, input.context.getDoc())) {
      const error = new ExternalEditSessionOutcomeError(
        'stale',
        `Edit session ${input.session.id} is stale; begin a new session.`,
      );
      await this.captureToolOutcome(invocation, { kind: 'stale', summary: error.message });
      await input.markStale();
      throw error;
    }
    let result: unknown;
    let started = false;
    const candidate = forkExternalEditSession(input.session);
    try {
      throwIfExternalCallCancelled(input.signal);
      await this.started(invocation);
      started = true;
      result = await this.requiredToolExecutor()(
        input.name,
        input.args,
        externalDraftContext(candidate, input.context),
      );
      throwIfExternalCallCancelled(input.signal);
    } catch (error) {
      await this.captureToolOutcome(invocation, externalToolFailureOutcome(invocation, error, started));
      throw boundedExternalToolError(error);
    }
    if (isExternalEditSessionStale(input.session, input.context.getDoc())) {
      const error = new ExternalEditSessionOutcomeError(
        'stale',
        `Edit session ${input.session.id} became stale while ${input.name} was running.`,
      );
      await this.captureToolOutcome(invocation, { kind: 'stale', summary: error.message });
      await input.markStale();
      throw error;
    }
    const session = captureExternalToolActions(candidate, input.name, input.args);
    const failure = externalToolResultFailure(invocation, result);
    const projected = await this.captureToolOutcome(
      invocation,
      failure ?? { kind: 'success' },
      result,
    );
    return { session, result: projected };
  }

  async executeApprovedTool(
    invocation: ExternalRecordedInvocation,
    args: Record<string, unknown>,
    context: AgentContext,
    signal?: AbortSignal,
  ): Promise<unknown> {
    let started = false;
    let result: unknown;
    try {
      throwIfExternalCallCancelled(signal);
      await this.started(invocation);
      started = true;
      result = await this.requiredToolExecutor()(invocation.toolName, args, context);
    } catch (error) {
      await this.captureToolOutcome(
        invocation,
        externalToolFailureOutcome(invocation, error, started),
      );
      throw boundedExternalToolError(error);
    }
    const failure = externalToolResultFailure(invocation, result);
    return this.captureToolOutcome(invocation, failure ?? { kind: 'success' }, result);
  }
  private requiredToolExecutor(): ExternalToolExecutor {
    if (!this.executeTool) {
      throw new Error('This external run ledger is not connected to an editor tool executor.');
    }
    return this.executeTool;
  }

  confirmOwnership(): Promise<void> {
    return this.recorder.confirmOwnership();
  }

  cancelPendingApprovalsOnHydration(): Promise<void> {
    return this.recorder.cancelPendingApprovalsOnHydration();
  }

  releaseForRestart(): Promise<void> {
    return this.recorder.releaseLease();
  }

  disconnect(): Promise<void> {
    return this.recorder.disconnect();
  }

  dispose(): void {
    void this.disconnect().catch(() => undefined);
  }

  async proposal(proposalId: string, status: 'created' | 'applied' | 'rejected' | 'stale'): Promise<void> {
    await this.recorder.recordProposal(proposalId, status);
  }

  async finalize(status: AgentRunStatus, summary: string): Promise<void> {
    await this.recorder.finalize(status, summary);
  }
}
