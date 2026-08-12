import type { ModelMessage } from 'ai';
import { codexTurnManager } from '../codex/turn-manager';
import { runServerCodexTurn } from '../plugins/codex-agent';
import type { CodexTurnRequest, CodexTurnStreamEvent } from '../../shared/codex-agent';
import {
  estimateTextTokens,
  prepareContext,
  serializeMessagesForPrompt,
} from '../../src/agent/context-compaction';
import { summarizeConversation } from '../../src/agent/context-summary';
import type { AgentToolSchema } from '../../src/agent/tool-schema';
import { codexToolHistoryEntry } from '../../src/agent/codex/tool-history';
import type { AgentContextUsage } from '../../src/agent/context-compaction';
import {
  persistServerCheckpoint,
  pushRunEvent,
  recordServerContextUsage,
  type ServerRun,
} from './store';
import { executeBrowserTool, flushTextEvents, serverRunTextMetadata, type ActivationState } from './executor';

const CODEX_TURN_TIMEOUT_MS = 600_000;

export interface ServerCodexTurnInput {
  readonly run: ServerRun;
  readonly messages: readonly ModelMessage[];
  readonly instructions: string;
  readonly schemas: readonly AgentToolSchema[];
  readonly model: string;
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

function codexToolSpecs(schemas: readonly AgentToolSchema[]): CodexTurnRequest['tools'] {
  return schemas.map((schema) => ({
    name: schema.name,
    description: schema.description,
    inputSchema: schema.input_schema,
  }));
}

function usageFromCodexEvent(
  event: Extract<CodexTurnStreamEvent, { type: 'context-usage' }>,
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

/** One Codex turn used as the context-summary model call. */
async function summarizeWithCodex(
  input: ServerCodexTurnInput,
  prompt: string,
  maxOutputTokens: number,
  systemPrompt: string,
): Promise<string> {
  const requestId = `summary-${input.run.id}-${input.requestIndex}-${crypto.randomUUID().slice(0, 8)}`;
  let text = '';
  await runServerCodexTurn(
    {
      requestId,
      system: systemPrompt,
      prompt,
      projectId: input.projectId,
      askOnly: true,
      tools: [],
    },
    (event) => {
      if (event.type === 'text-delta') text += event.delta;
    },
    input.signal,
  );
  if (!text.trim()) throw new Error('Codex context summary returned no text.');
  return text.slice(0, maxOutputTokens * 4);
}

async function prepareCodexContext(
  input: ServerCodexTurnInput,
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
        return summarizeWithCodex(input, prompt, maxOutputTokens, systemPrompt);
      },
    ),
  });
  if (prepared.checkpoint) {
    await persistServerCheckpoint(input.run, prepared.checkpoint);
  }
  return prepared;
}

export interface ServerCodexTurnDeps {
  /** Overridable for verification; defaults to the real server Codex runner. */
  readonly runTurn?: (
    request: CodexTurnRequest,
    emit: (event: CodexTurnStreamEvent) => void,
    signal: AbortSignal,
  ) => Promise<void>;
}

/**
 * Run one Agent turn through the server-side Codex executor. The Codex turn
 * manager streams events; text is flushed into run events, tool-start events
 * are bridged into the browser tool claim/result path (same as the AI SDK
 * path), and tool results are settled back into the Codex turn. Messages are
 * rebuilt as assistant text + merged tool history so the next turn can be
 * replayed to Codex as a prompt.
 */
export async function executeServerCodexTurn(
  input: ServerCodexTurnInput,
  deps: ServerCodexTurnDeps = {},
): Promise<{
  messages: ModelMessage[];
  text: string;
  continued: boolean;
  followupText: string | null;
  hitMaxTokens: boolean;
}> {
  const prepared = await prepareCodexContext(input);
  const schemas = input.activation.current.schemas();
  const requestId = `run-${input.run.id}-${input.requestIndex}`;
  pushRunEvent(input.run, 'text-start', {});
  let text = '';
  let pending = '';
  let done = false;
  let errorMessage: string | null = null;
  const toolHistory: ModelMessage[] = [];

  const settle = (
    callId: string,
    success: boolean,
    result: unknown,
  ): void => {
    void codexTurnManager.settleToolResult({
      requestId,
      callId,
      success,
      result: result ?? null,
    });
  };

  const bridgeToolCall = (event: Extract<CodexTurnStreamEvent, { type: 'tool-start' }>): void => {
    void (async () => {
      try {
        const schema = schemas.find((candidate) => candidate.name === event.name);
        if (!schema) {
          toolHistory.push(codexToolHistoryEntry(
            { name: event.name, args: event.args },
            { success: false, result: { error: `Unknown tool: ${event.name}` } },
          ));
          settle(event.callId, false, { error: `Unknown tool: ${event.name}` });
          return;
        }
        const delivered = await executeBrowserTool(
          input.run,
          schema,
          (event.args ?? {}) as Record<string, unknown>,
          event.callId,
          input.activation,
        );
        toolHistory.push(codexToolHistoryEntry(
          { name: event.name, args: event.args },
          { success: true, result: delivered },
        ));
        settle(event.callId, true, delivered ?? null);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        toolHistory.push(codexToolHistoryEntry(
          { name: event.name, args: event.args },
          { success: false, result: { error: message } },
        ));
        settle(event.callId, false, { error: message });
      }
    })();
  };

  const emit = (event: CodexTurnStreamEvent): void => {
    switch (event.type) {
      case 'text-delta':
        text += event.delta;
        pending = flushTextEvents(input.run, pending + event.delta, false);
        break;
      case 'tool-start':
        bridgeToolCall(event);
        break;
      case 'context-usage':
        recordServerContextUsage(
          input.run,
          usageFromCodexEvent(event, prepared, input.requestIndex),
          schemas.length,
          JSON.stringify(schemas).length,
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
  const runTurn = deps.runTurn ?? runServerCodexTurn;
  try {
    await withTimeout(runTurn(
      {
        requestId,
        system: input.instructions,
        prompt: serializeMessagesForPrompt([...prepared.messages]),
        projectId: input.projectId,
        askOnly: input.askOnly,
        model: input.model,
        tools: codexToolSpecs(schemas),
      },
      emit,
      input.signal,
    ), CODEX_TURN_TIMEOUT_MS);
  } catch (error) {
    turnError = error;
  }
  flushTextEvents(input.run, pending, true);
  pushRunEvent(input.run, 'text-end', serverRunTextMetadata(text));
  if (turnError) throw turnError;
  if (errorMessage) {
    throw new Error(errorMessage);
  }
  if (!done) {
    throw new Error('Codex turn ended without a terminal event.');
  }
  const messages: ModelMessage[] = [
    ...prepared.messages,
    ...(text ? [{ role: 'assistant', content: text } as ModelMessage] : []),
    ...toolHistory,
  ];
  return {
    messages,
    text,
    continued: toolHistory.length > 0,
    followupText: input.activation.followupText,
    hitMaxTokens: false,
  };
}

function withTimeout(promise: Promise<void>, timeoutMs: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Codex turn timed out after ${Math.round(timeoutMs / 1000)}s.`));
    }, timeoutMs);
    promise.then(
      () => { clearTimeout(timer); resolve(); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}
