import type { ModelMessage } from 'ai';
import type {
  CodexAgentToolSpec,
  CodexTurnStreamEvent,
} from '../../../shared/codex-agent';
import type { AgentContext } from '../context';
import type { AgentEvent, LLMMessage, RuntimeGuardRequest } from '../runtime';
import type { AgentToolSchema } from '../tool-schema';
import type { GuardDecision } from '../skills/costGuard';
import type { AgentSettings } from '../settings/agentSettings';
import { normalizeLlmMessages } from '../messages';
import { estimateTextTokens, serializeMessagesForPrompt } from '../context-compaction';
import { executeTool as executeEditorTool } from '../tools';
import { describeTimelineDelta, snapshotTimeline } from '../timelineDelta';
import { buildAgentSystemPrompt } from '../systemPrompt';
import { runCodexTurn, submitCodexToolResult } from './client';
import { isFailedToolResult, ToolFailureTracker } from '../toolFailure';

const MAX_TOOL_TURNS = 30;

type ToolStartEvent = Extract<CodexTurnStreamEvent, { type: 'tool-start' }>;

export interface CodexToolExecution {
  readonly success: boolean;
  readonly result: unknown;
  readonly followupText?: string;
}

export interface CodexRuntimeOptions {
  readonly askOnly?: boolean;
  readonly signal?: AbortSignal;
  readonly model?: string;
  readonly reasoningEffort?: string;
  readonly modelId?: string;
  readonly contextWindowTokens: number;
  readonly contextWindowEstimated: boolean;
  readonly contextWindowOverride?: boolean;
  readonly maxOutputTokens: number;
  readonly supportsImages?: boolean;
  readonly requestMessageCount?: number;
  readonly contextWasCompacted?: boolean;
  readonly system?: string;
  readonly toolFailures?: ToolFailureTracker;
  readonly tools: readonly CodexAgentToolSpec[];
  readonly executeTool: (name: string, args: Record<string, unknown>) => Promise<CodexToolExecution>;
}
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
}


interface StreamState {
  readonly done: boolean;
  readonly outputTokens: number;
  readonly toolTurns: number;
  readonly handledCallIds: ReadonlySet<string>;
  readonly toolHistory: readonly ModelMessage[];
  readonly bufferedText: string;
  readonly toolFailures: ToolFailureTracker;
}

class MaxToolTurnsError extends Error {
  readonly state: StreamState;

  constructor(state: StreamState) {
    super('Maximum tool turns reached.');
    this.state = state;
  }
}
class MaxOutputTokensError extends Error {}


class CodexFollowupPause extends Error {
  readonly text: string;

  constructor(text: string) {
    super('Codex turn paused for user follow-up.');
    this.name = 'CodexFollowupPause';
    this.text = text;
  }
}
function unresolvedFailureCompletion(
  state: StreamState,
  onEvent: (event: AgentEvent) => void,
): string | null {
  if (!state.toolFailures.hasUnresolved) return null;
  const report = state.toolFailures.report();
  state.toolFailures.clear();
  onEvent({ type: 'text-start' });
  onEvent({ type: 'text-delta', delta: report });
  return report;
}

function flushBufferedCompletion(
  state: StreamState,
  onEvent: (event: AgentEvent) => void,
): string {
  const content = state.bufferedText;
  if (!content) return content;
  onEvent({ type: 'text-start' });
  onEvent({ type: 'text-delta', delta: content });
  return content;
}



export function buildCodexSystemPrompt(ctx: AgentContext): string {
  return buildAgentSystemPrompt(ctx);
}

function toolInput(args: unknown): string {
  try {
    return JSON.stringify(args ?? null);
  } catch {
    return '[unserializable tool input]';
  }
}

function resultForHistory(result: unknown): unknown {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return result;
  const record = result as Record<string, unknown>;
  if (!Array.isArray(record.__images)) return result;
  const { __images, ...rest } = record;
  return { ...rest, __images: `[${__images.length} image payloads omitted]` };
}

function toolHistoryEntry(event: ToolStartEvent, execution: CodexToolExecution): ModelMessage {
  return {
    role: 'assistant',
    content: [
      `[tool call: ${event.name}] ${toolInput(event.args)}`,
      `[tool result: ${event.name}; success=${execution.success}] ${toolInput(resultForHistory(execution.result))}`,
    ].join('\n'),
  };
}

function failedTool(message: string): CodexToolExecution {
  return { success: false, result: { error: message } };
}
async function submitToolExecution(
  requestId: string,
  callId: string,
  execution: CodexToolExecution,
): Promise<void> {
  await submitCodexToolResult({
    requestId,
    callId,
    success: execution.success,
    result: execution.result ?? null,
  });
}

function withoutToolImages(execution: CodexToolExecution): CodexToolExecution {
  if (!execution.result || typeof execution.result !== 'object' || Array.isArray(execution.result)) return execution;
  const result = execution.result as Record<string, unknown>;
  if (!Array.isArray(result.__images)) return execution;
  const { __images: _images, ...rest } = result;
  return {
    ...execution,
    result: {
      ...rest,
      note: typeof rest.note === 'string'
        ? rest.note
        : 'Image output omitted because the selected model does not support image input.',
    },
  };
}


function isToolArgs(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
export async function executeOpenChatCutTool(
  schema: AgentToolSchema,
  args: Record<string, unknown>,
  execution: LocalToolExecutionContext,
): Promise<CodexToolExecution> {
  const { ctx, onEvent, settings, resolveGuard, onSkillGuard, onFollowup } = execution;
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
    const result = await executeEditorTool(schema.name, args, ctx);
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


async function handleToolStart(
  event: ToolStartEvent,
  state: StreamState,
  requestId: string,
  opts: CodexRuntimeOptions,
  onEvent: (event: AgentEvent) => void,
): Promise<StreamState> {
  if (state.toolTurns >= MAX_TOOL_TURNS) {
    const execution = failedTool('Maximum tool turns reached.');
    state.toolFailures.record(event.name, execution);
    const failedState: StreamState = {
      ...state,
      handledCallIds: new Set([...state.handledCallIds, event.callId]),
      toolHistory: [...state.toolHistory, toolHistoryEntry(event, execution)],
    };
    onEvent({ type: 'max-turns', turns: MAX_TOOL_TURNS });
    onEvent({ type: 'tool', name: event.name, args: event.args, result: execution.result });
    await submitToolExecution(requestId, event.callId, execution);
    throw new MaxToolTurnsError(failedState);
  }
  onEvent({ type: 'tool-input-start', name: event.name });
  onEvent({ type: 'tool-input-delta', delta: toolInput(event.args) });
  const known = opts.tools.some((tool) => tool.name === event.name);
  const execution = !known
    ? failedTool(`Unknown Codex tool: ${event.name}`)
    : !isToolArgs(event.args)
      ? failedTool(`Invalid arguments for Codex tool: ${event.name}`)
      : await opts.executeTool(event.name, event.args);
  if (!known || !isToolArgs(event.args)) {
    onEvent({ type: 'tool', name: event.name, args: event.args, result: execution.result });
  }
  state.toolFailures.record(event.name, execution);
  await submitToolExecution(
    requestId,
    event.callId,
    opts.supportsImages === false ? withoutToolImages(execution) : execution,
  );
  if (execution.followupText !== undefined) {
    throw new CodexFollowupPause(execution.followupText);
  }

  return {
    ...state,
    toolTurns: state.toolTurns + 1,
    handledCallIds: new Set([...state.handledCallIds, event.callId]),
    toolHistory: [...state.toolHistory, toolHistoryEntry(event, execution)],
  };
}

async function handleStreamEvent(
  event: CodexTurnStreamEvent,
  state: StreamState,
  requestId: string,
  opts: CodexRuntimeOptions,
  onEvent: (event: AgentEvent) => void,
): Promise<StreamState> {
  if (state.done) throw new Error('Malformed Codex stream: event received after done.');
  if (event.type === 'tool-start') return handleToolStart(event, state, requestId, opts, onEvent);
  if (event.type === 'text-delta' || event.type === 'thinking-delta') {
    const outputTokens = state.outputTokens + estimateTextTokens(event.delta);
    if (outputTokens > opts.maxOutputTokens) throw new MaxOutputTokensError();
    if (event.type === 'thinking-delta') {
      onEvent({ type: 'thinking-delta', delta: event.delta });
      return { ...state, outputTokens };
    }
    return {
      ...state,
      bufferedText: state.bufferedText + event.delta,
      outputTokens,
    };
  }
  if (event.type === 'context-usage') {
    onEvent({
      type: 'context-usage',
      usage: {
        inputTokens: event.inputTokens,
        contextWindowTokens: opts.contextWindowOverride
          ? opts.contextWindowTokens
          : event.contextWindowTokens || opts.contextWindowTokens,
        contextWindowEstimated: opts.contextWindowOverride
          ? opts.contextWindowEstimated
          : event.contextWindowTokens
            ? false
            : opts.contextWindowEstimated,
        isEstimated: false,
        modelId: opts.modelId ?? `codex:${opts.model || 'default'}`,
        compacted: opts.contextWasCompacted === true,
        messageCount: opts.requestMessageCount ?? 0,
      },
    });
  } else if (event.type === 'error') throw new Error(event.message);
  else if (event.type === 'done') return { ...state, done: true };
  else if (event.type === 'tool-end' && !state.handledCallIds.has(event.callId)) {
    const execution: CodexToolExecution = { success: event.success, result: event.result };
    state.toolFailures.record(event.name, execution);
    onEvent({ type: 'tool', name: event.name, args: event.args, result: event.result });
    return {
      ...state,
      handledCallIds: new Set([...state.handledCallIds, event.callId]),
      toolHistory: [
        ...state.toolHistory,
        toolHistoryEntry({ ...event, type: 'tool-start' }, execution),
      ],
    };
  }
  return state;
}

export async function runCodexAgent(
  messages: LLMMessage[],
  ctx: AgentContext,
  onEvent: (event: AgentEvent) => void,
  opts: CodexRuntimeOptions,
): Promise<LLMMessage[]> {
  const conv = normalizeLlmMessages(messages);
  const projectId = ctx.getProjectId?.().trim() ?? '';
  if (!opts.askOnly && !projectId) {
    onEvent({ type: 'error', message: 'Agent edits require a persisted project id.' });
    return conv;
  }
  const requestId = crypto.randomUUID();
  const turnAbort = new AbortController();
  const forwardAbort = () => turnAbort.abort(opts.signal?.reason);
  if (opts.signal?.aborted) forwardAbort();
  else opts.signal?.addEventListener('abort', forwardAbort, { once: true });
  let state: StreamState = {
    done: false,
    outputTokens: 0,
    toolTurns: 0,
    handledCallIds: new Set(),
    toolHistory: [],
    bufferedText: '',
    toolFailures: opts.toolFailures ?? new ToolFailureTracker(),
  };
  try {
    await runCodexTurn({
      requestId,
      system: opts.system ?? buildCodexSystemPrompt(ctx),
      prompt: serializeMessagesForPrompt(conv),
      projectId,
      tools: opts.askOnly ? [] : opts.tools,
      ...(opts.model?.trim() ? { model: opts.model.trim() } : {}),
      reasoningEffort: opts.reasoningEffort?.trim() || null,
      ...(opts.askOnly ? { askOnly: true } : {}),
    }, async (event) => {
      state = await handleStreamEvent(event, state, requestId, opts, onEvent);
    }, turnAbort.signal);
    if (!state.done) throw new Error('Codex stream ended before the done event.');
    const failedContent = unresolvedFailureCompletion(state, onEvent);
    const content = failedContent ?? flushBufferedCompletion(state, onEvent);
    return content
      ? [...conv, ...state.toolHistory, { role: 'assistant', content }]
      : [...conv, ...state.toolHistory];
  } catch (error) {
    turnAbort.abort(error);
    if (error instanceof CodexFollowupPause) {
      return error.text
        ? [...conv, ...state.toolHistory, { role: 'assistant', content: error.text }]
        : [...conv, ...state.toolHistory];
    }
    if (error instanceof MaxToolTurnsError) state = error.state;
    if (error instanceof MaxToolTurnsError || error instanceof MaxOutputTokensError) {
      const failedContent = unresolvedFailureCompletion(state, onEvent);
      const content = failedContent ?? flushBufferedCompletion(state, onEvent);
      return content
        ? [...conv, ...state.toolHistory, { role: 'assistant', content }]
        : [...conv, ...state.toolHistory];
    }
    if (opts.signal?.aborted) {
      const abortedWithFailure = state.toolFailures.hasUnresolved;
      state.toolFailures.clear();
      if (abortedWithFailure) return [...conv, ...state.toolHistory];
      const content = flushBufferedCompletion(state, onEvent);
      return content
        ? [...conv, ...state.toolHistory, { role: 'assistant', content }]
        : [...conv, ...state.toolHistory];
    }
    const failedContent = unresolvedFailureCompletion(state, onEvent);
    const content = failedContent ?? flushBufferedCompletion(state, onEvent);
    onEvent({ type: 'error', message: error instanceof Error ? error.message.trim() : String(error) });
    return content
      ? [...conv, ...state.toolHistory, { role: 'assistant', content }]
      : [...conv, ...state.toolHistory];
  } finally {
    opts.signal?.removeEventListener('abort', forwardAbort);
  }
}


export interface CodexSummaryRequest {
  readonly system: string;
  readonly prompt: string;
  readonly projectId: string;
  readonly model?: string;
  readonly reasoningEffort?: string;
  readonly maxOutputTokens: number;
  readonly signal?: AbortSignal;
}

export async function runCodexSummary(request: CodexSummaryRequest): Promise<string> {
  let text = '';
  let done = false;
  await runCodexTurn({
    requestId: crypto.randomUUID(),
    system: request.system,
    prompt: request.prompt,
    projectId: request.projectId,
    tools: [],
    askOnly: true,
    ...(request.model?.trim() ? { model: request.model.trim() } : {}),
    reasoningEffort: request.reasoningEffort?.trim() || null,
  }, (event) => {
    if (event.type === 'text-delta') {
      const candidate = text + event.delta;
      if (estimateTextTokens(candidate) > request.maxOutputTokens) {
        throw new Error('Codex context summary exceeded its output limit.');
      }
      text = candidate;
    }
    else if (event.type === 'error') throw new Error(event.message);
    else if (event.type === 'done') done = true;
  }, request.signal);
  if (!done) throw new Error('Codex context summary ended before completion.');
  return text.trim();
}