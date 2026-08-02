import type { ModelMessage } from 'ai';
import type {
  CodexAgentToolSpec,
  CodexTurnStreamEvent,
} from '../../../shared/codex-agent';
import type { AgentContext } from '../context';
import type { AgentEvent, LLMMessage, RuntimeGuardRequest } from '../runtime';
import type { AgentToolSchema } from '../tool-schema';
import type { GuardDecision } from '../skills/skillGuard';
import type { AgentSettings } from '../settings/agentSettings';
import { getLocale } from '../../i18n/locale';
import { capabilitiesPrompt } from '../capabilities';
import { normalizeLlmMessages } from '../messages';
import { findSkill } from '../skills/skills-catalog';
import { PLUGIN_SKILLS_INDEX } from '../skills/plugin-skills';
import { agentSettingsPrompt, loadAgentSettings } from '../settings/agentSettings';
import { executeTool as executeEditorTool } from '../tools';
import { describeTimelineDelta, snapshotTimeline } from '../timelineDelta';
import {
  SYSTEM_PROMPT,
  agentLanguagePrompt,
  assembleSystemPrompt,
  creativeModePrompt,
  designStylePrompt,
  editorStatePrompt,
} from '../systemPrompt';
import { runCodexTurn, submitCodexToolResult } from './client';

const MAX_TRANSCRIPT_CHARS = 120_000;
const MAX_MESSAGE_CHARS = 32_000;
const MAX_TOOL_TURNS = 30;

type MessagePart = { readonly type?: unknown; readonly text?: unknown; readonly toolName?: unknown };
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
  readonly text: string;
  readonly textStarted: boolean;
  readonly done: boolean;
  readonly toolTurns: number;
  readonly handledCallIds: ReadonlySet<string>;
}

class MaxToolTurnsError extends Error {}

class CodexFollowupPause extends Error {
  readonly text: string;

  constructor(text: string) {
    super('Codex turn paused for user follow-up.');
    this.name = 'CodexFollowupPause';
    this.text = text;
  }
}

function truncateMiddle(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const marker = '\n[… earlier content omitted …]\n';
  const remaining = Math.max(0, limit - marker.length);
  const head = Math.ceil(remaining / 2);
  return `${text.slice(0, head)}${marker}${text.slice(text.length - (remaining - head))}`;
}

function messageContentText(message: ModelMessage): string {
  if (typeof message.content === 'string') return message.content;
  if (!Array.isArray(message.content)) return '';
  return (message.content as readonly MessagePart[]).flatMap((part): string[] => {
    if (typeof part.text === 'string') return [part.text];
    const name = typeof part.toolName === 'string' ? part.toolName : 'unknown';
    if (part.type === 'tool-call') return [`[tool call: ${name}]`];
    if (part.type === 'tool-result') return [`[tool result: ${name}]`];
    return [];
  }).join('\n');
}

function transcriptEntry(message: ModelMessage): string {
  const content = truncateMiddle(messageContentText(message).trim(), MAX_MESSAGE_CHARS);
  return `${message.role.toUpperCase()}:\n${content || '[no text content]'}`;
}

function serializeTranscript(messages: readonly ModelMessage[]): string {
  const entries = messages.map(transcriptEntry);
  const selected: string[] = [];
  let remaining = MAX_TRANSCRIPT_CHARS;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const separator = selected.length ? 2 : 0;
    if (entries[index].length + separator > remaining) break;
    selected.unshift(entries[index]);
    remaining -= entries[index].length + separator;
  }
  return selected.join('\n\n');
}

function buildSystemPrompt(ctx: AgentContext): string {
  const settings = loadAgentSettings();
  return assembleSystemPrompt([
    SYSTEM_PROMPT,
    agentLanguagePrompt(getLocale()),
    capabilitiesPrompt(),
    PLUGIN_SKILLS_INDEX,
    agentSettingsPrompt(settings),
    designStylePrompt(ctx.getDoc().designStyle),
    creativeModePrompt(findSkill(ctx.getCreativeMode())),
  ], editorStatePrompt(ctx));
}

function toolInput(args: unknown): string {
  try {
    return JSON.stringify(args ?? null);
  } catch {
    return '[unserializable tool input]';
  }
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
    const guard = settings.skillGuard ? await resolveGuard(schema.name, args, ctx) : null;
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
    const followup = (result as { __followup?: unknown } | null)?.__followup;
    if (typeof followup === 'string') {
      onEvent({ type: 'text-start' });
      onEvent({ type: 'text-delta', delta: followup });
      onFollowup?.();
      return { success: true, result: enriched, followupText: followup };
    }
    return { success: true, result: enriched };
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
    onEvent({ type: 'max-turns', turns: MAX_TOOL_TURNS });
    await submitToolExecution(requestId, event.callId, failedTool('Maximum tool turns reached.'));
    throw new MaxToolTurnsError();
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
  await submitToolExecution(requestId, event.callId, execution);
  if (execution.followupText !== undefined) {
    throw new CodexFollowupPause(execution.followupText);
  }
  return {
    ...state,
    toolTurns: state.toolTurns + 1,
    handledCallIds: new Set([...state.handledCallIds, event.callId]),
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
  if (event.type === 'text-delta') {
    if (!state.textStarted) onEvent({ type: 'text-start' });
    onEvent({ type: 'text-delta', delta: event.delta });
    return { ...state, textStarted: true, text: state.text + event.delta };
  }
  if (event.type === 'thinking-delta') onEvent({ type: 'thinking-delta', delta: event.delta });
  else if (event.type === 'error') throw new Error(event.message);
  else if (event.type === 'done') return { ...state, done: true };
  else if (!event.success && !state.handledCallIds.has(event.callId)) {
    onEvent({ type: 'tool', name: event.name, args: event.args, result: event.result });
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
  let state: StreamState = { text: '', textStarted: false, done: false, toolTurns: 0, handledCallIds: new Set() };
  try {
    await runCodexTurn({
      requestId,
      system: buildSystemPrompt(ctx),
      prompt: serializeTranscript(conv),
      projectId,
      tools: opts.askOnly ? [] : opts.tools,
      ...(opts.model?.trim() ? { model: opts.model.trim() } : {}),
      ...(opts.reasoningEffort?.trim() ? { reasoningEffort: opts.reasoningEffort.trim() } : {}),
      ...(opts.askOnly ? { askOnly: true } : {}),
    }, async (event) => {
      state = await handleStreamEvent(event, state, requestId, opts, onEvent);
    }, turnAbort.signal);
    if (!state.done) throw new Error('Codex stream ended before the done event.');
    return [...conv, { role: 'assistant', content: state.text }];
  } catch (error) {
    turnAbort.abort(error);
    if (error instanceof CodexFollowupPause) {
      const content = [state.text, error.text].filter(Boolean).join('\n\n');
      return content ? [...conv, { role: 'assistant', content }] : conv;
    }
    if (error instanceof MaxToolTurnsError) {
      return state.text ? [...conv, { role: 'assistant', content: state.text }] : conv;
    }
    if (opts.signal?.aborted) return state.text ? [...conv, { role: 'assistant', content: state.text }] : conv;
    onEvent({ type: 'error', message: error instanceof Error ? error.message.trim() : String(error) });
    return conv;
  } finally {
    opts.signal?.removeEventListener('abort', forwardAbort);
  }
}
