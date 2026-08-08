import type { ModelMessage } from 'ai';
import type { AgentContext } from '../context';
import type { AgentEvent, LLMMessage, RuntimeGuardRequest } from '../runtime';
import type { AgentToolSchema } from '../tool-schema';
import type { GuardDecision } from '../skills/costGuard';
import type { AgentSettings } from '../settings/agentSettings';
import { normalizeLlmMessages } from '../messages';
import { activationProviderOptions } from '../tool-activation';
import {
  estimateContextTokens,
  estimateTextTokens,
  serializeMessagesForPrompt,
} from '../context-compaction';
import { executeTool as executeEditorTool } from '../tools';
import { describeTimelineDelta, snapshotTimeline } from '../timelineDelta';
import { buildAgentSystemPrompt } from '../systemPrompt';
import { runCodexTurn } from './client';
import { isFailedToolResult, ToolFailureTracker } from '../toolFailure';
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
}

export function buildCodexSystemPrompt(ctx: AgentContext): string {
  return buildAgentSystemPrompt(ctx);
}
export async function executeOpenChatCutTool(
  schema: AgentToolSchema,
  args: Record<string, unknown>,
  execution: LocalToolExecutionContext,
): Promise<CodexToolExecution> {
  const { ctx, onEvent, resolveGuard, onSkillGuard, onFollowup } = execution;
  try {
    const guard = await resolveGuard(schema.name, args, ctx);
    if (guard) {
      const decision = onSkillGuard ? await onSkillGuard(guard) : 'deny';
      if (decision === 'deny') {
        const denied = {
          denied: true,
          note: onSkillGuard
            ? 'User denied this high-cost or irreversible operation. Do not retry automatically; ask what to adjust instead.'
            : 'This high-cost or irreversible operation requires runtime confirmation, but no confirmation handler is available.',
        };
        onEvent({ type: 'tool', name: schema.name, args, result: denied });
        return { success: true, result: denied };
      }
    }
    const before = snapshotTimeline(ctx.getState());
    const result = await executeEditorTool(schema.name, args, ctx, execution.toolCatalog);
    const changed = describeTimelineDelta(before, ctx.getState());
    const enriched = changed && result && typeof result === 'object' && !Array.isArray(result)
      ? { ...(result as Record<string, unknown>), changed }
      : result;
    onEvent({ type: 'tool', name: schema.name, args, result: enriched });
    const success = !isFailedToolResult(enriched);
    const followup = (result as { __followup?: unknown } | null)?.__followup;
    if (success && typeof followup === 'string') {
      onEvent({ type: 'text-start' });
      onEvent({ type: 'text-delta', delta: followup });
      onFollowup?.();
      return { success: true, result: enriched, followupText: followup };
    }
    return { success, result: enriched };
  } catch (error) {
    const failed = { error: error instanceof Error ? error.message : String(error) };
    onEvent({ type: 'tool', name: schema.name, args, result: failed });
    return { success: false, result: failed };
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


async function runCodexAttempt(
  conv: readonly ModelMessage[], projectId: string, state: StreamState,
  opts: CodexRuntimeOptions, onEvent: (event: AgentEvent) => void,
  fallbackSystem: string, onState: (state: StreamState) => void,
): Promise<StreamState> {
  const requestId = crypto.randomUUID();
  const { controller: turnAbort, unlink } = linkedAbortController(opts.signal);
  const tools = currentCodexTools(opts);
  const pendingMessages = [...(state.baseMessages ?? conv), ...state.toolHistory];
  const prepared = state.toolHistory.length
    ? await opts.prepareContextForTools?.(pendingMessages, tools) : undefined;
  const attemptMessages = prepared?.messages ?? pendingMessages;
  const system = opts.system ?? fallbackSystem;
  const attemptOpts: CodexRuntimeOptions = {
    ...opts,
    contextWasCompacted: opts.contextWasCompacted === true || prepared?.compacted === true,
    requestMessageCount: attemptMessages.length,
    systemTokens: estimateTextTokens(system),
    toolSchemaTokens: estimateTextTokens(JSON.stringify(tools)),
    historyTokens: estimateContextTokens(attemptMessages),
    toolCount: tools.length,
  };
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
