import type { ModelMessage } from 'ai';
import type { CodexAgentToolSpec } from '../../../shared/codex-agent';
import type { AgentContext } from '../context';
import type { AgentEvent, LLMMessage, RuntimeGuardRequest } from '../runtime';
import type { AgentToolSchema } from '../tool-schema';
import type { GuardDecision } from '../skills/costGuard';
import type { AgentSettings } from '../settings/agentSettings';
import type { AgentRunRecorder } from '../runtime-ledger';
import type { HarnessToolExecutionContext } from '../harness-context';
import type { AgentToolOutcome } from '../../persist/agentRuntimeStore';
import { normalizeLlmMessages } from '../messages';
import { activationProviderOptions } from '../tool-activation';
import {
  estimateContextTokens,
  estimateTextTokens,
  serializeMessagesForPrompt,
} from '../context-compaction';
import type { TimelineSnapshot } from '../timelineDelta';
import { executeTool as executeEditorTool } from '../tools';
import { describeTimelineDelta, snapshotTimeline } from '../timelineDelta';
import { buildAgentSystemPrompt } from '../systemPrompt';
import { runCodexTurn } from './client';
import { isFailedToolResult, ToolFailureTracker } from '../toolFailure';
import {
  policyForTool,
  validateAgentToolInvocation,
  type ToolExecutionPolicy,
} from '../execution-policy';
import { guardRequestForPolicy } from '../runtime-guard';
import { digestAgentToolArgs, TOOL_ARTIFACT_THRESHOLD } from '../runtime-ledger';
import {
  artifactPlaceholder,
  attachAgentArtifactRef,
  sanitizeJsonForArtifact,
} from '../runtime-artifact';
import { sha256Text } from '../../persist/agentRuntimeStore';
import {
  CodexFollowupPause,
  CodexToolRefresh,
  MaxOutputTokensError,
  MaxToolTurnsError,
  currentCodexTools,
  flushBufferedCompletion,
  handleCodexStreamEvent,
  unresolvedFailureCompletion,
  type CodexRuntimeOptions,
  type CodexToolExecution,
  type StreamState,
} from './stream-events';
export type { CodexRuntimeOptions, CodexToolExecution } from './stream-events';
export { runCodexSummary } from './summary';

export interface LocalToolExecutionContext {
  readonly ctx: AgentContext;
  readonly onEvent: (event: AgentEvent) => void;
  readonly settings: AgentSettings;
  readonly resolveGuard: (
    name: string,
    args: Record<string, unknown>,
    ctx: AgentContext,
  ) => Promise<RuntimeGuardRequest | null>;
  readonly onSkillGuard?: (info: RuntimeGuardRequest) => Promise<GuardDecision>;
  readonly onFollowup?: () => void;
  readonly toolCatalog?: readonly AgentToolSchema[];
  readonly activeToolCatalog?: readonly AgentToolSchema[];
  readonly harness?: HarnessToolExecutionContext;
  readonly runRecorder?: AgentRunRecorder;
  readonly toolCallId?: string;
  readonly signal?: AbortSignal;
  /** Focused verification seam; production uses the canonical lazy tool dispatcher. */
  readonly executeTool?: typeof executeEditorTool;
}

interface ToolBoundaryState {
  readonly toolCallId: string;
  policy: ToolExecutionPolicy;
  argsDigest?: string;
  operationId?: string;
  before?: TimelineSnapshot;
  started: boolean;
}
class ToolBoundaryError extends Error {
  readonly outcome: AgentToolOutcome;
  constructor(message: string, outcome: AgentToolOutcome) {
    super(message);
    this.outcome = outcome;
  }
}

function throwIfToolAborted(signal: AbortSignal | undefined, state: ToolBoundaryState): void {
  if (!signal?.aborted) return;
  const outcome: AgentToolOutcome = state.started
    ? { kind: 'outcome_unknown', operationId: state.operationId ?? state.toolCallId }
    : { kind: 'aborted_before_side_effect' };
  throw new ToolBoundaryError('Tool execution was stopped.', outcome);
}

export function buildCodexSystemPrompt(ctx: AgentContext): string {
  return buildAgentSystemPrompt(ctx);
}
async function prepareToolBoundary(
  schema: AgentToolSchema,
  args: Record<string, unknown>,
  execution: LocalToolExecutionContext,
  state: ToolBoundaryState,
): Promise<RuntimeGuardRequest | null> {
  const active = execution.activeToolCatalog ?? execution.toolCatalog ?? [schema];
  const validation = validateAgentToolInvocation(schema, args, active);
  if (!validation.ok) {
    throw new ToolBoundaryError(validation.error, {
      kind: 'validation_failed', summary: validation.issues.join('; ').slice(0, 1_000),
    });
  }
  const resolvedGuard = await execution.resolveGuard(schema.name, args, execution.ctx);
  state.policy = policyForTool(schema.name, resolvedGuard, args);
  state.operationId = resolvedGuard?.operationId;
  state.argsDigest = execution.runRecorder
    ? (await execution.runRecorder.recordToolRequested({
      toolCallId: state.toolCallId, toolName: schema.name, args,
      operationId: resolvedGuard?.operationId,
    })).argsDigest
    : await digestAgentToolArgs(args);
  const guard = guardRequestForPolicy(schema.name, args, state.policy, resolvedGuard);
  return guard ? { ...guard, argsDigest: state.argsDigest } : null;
}
async function requestToolApproval(
  schema: AgentToolSchema,
  guard: RuntimeGuardRequest | null,
  execution: LocalToolExecutionContext,
  state: ToolBoundaryState,
): Promise<GuardDecision> {
  if (state.policy.approval === 'never') return 'allow-once';
  if (!guard) return 'deny';
  // YOLO mode: no confirmation for any operation, paid tools included.
  // The user explicitly accepted the cost risk of generation/export/
  // transcription/web/sandbox calls by enabling auto approval.
  if (execution.ctx.getApprovalMode?.() === 'auto') return 'allow-once';
  if (!execution.runRecorder) return 'deny';
  const approval = execution.runRecorder
    ? await execution.runRecorder.recordApprovalRequested({
      toolCallId: state.toolCallId, toolName: schema.name,
      argsDigest: state.argsDigest!, operationId: state.operationId, summary: guard.summary,
    })
    : null;
  throwIfToolAborted(execution.signal, state);
  const requested = execution.onSkillGuard ? await execution.onSkillGuard(guard) : 'deny';
  const decision = requested === 'allow-scope' && state.policy.approval !== 'project'
    ? 'allow-once' : requested;
  if (approval) {
    await execution.runRecorder!.recordApprovalDecision(
      approval.approvalId,
      decision === 'deny' ? 'denied' : 'allowed',
    );
  }
  return decision;
}
function deniedResult(hasHandler: boolean): Record<string, unknown> {
  return {
    denied: true,
    note: hasHandler
      ? 'User denied this persistent, paid, or irreversible operation. Do not retry automatically.'
      : 'This persistent, paid, or irreversible operation requires confirmation, but no confirmation handler is available.',
  };
}
async function settleToolResult(
  schema: AgentToolSchema,
  args: Record<string, unknown>,
  rawResult: unknown,
  execution: LocalToolExecutionContext,
  state: ToolBoundaryState,
): Promise<CodexToolExecution> {
  throwIfToolAborted(execution.signal, state);
  const changed = state.before ? describeTimelineDelta(state.before, execution.ctx.getState()) : null;
  const enriched = changed && rawResult && typeof rawResult === 'object' && !Array.isArray(rawResult)
    ? { ...(rawResult as Record<string, unknown>), changed } : rawResult;
  const sanitized = sanitizeJsonForArtifact(enriched);
  if (!sanitized) throw new Error('tool_result_archive: result could not be serialized safely');
  const archiveExempt = schema.name === 'read_agent_artifact' || schema.name === 'load_skill';
  const requiresArchive = !archiveExempt && sanitized.originalChars > TOOL_ARTIFACT_THRESHOLD;
  const ref = await execution.runRecorder?.archiveToolResult({
    toolCallId: state.toolCallId, toolName: schema.name, result: enriched,
  });
  throwIfToolAborted(execution.signal, state);
  if (requiresArchive && !ref) {
    throw new Error('tool_result_archive: oversized result could not be archived safely');
  }
  const result = ref && (!enriched || typeof enriched !== 'object')
    ? artifactPlaceholder(ref)
    : ref ? attachAgentArtifactRef(enriched, ref) : enriched;
  const success = !isFailedToolResult(result);
  const outcome: AgentToolOutcome = success
    ? { kind: 'success', artifactId: ref?.artifactId }
    : state.policy.recovery === 'outcome_unknown'
      ? { kind: 'outcome_unknown', operationId: state.operationId ?? state.toolCallId }
      : { kind: 'terminal_failure', code: 'tool_failed' };
  const digest = ref?.bodySha256 ?? await sha256Text(sanitized.body);
  throwIfToolAborted(execution.signal, state);
  await execution.runRecorder?.recordToolOutcome({
    toolCallId: state.toolCallId, toolName: schema.name, argsDigest: state.argsDigest,
    operationId: state.operationId, outcome, resultDigest: digest,
    artifactId: ref?.artifactId,
  }).catch(() => undefined);
  throwIfToolAborted(execution.signal, state);
  execution.onEvent({ type: 'tool', name: schema.name, args, result });
  const followup = (rawResult as { __followup?: unknown } | null)?.__followup;
  if (success && typeof followup === 'string') {
    execution.onEvent({ type: 'text-start' });
    execution.onEvent({ type: 'text-delta', delta: followup });
    execution.onFollowup?.();
    return { success: true, result, followupText: followup };
  }
  return { success, result };
}
async function settleToolError(
  schema: AgentToolSchema,
  args: Record<string, unknown>,
  execution: LocalToolExecutionContext,
  state: ToolBoundaryState,
  error: unknown,
): Promise<CodexToolExecution> {
  const message = error instanceof Error ? error.message : String(error);
  const safeMessage = message.trim().slice(0, 1_000) || 'Tool execution failed.';
  const outcome = error instanceof ToolBoundaryError
    ? error.outcome
    : state.started && state.policy.recovery === 'outcome_unknown'
      ? { kind: 'outcome_unknown' as const, operationId: state.operationId ?? state.toolCallId }
      : { kind: 'terminal_failure' as const, code: 'execution_failed', summary: safeMessage };
  await execution.runRecorder?.recordToolOutcome({
    toolCallId: state.toolCallId, toolName: schema.name, argsDigest: state.argsDigest,
    operationId: state.operationId, outcome,
  }).catch(() => undefined);
  const failed = { error: safeMessage, ...(outcome.kind === 'outcome_unknown' ? { outcome: 'outcome_unknown' } : {}) };
  execution.onEvent({ type: 'tool', name: schema.name, args, result: failed });
  return { success: false, result: failed };
}
export async function executeOpenChatCutTool(
  schema: AgentToolSchema,
  args: Record<string, unknown>,
  execution: LocalToolExecutionContext,
): Promise<CodexToolExecution> {
  const state: ToolBoundaryState = {
    toolCallId: execution.toolCallId ?? crypto.randomUUID(),
    policy: policyForTool(schema.name, null, args), started: false,
  };
  try {
    const guard = await prepareToolBoundary(schema, args, execution, state);
    throwIfToolAborted(execution.signal, state);
    const decision = await requestToolApproval(schema, guard, execution, state);
    throwIfToolAborted(execution.signal, state);
    if (decision === 'deny') {
      const denied = deniedResult(!!execution.onSkillGuard);
      await execution.runRecorder?.recordToolOutcome({
        toolCallId: state.toolCallId, toolName: schema.name, argsDigest: state.argsDigest,
        operationId: state.operationId, outcome: { kind: 'denied' },
      });
      execution.onEvent({ type: 'tool', name: schema.name, args, result: denied });
      return { success: true, result: denied };
    }
    await execution.runRecorder?.recordToolStarted({
      toolCallId: state.toolCallId, toolName: schema.name,
      argsDigest: state.argsDigest!, operationId: state.operationId,
    });
    throwIfToolAborted(execution.signal, state);
    state.before = snapshotTimeline(execution.ctx.getState());
    state.started = true;
    const result = await (execution.executeTool ?? executeEditorTool)(
      schema.name, args, execution.ctx, execution.toolCatalog, execution.harness,
    );
    throwIfToolAborted(execution.signal, state);
    return await settleToolResult(schema, args, result, execution, state);
  } catch (error) {
    return settleToolError(schema, args, execution, state, error);
  }
}
interface LinkedAbort {
  readonly controller: AbortController;
  readonly unlink: () => void;
}

function linkedAbortController(signal?: AbortSignal): LinkedAbort {
  const controller = new AbortController();
  const forward = () => controller.abort(signal?.reason);
  if (signal?.aborted) forward();
  else signal?.addEventListener('abort', forward, { once: true });
  return {
    controller,
    unlink: () => signal?.removeEventListener('abort', forward),
  };
}
function attemptRuntimeOptions(
  opts: CodexRuntimeOptions,
  signal: AbortSignal,
  system: string,
  messages: readonly ModelMessage[],
  tools: readonly CodexAgentToolSpec[],
  compacted: boolean,
): CodexRuntimeOptions {
  return {
    ...opts,
    signal,
    contextWasCompacted: opts.contextWasCompacted === true || compacted,
    requestMessageCount: messages.length,
    systemTokens: estimateTextTokens(system),
    toolSchemaTokens: estimateTextTokens(JSON.stringify(tools)),
    requestMessages: messages,
    requestTools: tools,
    historyTokens: estimateContextTokens(messages),
    toolCount: tools.length,
  };
}



async function runCodexAttempt(
  conv: readonly ModelMessage[], projectId: string, state: StreamState,
  opts: CodexRuntimeOptions, onEvent: (event: AgentEvent) => void, fallbackSystem: string,
  onState: (state: StreamState) => void): Promise<StreamState> {
  const requestId = crypto.randomUUID();
  const { controller: turnAbort, unlink } = linkedAbortController(opts.signal);
  const tools = currentCodexTools(opts);
  const pendingMessages = [...(state.baseMessages ?? conv), ...state.toolHistory];
  const prepared = state.toolHistory.length
    ? await opts.prepareContextForTools?.(pendingMessages, tools) : undefined;
  const attemptMessages = prepared?.messages ?? pendingMessages;
  const system = opts.system ?? fallbackSystem;
  const attemptOpts = attemptRuntimeOptions(
    opts, turnAbort.signal, system, attemptMessages, tools, prepared?.compacted === true,
  );
  let next = prepared?.compacted
    ? { ...state, baseMessages: attemptMessages, toolHistory: [] }
    : state;
  onState(next);
  try {
    await runCodexTurn({
      requestId,
      system,
      prompt: serializeMessagesForPrompt(attemptMessages),
      projectId,
      tools,
      ...(opts.model?.trim() ? { model: opts.model.trim() } : {}),
      reasoningEffort: opts.reasoningEffort?.trim() || null,
      ...(opts.askOnly ? { askOnly: true } : {}),
    }, async (event) => {
      next = await handleCodexStreamEvent(event, next, requestId, attemptOpts, onEvent);
      onState(next);
    }, turnAbort.signal);
    if (!next.done) throw new Error('Codex stream ended before the done event.');
    return next;
  } catch (error) {
    turnAbort.abort(error);
    throw error;
  } finally {
    unlink();
  }
}
function historyMessages(conv: readonly ModelMessage[], state: StreamState): ModelMessage[] {
  return [...(state.baseMessages ?? conv), ...state.toolHistory];
}
function completedMessages(
  conv: readonly ModelMessage[],
  state: StreamState,
  onEvent: (event: AgentEvent) => void,
): ModelMessage[] {
  const history = historyMessages(conv, state);
  const failedContent = unresolvedFailureCompletion(state, onEvent);
  const content = failedContent ?? flushBufferedCompletion(state, onEvent);
  return content ? [...history, { role: 'assistant', content }] : history;
}
function followupMessage(
  text: string,
  tools: readonly { readonly name: string }[],
): ModelMessage {
  const providerOptions = activationProviderOptions(tools.map((tool) => tool.name));
  return providerOptions
    ? { role: 'assistant', content: [{ type: 'text', text, providerOptions }] }
    : { role: 'assistant', content: text };
}
function projectIdForRun(
  ctx: AgentContext,
  askOnly: boolean | undefined,
  onEvent: (event: AgentEvent) => void,
): string | null {
  const projectId = ctx.getProjectId?.().trim() ?? '';
  if (askOnly || projectId) return projectId;
  onEvent({ type: 'error', message: 'Agent edits require a persisted project id.' });
  return null;
}

export async function runCodexAgent(
  messages: LLMMessage[],
  ctx: AgentContext,
  onEvent: (event: AgentEvent) => void,
  opts: CodexRuntimeOptions,
): Promise<LLMMessage[]> {
  const conv = normalizeLlmMessages(messages);
  const projectId = projectIdForRun(ctx, opts.askOnly, onEvent);
  if (projectId === null) return conv;
  let state: StreamState = {
    done: false, outputTokens: 0, toolTurns: 0,
    handledCallIds: new Set(), toolHistory: [], bufferedText: '',
    toolFailures: opts.toolFailures ?? new ToolFailureTracker(),
  };
  for (;;) {
    try {
      state = await runCodexAttempt(conv, projectId, state, opts, onEvent, buildCodexSystemPrompt(ctx), (next) => { state = next; });
      return completedMessages(conv, state, onEvent);
    } catch (error) {
      if (error instanceof CodexToolRefresh) {
        state = { ...error.state, done: false, bufferedText: '' };
        continue;
      }
      if (error instanceof CodexFollowupPause) {
        state = error.state;
        const history = historyMessages(conv, state);
        return error.text
          ? [...history, followupMessage(error.text, currentCodexTools(opts))]
          : history;
      }
      if (error instanceof MaxToolTurnsError) state = error.state;
      if (error instanceof MaxToolTurnsError || error instanceof MaxOutputTokensError) {
        return completedMessages(conv, state, onEvent);
      }
      if (opts.signal?.aborted) {
        const abortedWithFailure = state.toolFailures.hasUnresolved;
        state.toolFailures.clear();
        const history = historyMessages(conv, state);
        if (abortedWithFailure) return history;
        const content = flushBufferedCompletion(state, onEvent);
        return content ? [...history, { role: 'assistant', content }] : history;
      }
      onEvent({ type: 'error', message: error instanceof Error ? error.message.trim() : String(error) });
      return completedMessages(conv, state, onEvent);
    }
  }
}
