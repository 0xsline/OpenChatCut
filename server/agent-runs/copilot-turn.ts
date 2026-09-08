import type { ModelMessage } from 'ai';
import { runServerCopilotTurn } from '../plugins/copilot-agent';
import { settleToolResult } from '../copilot/turn-manager';
import type { CopilotTurnRequest, CopilotTurnStreamEvent } from '../../shared/copilot-agent';
import {
  estimateTextTokens,
  prepareContext,
  serializeMessagesForPrompt,
} from '../../src/agent/context-compaction';
import { summarizeConversation } from '../../src/agent/context-summary';
import type { AgentToolSchema } from '../../src/agent/tool-schema';
import { codexToolHistoryEntry } from '../../src/agent/codex/tool-history';
import { isFailedToolResult, toolFailureReason } from '../../src/agent/toolFailure';
import type { AgentContextUsage } from '../../src/agent/context-compaction';
import {
  persistServerCheckpoint,
  pushRunEvent,
  recordServerContextUsage,
  type ServerRun,
} from './store';
import {
  executeBrowserTool,
  flushTextEvents,
  flushThinkingEvents,
  serverRunTextMetadata,
  type ActivationState,
} from './executor';

export interface ServerCopilotTurnInput {
  readonly run: ServerRun;
  readonly messages: readonly ModelMessage[];
  readonly instructions: string;
  readonly schemas: readonly AgentToolSchema[];
  readonly model: string;
  readonly reasoningEffort?: string | null;
  readonly askOnly: boolean;
  readonly projectId: string;
  readonly maxInputTokens: number;
  readonly maxOutputTokens: number;
  readonly contextWindowTokens: number;
  readonly contextWindowEstimated: boolean;
  readonly signal: AbortSignal;
  readonly activation: ActivationState;
  readonly requestIndex: number;
}

function copilotToolSpecs(schemas: readonly AgentToolSchema[]): CopilotTurnRequest['tools'] {
  return schemas.map((schema) => ({
    name: schema.name,
    ...(schema.description === undefined ? {} : { description: schema.description }),
    inputSchema: schema.input_schema,
  }));
}

function usageFromCopilotEvent(
  event: Extract<CopilotTurnStreamEvent, { type: 'context-usage' }>,
  prepared: { usage: AgentContextUsage },
  requestIndex: number,
): AgentContextUsage {
  return {
    ...prepared.usage,
    inputTokens: event.inputTokens,
    outputTokens: event.outputTokens,
    reasoningTokens: event.reasoningTokens,
    noCacheInputTokens: event.noCacheInputTokens,
    cacheReadTokens: event.cacheReadTokens,
    requestIndex,
    attemptIndex: 0,
    isEstimated: event.inputTokens === undefined || event.outputTokens === undefined,
  };
}

/** One Copilot turn used as the context-summary model call. */
async function summarizeWithCopilot(
  input: ServerCopilotTurnInput,
  prompt: string,
  maxOutputTokens: number,
  systemPrompt: string,
): Promise<string> {
  const requestId = `summary-${input.run.id}-${input.requestIndex}-${crypto.randomUUID().slice(0, 8)}`;
  let text = '';
  await runServerCopilotTurn(
    {
      requestId,
      system: systemPrompt,
      prompt,
      projectId: input.projectId,
      ...(input.model ? { model: input.model } : {}),
      askOnly: true,
      tools: [],
    },
    (event) => {
      if (event.type === 'text-delta') text += event.delta;
    },
    input.signal,
  );
  if (!text.trim()) throw new Error('Copilot context summary returned no text.');
  return text.slice(0, maxOutputTokens * 4);
}

async function prepareCopilotContext(
  input: ServerCopilotTurnInput,
  tools: CopilotTurnRequest['tools'],
  prepare: typeof prepareContext = prepareContext,
): Promise<Awaited<ReturnType<typeof prepareContext>>> {
  const prepared = await prepare({
    messages: [...input.messages],
    system: input.instructions,
    modelId: input.model,
    contextWindowTokens: input.contextWindowTokens,
    contextWindowEstimated: input.contextWindowEstimated,
    maxInputTokens: input.maxInputTokens,
    maxOutputTokens: input.maxOutputTokens,
    requestOverheadTokens: estimateTextTokens(JSON.stringify(tools)),
    summarize: (messages) => summarizeConversation(
      messages,
      input.contextWindowTokens,
      input.maxInputTokens,
      input.maxOutputTokens,
      (prompt: string, maxOutputTokens: number, systemPrompt?: string) => {
        if (!systemPrompt) throw new Error('Context summary system prompt is unavailable.');
        return summarizeWithCopilot(input, prompt, maxOutputTokens, systemPrompt);
      },
    ),
  });
  if (prepared.checkpoint) {
    await persistServerCheckpoint(input.run, prepared.checkpoint);
  }
  return prepared;
}

export interface ServerCopilotTurnDeps {
  readonly prepareContext?: typeof prepareContext;
  /** Overridable for verification; defaults to the real server Copilot runner. */
  readonly runTurn?: (
    request: CopilotTurnRequest,
    emit: (event: CopilotTurnStreamEvent) => void,
    signal: AbortSignal,
  ) => Promise<void>;
}

interface CopilotTurnState {
  text: string;
  pending: string;
  pendingThinking: string;
  done: boolean;
  errorMessage: string | null;
  readonly toolHistory: ModelMessage[];
}

async function bridgeCopilotTool(
  input: ServerCopilotTurnInput,
  schemas: readonly AgentToolSchema[],
  state: CopilotTurnState,
  requestId: string,
  event: Extract<CopilotTurnStreamEvent, { type: 'tool-start' }>,
): Promise<void> {
  let success = false;
  let result: unknown;
  try {
    const schema = schemas.find((candidate) => candidate.name === event.name);
    if (!schema) {
      result = { error: `Unknown tool: ${event.name}` };
      input.activation.toolFailures.record(event.name, { success, result });
    } else {
      result = await executeBrowserTool(input.run, schema,
        (event.args ?? {}) as Record<string, unknown>, event.callId, input.activation);
      success = !isFailedToolResult(result);
    }
  } catch (error) {
    result = { error: toolFailureReason(error) };
  }
  state.toolHistory.push(codexToolHistoryEntry(
    { name: event.name, args: event.args }, { success, result },
  ));
  settleToolResult({ requestId, callId: event.callId, success, result: result ?? null });
}

function copilotEventReceiver(
  input: ServerCopilotTurnInput,
  prepared: { usage: AgentContextUsage },
  state: CopilotTurnState,
  requestId: string,
  schemas: readonly AgentToolSchema[],
  tools: CopilotTurnRequest['tools'],
): (event: CopilotTurnStreamEvent) => void {
  return (event) => {
    switch (event.type) {
      case 'text-delta':
        state.text += event.delta;
        state.pending = flushTextEvents(input.run, state.pending + event.delta, false);
        break;
      case 'thinking-delta':
        state.pendingThinking = flushThinkingEvents(input.run, state.pendingThinking + event.delta, false);
        break;
      case 'tool-start':
        void bridgeCopilotTool(input, schemas, state, requestId, event);
        break;
      case 'context-usage':
        recordServerContextUsage(input.run, usageFromCopilotEvent(event, prepared, input.requestIndex),
          tools.length, JSON.stringify(tools).length);
        break;
      case 'error': state.errorMessage = event.message; break;
      case 'done': state.done = true; break;
      default: break;
    }
  };
}

function copilotRunRequest(
  input: ServerCopilotTurnInput,
  messages: readonly ModelMessage[],
  requestId: string,
  tools: CopilotTurnRequest['tools'],
): CopilotTurnRequest {
  return {
    requestId, system: input.instructions, prompt: serializeMessagesForPrompt([...messages]),
    projectId: input.projectId, askOnly: input.askOnly,
    ...(input.model ? { model: input.model } : {}),
    ...(input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : {}),
    tools,
  };
}

/** Copilot owns its tool loop; the outer executor must not replay this turn. */
export async function executeServerCopilotTurn(
  input: ServerCopilotTurnInput,
  deps: ServerCopilotTurnDeps = {},
): Promise<{
  messages: ModelMessage[]; text: string; continued: boolean;
  followupText: string | null; hitMaxTokens: boolean;
}> {
  const schemas = input.activation.current.allSchemas();
  const tools = copilotToolSpecs(schemas);
  const prepared = await prepareCopilotContext(input, tools, deps.prepareContext);
  const requestId = `run-${input.run.id}-${input.requestIndex}`;
  const state: CopilotTurnState = {
    text: '', pending: '', pendingThinking: '', done: false, errorMessage: null, toolHistory: [],
  };
  pushRunEvent(input.run, 'text-start', {});
  try {
    await (deps.runTurn ?? runServerCopilotTurn)(
      copilotRunRequest(input, prepared.messages, requestId, tools),
      copilotEventReceiver(input, prepared, state, requestId, schemas, tools), input.signal,
    );
  } finally {
    flushTextEvents(input.run, state.pending, true);
    flushThinkingEvents(input.run, state.pendingThinking, true);
    pushRunEvent(input.run, 'text-end', serverRunTextMetadata(state.text));
  }
  if (state.errorMessage) throw new Error(state.errorMessage);
  if (!state.done) throw new Error('Copilot turn ended without a terminal event.');
  return {
    messages: [...prepared.messages,
      ...(state.text ? [{ role: 'assistant', content: state.text } as ModelMessage] : []),
      ...state.toolHistory],
    text: state.text, continued: false, followupText: input.activation.followupText, hitMaxTokens: false,
  };
}
