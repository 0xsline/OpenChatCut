import type { ModelMessage } from 'ai';
import type {
  CodexAgentToolSpec,
  CodexTurnStreamEvent,
} from '../../../shared/codex-agent';
import type { AgentEvent } from '../runtime';
import type { AgentContextUsage } from '../context-compaction';
import { estimateTextTokens } from '../context-compaction';
import {
  harnessContextForModelRound,
  type HarnessToolExecutionContext,
} from '../harness-context';
import { describeImageWithVision } from '../vision';
import { getActiveAgentModelChoice } from '../model-selection';
import { resolveVisionModel } from '../visionConfig';
import { submitCodexToolResult } from './client';
import { ToolFailureTracker } from '../toolFailure';
import { compactToolResultForTransport } from '../tool-result-compaction';
import { agentArtifactRefOf, attachAgentArtifactRef } from '../runtime-artifact';
import { codexToolHistoryEntry, codexToolInput } from './tool-history';

const MAX_TOOL_TURNS = 30;
type ToolStartEvent = Extract<CodexTurnStreamEvent, { type: 'tool-start' }>;
type ToolEndEvent = Extract<CodexTurnStreamEvent, { type: 'tool-end' }>;
type OutputDeltaEvent = Extract<CodexTurnStreamEvent, { type: 'text-delta' | 'thinking-delta' }>;
type ContextUsageEvent = Extract<CodexTurnStreamEvent, { type: 'context-usage' }>;

export interface CodexToolExecution {
  readonly success: boolean;
  readonly result: unknown;
  readonly followupText?: string;
  readonly refreshTools?: boolean;
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
  readonly maxInputTokens?: number;
  readonly supportsImages?: boolean;
  readonly requestMessageCount?: number;
  readonly contextWasCompacted?: boolean;
  readonly system?: string;
  readonly toolFailures?: ToolFailureTracker;
  readonly systemTokens?: number;
  readonly toolSchemaTokens?: number;
  readonly historyTokens?: number;
  readonly toolCount?: number;
  readonly requestMessages?: readonly ModelMessage[];
  readonly requestTools?: readonly CodexAgentToolSpec[];
  readonly tools: readonly CodexAgentToolSpec[];
  readonly resolveTools?: () => readonly CodexAgentToolSpec[];
  readonly prepareContextForTools?: (
    messages: readonly ModelMessage[],
    tools: readonly CodexAgentToolSpec[],
  ) => Promise<{ readonly messages: ModelMessage[]; readonly compacted: boolean }>;
  readonly onContextUsage?: (
    usage: AgentContextUsage,
    tools: readonly CodexAgentToolSpec[],
  ) => Promise<void>;
  readonly executeTool: (
    name: string,
    args: Record<string, unknown>,
    toolCallId?: string,
    signal?: AbortSignal,
    harness?: HarnessToolExecutionContext,
  ) => Promise<CodexToolExecution>;
}

export interface StreamState {
  readonly done: boolean;
  readonly outputTokens: number;
  readonly toolTurns: number;
  readonly handledCallIds: ReadonlySet<string>;
  readonly toolHistory: readonly ModelMessage[];
  readonly baseMessages?: readonly ModelMessage[];
  readonly bufferedText: string;
  readonly toolFailures: ToolFailureTracker;
}

export class MaxToolTurnsError extends Error {
  readonly state: StreamState;

  constructor(state: StreamState) {
    super('Maximum tool turns reached.');
    this.state = state;
  }
}
export class MaxOutputTokensError extends Error {}
export class CodexToolRefresh extends Error {
  readonly state: StreamState;

  constructor(state: StreamState) {
    super('Codex tools changed; restarting the turn with the expanded schema set.');
    this.state = state;
  }
}
export class CodexFollowupPause extends Error {
  readonly text: string;
  readonly state: StreamState;

  constructor(text: string, state: StreamState) {
    super('Codex turn paused for user follow-up.');
    this.name = 'CodexFollowupPause';
    this.text = text;
    this.state = state;
  }
}

export function currentCodexTools(opts: CodexRuntimeOptions): readonly CodexAgentToolSpec[] {
  return opts.requestTools ?? opts.resolveTools?.() ?? opts.tools;
}

export function unresolvedFailureCompletion(
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

export function flushBufferedCompletion(
  state: StreamState,
  onEvent: (event: AgentEvent) => void,
): string {
  const content = state.bufferedText;
  if (!content) return content;
  onEvent({ type: 'text-start' });
  onEvent({ type: 'text-delta', delta: content });
  return content;
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

function preservingArtifactRef(source: unknown, projected: Record<string, unknown>): Record<string, unknown> {
  const ref = agentArtifactRefOf(source);
  return ref ? attachAgentArtifactRef(projected, ref) : projected;
}

function withoutToolImages(execution: CodexToolExecution): CodexToolExecution {
  if (!execution.result || typeof execution.result !== 'object' || Array.isArray(execution.result)) return execution;
  const result = execution.result as Record<string, unknown>;
  if (!Array.isArray(result.__images)) return execution;
  const { __images: _images, ...rest } = result;
  return {
    ...execution,
    result: preservingArtifactRef(result, {
      ...rest,
      note: typeof rest.note === 'string'
        ? rest.note
        : 'Image output omitted because the selected model does not support image input.',
    }),
  };
}

async function describeToolImages(execution: CodexToolExecution): Promise<CodexToolExecution> {
  const result = execution.result as Record<string, unknown> | null;
  if (!result || Array.isArray(result)) return withoutToolImages(execution);
  const images = result.__images;
  if (!Array.isArray(images) || !images.length) return withoutToolImages(execution);
  const first = images[0] as { base64?: unknown } | null;
  if (typeof first?.base64 !== 'string') return withoutToolImages(execution);
  const vision = resolveVisionModel(getActiveAgentModelChoice());
  if (!vision) return withoutToolImages(execution);
  const description = await describeImageWithVision(
    vision,
    { base64: first.base64, mediaType: 'image/jpeg' },
    'timeline-frames',
  ).catch(() => null);
  if (!description) return withoutToolImages(execution);
  const { __images, ...rest } = result;
  return {
    ...execution,
    result: preservingArtifactRef(result, { ...rest, visualSummary: description }),
  };
}

function isToolArgs(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function requestHarnessContext(opts: CodexRuntimeOptions): HarnessToolExecutionContext | undefined {
  if (!opts.requestMessages) return undefined;
  const maxInputTokens = opts.maxInputTokens
    ?? Math.max(1, opts.contextWindowTokens - opts.maxOutputTokens);
  return harnessContextForModelRound({
    messages: opts.requestMessages,
    system: opts.system ?? '',
    toolSchemas: currentCodexTools(opts),
    contextWindowTokens: opts.contextWindowTokens,
    maxInputTokens,
    maxOutputTokens: opts.maxOutputTokens,
  });
}

async function stopAtToolLimit(
  event: ToolStartEvent,
  state: StreamState,
  requestId: string,
  onEvent: (event: AgentEvent) => void,
): Promise<never> {
  const execution = failedTool('Maximum tool turns reached.');
  state.toolFailures.record(event.name, execution);
  const failedState = {
    ...state,
    handledCallIds: new Set([...state.handledCallIds, event.callId]),
    toolHistory: [...state.toolHistory, codexToolHistoryEntry(event, execution)],
  };
  onEvent({ type: 'max-turns', turns: MAX_TOOL_TURNS });
  onEvent({ type: 'tool', name: event.name, args: event.args, result: execution.result });
  await submitToolExecution(requestId, event.callId, execution);
  throw new MaxToolTurnsError(failedState);
}

async function executeStreamTool(
  event: ToolStartEvent,
  state: StreamState,
  requestId: string,
  opts: CodexRuntimeOptions,
  onEvent: (event: AgentEvent) => void,
): Promise<StreamState> {
  const known = currentCodexTools(opts).some((tool) => tool.name === event.name);
  const validArgs = isToolArgs(event.args);
  const execution = !known
    ? failedTool(`Unknown Codex tool: ${event.name}`)
    : !validArgs
      ? failedTool(`Invalid arguments for Codex tool: ${event.name}`)
      : await opts.executeTool(
        event.name, event.args, event.callId, opts.signal, requestHarnessContext(opts),
      );
  if (!known || !validArgs) {
    onEvent({ type: 'tool', name: event.name, args: event.args, result: execution.result });
  }
  state.toolFailures.record(event.name, execution);
  const preparedForModel = opts.supportsImages === false
    ? await describeToolImages(execution)
    : execution;
  const submitted = {
    ...preparedForModel,
    result: event.name === 'load_skill'
      ? preparedForModel.result
      : compactToolResultForTransport(preparedForModel.result, opts.supportsImages === true),
  };
  await submitToolExecution(requestId, event.callId, submitted);
  const nextState = {
    ...state,
    toolTurns: state.toolTurns + 1,
    handledCallIds: new Set([...state.handledCallIds, event.callId]),
    toolHistory: [...state.toolHistory, codexToolHistoryEntry(event, submitted)],
  };
  if (execution.followupText !== undefined) {
    throw new CodexFollowupPause(execution.followupText, nextState);
  }
  if (execution.refreshTools) throw new CodexToolRefresh(nextState);
  return nextState;
}

async function handleToolStart(
  event: ToolStartEvent,
  state: StreamState,
  requestId: string,
  opts: CodexRuntimeOptions,
  onEvent: (event: AgentEvent) => void,
): Promise<StreamState> {
  if (state.toolTurns >= MAX_TOOL_TURNS) {
    return stopAtToolLimit(event, state, requestId, onEvent);
  }
  onEvent({ type: 'tool-input-start', name: event.name });
  onEvent({ type: 'tool-input-delta', delta: codexToolInput(event.args) });
  return executeStreamTool(event, state, requestId, opts, onEvent);
}

function handleOutputDelta(
  event: OutputDeltaEvent,
  state: StreamState,
  opts: CodexRuntimeOptions,
  onEvent: (event: AgentEvent) => void,
): StreamState {
  const outputTokens = state.outputTokens + estimateTextTokens(event.delta);
  if (outputTokens > opts.maxOutputTokens) throw new MaxOutputTokensError();
  if (event.type === 'thinking-delta') {
    onEvent({ type: 'thinking-delta', delta: event.delta });
    return { ...state, outputTokens };
  }
  return { ...state, bufferedText: state.bufferedText + event.delta, outputTokens };
}

function contextUsage(event: ContextUsageEvent, opts: CodexRuntimeOptions): AgentContextUsage {
  const providerWindow = event.contextWindowTokens || opts.contextWindowTokens;
  return {
    inputTokens: event.inputTokens,
    contextWindowTokens: opts.contextWindowOverride ? opts.contextWindowTokens : providerWindow,
    contextWindowEstimated: opts.contextWindowOverride
      ? opts.contextWindowEstimated
      : !event.contextWindowTokens,
    isEstimated: false,
    modelId: opts.modelId ?? `codex:${opts.model || 'default'}`,
    compacted: opts.contextWasCompacted === true,
    messageCount: opts.requestMessageCount ?? 0,
    systemTokens: opts.systemTokens,
    toolSchemaTokens: opts.toolSchemaTokens,
    historyTokens: opts.historyTokens,
    toolCount: opts.toolCount,
    outputTokens: event.outputTokens,
    reasoningTokens: event.reasoningTokens,
    noCacheInputTokens: event.noCacheInputTokens,
    cacheReadTokens: event.cacheReadTokens,
  };
}

function handleUnhandledToolEnd(
  event: ToolEndEvent,
  state: StreamState,
  onEvent: (event: AgentEvent) => void,
): StreamState {
  const execution = { success: event.success, result: event.result };
  state.toolFailures.record(event.name, execution);
  onEvent({ type: 'tool', name: event.name, args: event.args, result: event.result });
  return {
    ...state,
    handledCallIds: new Set([...state.handledCallIds, event.callId]),
    toolHistory: [...state.toolHistory, codexToolHistoryEntry(event, execution)],
  };
}

export async function handleCodexStreamEvent(
  event: CodexTurnStreamEvent,
  state: StreamState,
  requestId: string,
  opts: CodexRuntimeOptions,
  onEvent: (event: AgentEvent) => void,
): Promise<StreamState> {
  if (state.done) throw new Error('Malformed Codex stream: event received after done.');
  if (event.type === 'tool-start') return handleToolStart(event, state, requestId, opts, onEvent);
  if (event.type === 'text-delta' || event.type === 'thinking-delta') {
    return handleOutputDelta(event, state, opts, onEvent);
  }
  if (event.type === 'context-usage') {
    const usage = contextUsage(event, opts);
    onEvent({ type: 'context-usage', usage });
    await opts.onContextUsage?.(usage, currentCodexTools(opts));
  } else if (event.type === 'error') {
    throw new Error(event.message);
  } else if (event.type === 'done') {
    return { ...state, done: true };
  } else if (event.type === 'tool-end' && !state.handledCallIds.has(event.callId)) {
    return handleUnhandledToolEnd(event, state, onEvent);
  }
  return state;
}
