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
): Promise<Awaited<ReturnType<typeof prepareContext>>> {
  const prepared = await prepareContext({
    messages: [...input.messages],
    system: input.instructions,
    modelId: input.model,
    contextWindowTokens: input.contextWindowTokens,
    contextWindowEstimated: input.contextWindowEstimated,
    maxInputTokens: input.maxInputTokens,
    maxOutputTokens: input.maxOutputTokens,
    requestOverheadTokens: estimateTextTokens(JSON.stringify(input.schemas)),
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
  /** Overridable for verification; defaults to the real server Copilot runner. */
  readonly runTurn?: (
    request: CopilotTurnRequest,
    emit: (event: CopilotTurnStreamEvent) => void,
    signal: AbortSignal,
  ) => Promise<void>;
}

/**
 * Run one Agent turn through the server-side Copilot executor. Structurally
 * identical to `executeServerCodexTurn`: Copilot owns its tool loop until
 * `done`, tool-start events are bridged into the browser tool claim/result
 * path, and results are settled back into the same turn. The outer API-style
 * turn loop must therefore not replay a completed Copilot turn.
 */
export async function executeServerCopilotTurn(
  input: ServerCopilotTurnInput,
  deps: ServerCopilotTurnDeps = {},
): Promise<{
  messages: ModelMessage[];
  text: string;
  continued: boolean;
  followupText: string | null;
  hitMaxTokens: boolean;
}> {
  const prepared = await prepareCopilotContext(input);
  const activeSchemas = input.activation.current.schemas();
  const schemas = input.activation.current.allSchemas();
  const requestId = `run-${input.run.id}-${input.requestIndex}`;
  pushRunEvent(input.run, 'text-start', {});
  let text = '';
  let pending = '';
  let pendingThinking = '';
  let done = false;
  let errorMessage: string | null = null;
  const toolHistory: ModelMessage[] = [];

  const settle = (callId: string, success: boolean, result: unknown): void => {
    settleToolResult({ requestId, callId, success, result: result ?? null });
  };

  const bridgeToolCall = (event: Extract<CopilotTurnStreamEvent, { type: 'tool-start' }>): void => {
    void (async () => {
      try {
        const schema = schemas.find((candidate) => candidate.name === event.name);
        if (!schema) {
          const failure = { error: `Unknown tool: ${event.name}` };
          input.activation.toolFailures.record(event.name, { success: false, result: failure });
          toolHistory.push(codexToolHistoryEntry(
            { name: event.name, args: event.args },
            { success: false, result: failure },
          ));
          settle(event.callId, false, failure);
          return;
        }
        const delivered = await executeBrowserTool(
          input.run,
          schema,
          (event.args ?? {}) as Record<string, unknown>,
          event.callId,
          input.activation,
        );
        const success = !isFailedToolResult(delivered);
        toolHistory.push(codexToolHistoryEntry(
          { name: event.name, args: event.args },
          { success, result: delivered },
        ));
        settle(event.callId, success, delivered ?? null);
      } catch (error) {
        const message = toolFailureReason(error);
        toolHistory.push(codexToolHistoryEntry(
          { name: event.name, args: event.args },
          { success: false, result: { error: message } },
        ));
        settle(event.callId, false, { error: message });
      }
    })();
  };

  const emit = (event: CopilotTurnStreamEvent): void => {
    switch (event.type) {
      case 'text-delta':
        text += event.delta;
        pending = flushTextEvents(input.run, pending + event.delta, false);
        break;
      case 'thinking-delta':
        pendingThinking = flushThinkingEvents(input.run, pendingThinking + event.delta, false);
        break;
      case 'tool-start':
        bridgeToolCall(event);
        break;
      case 'context-usage':
        recordServerContextUsage(
          input.run,
          usageFromCopilotEvent(event, prepared, input.requestIndex),
          activeSchemas.length,
          JSON.stringify(activeSchemas).length,
        );
        break;
      case 'error':
        errorMessage = event.message;
        break;
      case 'done':
        done = true;
        break;
      default:
        break;
    }
  };

  let turnError: unknown = null;
  const runTurn = deps.runTurn ?? runServerCopilotTurn;
  try {
    // No wall-clock cap here: the turn manager owns an idle timeout, which is
    // the correct signal. A long multi-shot edit streams continuously and must
    // not be killed for total elapsed time (it was, before this).
    await runTurn(
      {
        requestId,
        system: input.instructions,
        prompt: serializeMessagesForPrompt([...prepared.messages]),
        projectId: input.projectId,
        askOnly: input.askOnly,
        ...(input.model ? { model: input.model } : {}),
        ...(input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : {}),
        tools: copilotToolSpecs(schemas),
      },
      emit,
      input.signal,
    );
  } catch (error) {
    turnError = error;
  }
  flushTextEvents(input.run, pending, true);
  flushThinkingEvents(input.run, pendingThinking, true);
  pushRunEvent(input.run, 'text-end', serverRunTextMetadata(text));
  if (turnError) throw turnError;
  if (errorMessage) throw new Error(errorMessage);
  if (!done) throw new Error('Copilot turn ended without a terminal event.');
  const messages: ModelMessage[] = [
    ...prepared.messages,
    ...(text ? [{ role: 'assistant', content: text } as ModelMessage] : []),
    ...toolHistory,
  ];
  return {
    messages,
    text,
    continued: false,
    followupText: input.activation.followupText,
    hitMaxTokens: false,
  };
}
