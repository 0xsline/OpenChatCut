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
import { isFailedToolResult, toolFailureReason } from '../../src/agent/toolFailure';
import type { AgentContextUsage } from '../../src/agent/context-compaction';
import {
  persistServerCheckpoint,
  pushRunEvent,
  recordServerContextUsage,
  type ServerRun,
} from './store';
import { flushTextEvents, flushThinkingEvents, serverRunTextMetadata, type ActivationState } from './executor';

import type { ServerRunTurnRecoverySink, ServerSubprocessResume } from './run-recovery-contract';
import { RunRecoveryFault, asRecoveryFault, isRunRecoveryFault } from './run-recovery-fault';
import { createSubprocessToolDispatcher } from './subprocess-tool-dispatch';
import { resumeSubprocessPrompt, prepareSubprocessResume } from './subprocess-turn-context';

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
  readonly recovery?: ServerRunTurnRecoverySink;
  readonly resumeFrom?: ServerSubprocessResume;
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
  /** Short deterministic deadlines for verification. */
  readonly timeoutMs?: number;
  readonly settleToolResult?: typeof codexTurnManager.settleToolResult;
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
 * path), and tool results are settled back into the same Codex turn. Codex
 * owns its tool loop until `done`, so the outer API-style turn loop must not
 * replay a completed Codex turn.
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
  const activeSchemas = input.activation.current.schemas();
  const schemas = input.activation.current.allSchemas();
  const tools = codexToolSpecs(schemas);
  const resume = input.recovery ? input.resumeFrom : undefined;
  if (resume?.toolNames && JSON.stringify([...resume.toolNames].sort()) !== JSON.stringify(tools.map((tool) => tool.name).sort())) {
    throw new RunRecoveryFault('outcome-unknown', 'Codex tool catalog changed since the interrupted request.');
  }
  const instructions = resume?.instructions ?? input.instructions;
  const prepared = resume ? prepareSubprocessResume(input, resume, tools) : await prepareCodexContext(input);
  const prompt = resume ? resumeSubprocessPrompt(resume) : serializeMessagesForPrompt(prepared.messages);
  if (input.recovery) {
    try {
      await input.recovery.beginRequest({
        requestIndex: resume?.requestIndex ?? input.requestIndex,
        instructions, prompt: resume?.prompt ?? prompt,
        messages: [...(resume?.messages ?? prepared.messages)],
        toolNames: tools.map((tool) => tool.name),
      });
    } catch (error) { throw asRecoveryFault(error); }
  }
  // Each attempt creates a new temporary Codex thread. Old settlements cannot
  // address its successor even when the logical run/request index is unchanged.
  const requestId = `run-${input.run.id}-${input.requestIndex}-${crypto.randomUUID()}`;
  const controller = new AbortController();
  const stopped = Promise.withResolvers<never>();
  let open = true;
  const stop = (error: unknown) => {
    if (!open) return;
    open = false;
    dispatch.close();
    controller.abort(error);
    stopped.reject(error);
  };
  const relayAbort = () => stop(input.signal.reason ?? new Error('Codex turn cancelled.'));
  input.signal.addEventListener('abort', relayAbort, { once: true });
  pushRunEvent(input.run, 'text-start', {});
  let text = '';
  let pending = '';
  let pendingThinking = '';
  let done = false;
  let errorMessage: string | null = null;
  const toolHistory: ModelMessage[] = [];
  const dispatch = createSubprocessToolDispatcher({ ...input, signal: controller.signal }, schemas, toolHistory);
  const toolTasks = new Set<Promise<void>>();
  const settleToolResult = deps.settleToolResult ?? codexTurnManager.settleToolResult.bind(codexTurnManager);
  const bridgeToolCall = (event: Extract<CodexTurnStreamEvent, { type: 'tool-start' }>): void => {
    const task = (async () => {
      let success: boolean;
      let result: unknown;
      try {
        const toolCallId = input.recovery ? `codex-${input.requestIndex}:${event.callId}` : event.callId;
        result = await dispatch.executeTool({ callId: toolCallId, name: event.name, args: event.args });
        success = !isFailedToolResult(result);
      } catch (error) {
        if (isRunRecoveryFault(error)) { stop(error); return; }
        success = false;
        result = { error: toolFailureReason(error) };
      }
      if (!open || controller.signal.aborted) return;
      settleToolResult({ requestId, callId: event.callId, success, result: result ?? null });
    })().catch((error) => stop(error));
    toolTasks.add(task);
    void task.then(() => toolTasks.delete(task));
  };

  const emit = (event: CodexTurnStreamEvent): void => {
    if (!open || (done && event.type === 'tool-start')) return;
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
          usageFromCodexEvent(event, prepared, input.requestIndex),
          activeSchemas.length,
          JSON.stringify(activeSchemas).length,
        );
        break;
      case 'error':
        errorMessage = event.message;
        stop(new Error(event.message));
        break;
      case 'done':
        done = true;
        if (dispatch.hasUnconfirmedTools) {
          stop(input.recovery
            ? new RunRecoveryFault('outcome-unknown', 'Codex finished with an unconfirmed browser operation.')
            : new Error('Codex finished before its browser tool settled.'));
        } else {
          dispatch.close();
        }
        break;
      default:
        break;
    }
  };

  let turnError: unknown = null;
  const timeoutMs = deps.timeoutMs ?? CODEX_TURN_TIMEOUT_MS;
  const timer = setTimeout(() => stop(new Error(`Codex turn timed out after ${Math.round(timeoutMs / 1000)}s.`)), timeoutMs);
  try {
    if (input.signal.aborted) relayAbort();
    // Register the stop race before starting the runner: abort/fatal errors
    // must win even if an app-server callback never completes.
    await Promise.race([
      stopped.promise,
      Promise.resolve().then(async () => {
        if (!open) return;
        await (deps.runTurn ?? runServerCodexTurn)({
          requestId, system: instructions, prompt,
          projectId: input.projectId, askOnly: input.askOnly,
          model: input.model, tools,
        }, emit, controller.signal);
        await Promise.all(toolTasks);
      }),
    ]);
  } catch (error) {
    turnError = error;
  } finally {
    clearTimeout(timer);
    input.signal.removeEventListener('abort', relayAbort);
    open = false;
    dispatch.close();
    if (!controller.signal.aborted) controller.abort(new Error('Codex request closed.'));
  }
  if (dispatch.fault) turnError = dispatch.fault;
  if (input.recovery && dispatch.hasUnconfirmedTools && !isRunRecoveryFault(turnError)) {
    turnError = new RunRecoveryFault('outcome-unknown', 'Codex request closed with an unconfirmed browser operation.');
  }
  if (isRunRecoveryFault(turnError)) throw turnError;

  flushTextEvents(input.run, pending, true);
  flushThinkingEvents(input.run, pendingThinking, true);
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
    continued: false,
    followupText: input.activation.followupText,
    hitMaxTokens: false,
  };
}
