import type { ModelMessage } from 'ai';
import { runServerClaudeCodeTurn } from '../plugins/claude-code-agent';
import type { ClaudeCodeTurnRequest, ClaudeCodeTurnStreamEvent } from '../../shared/claude-code-agent';
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
import { digestToolArgs } from './store-values';
import { flushTextEvents, flushThinkingEvents, serverRunTextMetadata, type ActivationState } from './executor';
import {
  claudeCodeSessionKey,
  forgetClaudeCodeSession,
  recallClaudeCodeSession,
  rememberClaudeCodeSession,
} from '../claude-code/resume-store.ts';

const CLAUDE_CODE_TURN_TIMEOUT_MS = 600_000;

export interface ServerClaudeCodeTurnInput {
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
  /** Declared to this turn's MCP server so begin_edit_session cannot default to manual. */
  readonly approvalMode?: 'manual' | 'auto';
}

function usageFromClaudeCodeEvent(
  event: Extract<ClaudeCodeTurnStreamEvent, { type: 'context-usage' }>,
  prepared: { usage: AgentContextUsage },
  requestIndex: number,
): AgentContextUsage {
  return {
    ...prepared.usage,
    inputTokens: event.inputTokens,
    outputTokens: event.outputTokens,
    cacheReadTokens: event.cacheReadTokens,
    requestIndex,
    attemptIndex: 0,
    isEstimated: event.inputTokens === undefined || event.outputTokens === undefined,
  };
}

/** One Claude Code turn used as the context-summary model call. */
async function summarizeWithClaudeCode(
  input: ServerClaudeCodeTurnInput,
  prompt: string,
  maxOutputTokens: number,
  systemPrompt: string,
): Promise<string> {
  const requestId = `summary-${input.run.id}-${input.requestIndex}-${crypto.randomUUID().slice(0, 8)}`;
  let text = '';
  await runServerClaudeCodeTurn(
    { requestId, system: systemPrompt, prompt, projectId: input.projectId, model: input.model },
    (event) => {
      if (event.type === 'text-delta') text += event.delta;
    },
    input.signal,
  );
  if (!text.trim()) throw new Error('Claude Code context summary returned no text.');
  return text.slice(0, maxOutputTokens * 4);
}

/**
 * The prompt for a resumed turn. The CLI already holds every earlier message in
 * its own transcript, so re-sending the serialized history would duplicate the
 * whole conversation inside the resumed session.
 */
function latestUserPrompt(messages: readonly ModelMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === 'user') return serializeMessagesForPrompt([messages[index]]);
  }
  return serializeMessagesForPrompt([...messages]);
}

async function prepareClaudeCodeContext(
  input: ServerClaudeCodeTurnInput,
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
        return summarizeWithClaudeCode(input, prompt, maxOutputTokens, systemPrompt);
      },
    ),
  });
  if (prepared.checkpoint) {
    await persistServerCheckpoint(input.run, prepared.checkpoint);
  }
  return prepared;
}

export interface ServerClaudeCodeTurnDeps {
  /** Overridable for verification; defaults to the real server Claude Code runner. */
  readonly runTurn?: (
    request: ClaudeCodeTurnRequest,
    emit: (event: ClaudeCodeTurnStreamEvent) => void,
    signal: AbortSignal,
  ) => Promise<void>;
}

/**
 * Run one Agent turn through the server-side Claude Code executor.
 *
 * Unlike Codex, Claude Code CLI's own MCP client calls OpenChatCut's MCP
 * server directly and executes tools itself (the CLI is launched with
 * --mcp-config pointing at this instance's own /api/external-mcp/mcp and
 * --allowedTools "mcp__openchatcut-builtin__*"). There is no tool-execution bridge
 * and no result-settlement RPC: `tool-start`/`tool-end` stream events here
 * are for chat-UI display and conversation-history reconstruction only.
 *
 * KNOWN LIMITATION (documented, not silently glossed over): because tool
 * calls bypass `executeBrowserTool`, they are not gated by this run's
 * ToolActivation (the CLI is given a blanket "mcp__openchatcut-builtin__*" allow
 * list, not the same turn-by-turn activated subset the API/Codex paths
 * enforce), and any proposal/undo-batch bookkeeping that only lives inside
 * `executeBrowserTool` does not apply to these calls either — the display
 * events pushed below give the UI equivalent visibility, but the calls are
 * really running as an independent, self-authenticated external-MCP agent
 * session against the live project, same trust level as any other external
 * MCP client (Claude Desktop, Cursor, etc.), not as a proposal this run owns.
 */
export async function executeServerClaudeCodeTurn(
  input: ServerClaudeCodeTurnInput,
  deps: ServerClaudeCodeTurnDeps = {},
): Promise<{
  messages: ModelMessage[];
  text: string;
  continued: boolean;
  followupText: string | null;
  hitMaxTokens: boolean;
}> {
  const prepared = await prepareClaudeCodeContext(input);
  const activeSchemas = input.activation.current.schemas();
  const requestId = `run-${input.run.id}-${input.requestIndex}`;
  pushRunEvent(input.run, 'text-start', {});
  let text = '';
  let pending = '';
  let pendingThinking = '';
  let done = false;
  let errorMessage: string | null = null;
  const toolHistory: ModelMessage[] = [];
  const pendingArgs = new Map<string, unknown>();
  let cliSessionId: string | null = null;
  const resumeKey = claudeCodeSessionKey({
    projectId: input.projectId,
    sessionGeneration: input.run.sessionGeneration,
    model: input.model,
  });
  // Compaction rewrites OpenChatCut's history but leaves the CLI's own
  // transcript untouched, so the two have diverged and a resumed session would
  // carry the pre-summary conversation the compaction was meant to shed.
  if (prepared.usage.compacted) forgetClaudeCodeSession(resumeKey);
  const resumeSessionId = prepared.usage.compacted ? null : recallClaudeCodeSession(resumeKey);

  const emit = (event: ClaudeCodeTurnStreamEvent): void => {
    switch (event.type) {
      case 'text-delta':
        text += event.delta;
        pending = flushTextEvents(input.run, pending + event.delta, false);
        break;
      case 'thinking-delta':
        pendingThinking = flushThinkingEvents(input.run, pendingThinking + event.delta, false);
        break;
      case 'tool-start':
        // Deliberately does NOT push a 'tool-request' event. That event type is
        // a request for the BROWSER to execute a tool and settle it back (see
        // browser-tool.ts) — the client claims it via /tool-claim. Claude Code
        // already executed this call inside its own MCP client, so there is
        // nothing for the browser to run and nothing registered to claim: the
        // claim 404s, and store-recovery.ts then treats the unresolved
        // tool-request as a run to recover on every reload, so the error
        // resurfaces forever. Only the terminal 'tool-result' below is pushed,
        // which the client consumes as display-only.
        pendingArgs.set(event.callId, event.args);
        break;
      case 'tool-end': {
        const args = pendingArgs.get(event.callId) ?? event.args;
        pendingArgs.delete(event.callId);
        toolHistory.push(codexToolHistoryEntry(
          { name: event.name, args },
          { success: event.success, result: event.result },
        ));
        pushRunEvent(input.run, 'tool-result', {
          toolCallId: event.callId,
          toolName: event.name,
          argsDigest: digestToolArgs((args ?? {}) as Record<string, unknown>),
          ...(event.success ? { result: event.result } : { error: 'Claude Code tool call failed.' }),
        });
        break;
      }
      case 'context-usage':
        recordServerContextUsage(
          input.run,
          usageFromClaudeCodeEvent(event, prepared, input.requestIndex),
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
      case 'session':
        // The CLI reports the session it actually used, which is not
        // necessarily the one passed to --resume: keep whatever it says so the
        // next turn resumes the live transcript rather than a forked ancestor.
        cliSessionId = event.sessionId;
        break;
      default:
        break;
    }
  };

  let turnError: unknown = null;
  const runTurn = deps.runTurn ?? runServerClaudeCodeTurn;
  const attempt = async (sessionId: string | null): Promise<void> => {
    try {
      await withTimeout(runTurn(
        {
          requestId,
          system: input.instructions,
          prompt: sessionId
            ? latestUserPrompt(prepared.messages)
            : serializeMessagesForPrompt([...prepared.messages]),
          projectId: input.projectId,
          model: input.model,
          ...(input.approvalMode ? { approvalMode: input.approvalMode } : {}),
          ...(sessionId ? { sessionId } : {}),
        },
        emit,
        input.signal,
      ), CLAUDE_CODE_TURN_TIMEOUT_MS);
    } catch (error) {
      turnError = error;
    }
  };
  await attempt(resumeSessionId);
  // A session the CLI cannot load fails before producing anything at all. That
  // is indistinguishable from never having started, so fall back to a cold
  // start with the full history rather than surfacing a stale transcript as the
  // user's failure. The guard is deliberately strict: nothing was streamed and
  // no tool ran, so replaying cannot duplicate a UI event or an edit.
  if (resumeSessionId && !input.signal.aborted && !text && !toolHistory.length && !done) {
    forgetClaudeCodeSession(resumeKey);
    turnError = null;
    errorMessage = null;
    cliSessionId = null;
    pendingArgs.clear();
    await attempt(null);
  }
  if (turnError || errorMessage || !done) forgetClaudeCodeSession(resumeKey);
  else if (cliSessionId) rememberClaudeCodeSession(resumeKey, cliSessionId);
  flushTextEvents(input.run, pending, true);
  flushThinkingEvents(input.run, pendingThinking, true);
  pushRunEvent(input.run, 'text-end', serverRunTextMetadata(text));
  if (turnError) throw turnError;
  if (errorMessage) {
    throw new Error(errorMessage);
  }
  if (!done) {
    throw new Error('Claude Code turn ended without a terminal event.');
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

function withTimeout(promise: Promise<void>, timeoutMs: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Claude Code turn timed out after ${Math.round(timeoutMs / 1000)}s.`));
    }, timeoutMs);
    promise.then(
      () => { clearTimeout(timer); resolve(); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}
