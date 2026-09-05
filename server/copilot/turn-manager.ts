import { randomUUID } from 'node:crypto';
import { ToolSet, defineTool, type CopilotSession, type Tool } from '@github/copilot-sdk';
import type {
  CopilotToolResultRequest,
  CopilotTurnRequest,
  CopilotTurnStreamEvent,
} from '../../shared/copilot-agent.ts';
import { copilotClient, CopilotProcessError } from './client.ts';

/**
 * Idle cap, not a wall-clock cap. A long agentic turn (scouting footage, placing
 * dozens of shots, grading each one) legitimately runs for many minutes while
 * streaming the whole time; killing it on total elapsed time is wrong. The timer
 * is re-armed on every stream event and is suspended while a host tool call is
 * in flight, so it only fires when the turn is genuinely stuck.
 */
const IDLE_TIMEOUT_MS = 5 * 60_000;
/**
 * Upper bound on how long one in-flight tool call may suspend the idle timer.
 * Matches the broker's own MAX_TIMEOUT_MS so a tool that never settles (an
 * external caller that drops /tool-result) cannot hang the turn forever.
 */
const TOOL_PENDING_GRACE_MS = 600_000;
const ERROR_SUMMARY_LIMIT = 500;

interface PendingToolCall {
  readonly name: string;
  readonly args: unknown;
  readonly startedAt: number;
  readonly resolve: (value: { success: boolean; result: unknown }) => void;
}

interface TurnSession {
  readonly requestId: string;
  readonly session: CopilotSession;
  readonly emit: (event: CopilotTurnStreamEvent) => void;
  readonly pendingTools: Map<string, PendingToolCall>;
  terminal: boolean;
}

const sessions = new Map<string, TurnSession>();

function object(value: unknown): Record<string, any> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, any>
    : null;
}

function tokenCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/**
 * Map `assistant.usage` onto the same context-usage event the Codex turn
 * manager emits, so `recordServerContextUsage` needs no Copilot-specific path.
 */
function contextUsageEvent(
  data: Record<string, any>,
  contextWindowTokens: number | null,
): Extract<CopilotTurnStreamEvent, { type: 'context-usage' }> | null {
  const inputTokens = tokenCount(data.inputTokens);
  if (inputTokens === undefined) return null;
  const cacheReadTokens = tokenCount(data.cacheReadTokens);
  const validCache = cacheReadTokens !== undefined && cacheReadTokens <= inputTokens
    ? cacheReadTokens
    : undefined;
  return {
    type: 'context-usage',
    inputTokens,
    ...(contextWindowTokens ? { contextWindowTokens } : {}),
    ...(tokenCount(data.outputTokens) === undefined ? {} : { outputTokens: tokenCount(data.outputTokens) }),
    ...(tokenCount(data.reasoningTokens) === undefined
      ? {}
      : { reasoningTokens: tokenCount(data.reasoningTokens) }),
    ...(validCache === undefined ? {} : {
      cacheReadTokens: validCache,
      noCacheInputTokens: inputTokens - validCache,
    }),
  };
}

function errorSummary(data: Record<string, any>): string {
  const detail = typeof data.message === 'string'
    ? data.message.replace(/\s+/g, ' ').trim().slice(0, ERROR_SUMMARY_LIMIT)
    : '';
  const type = typeof data.errorType === 'string' ? data.errorType : '';
  if (type === 'quota' || type === 'rate_limit') {
    return `Copilot is rate limited or out of quota. ${detail}`.trim();
  }
  if (type === 'authentication' || type === 'authorization') {
    return `Copilot authentication failed. Sign in with \`copilot /login\`. ${detail}`.trim();
  }
  return detail || 'Copilot turn failed.';
}

function validImagePayload(value: unknown): value is Array<{ base64: string }> {
  return Array.isArray(value) && value.length > 0 && value.every((image) => {
    const shaped = object(image);
    return typeof shaped?.base64 === 'string' && shaped.base64.length > 0;
  });
}

/**
 * Frame tools (`view_asset_frames`, `view_timeline_frames`, export QA) return
 * rendered contact sheets under `__images`. Hand those to the model as real
 * image attachments, exactly as the Codex backend does via `inputImage`.
 * Without this the base64 is JSON-stringified into the text result: it blows up
 * the context window and leaves the model with nothing to actually look at.
 */
function successToolResult(result: unknown, toolName: string): unknown {
  const shaped = object(result);
  if (!shaped || !validImagePayload(shaped.__images)) return result ?? { ok: true };
  const { __images: images, ...rest } = shaped;
  const note = typeof rest.note === 'string'
    ? rest.note.slice(0, 4_000)
    : `${images.length} frames rendered by ${toolName}`;
  return {
    resultType: 'success' as const,
    textResultForLlm: JSON.stringify({ ...rest, note }),
    binaryResultsForLlm: images.map((image) => ({
      type: 'image' as const,
      mimeType: 'image/jpeg',
      data: image.base64,
    })),
  };
}

/**
 * Bridge OpenChatCut's tool catalog into SDK tools. The handler emits
 * `tool-start` and then blocks on `settleToolResult`, reproducing the deferred
 * settle protocol the Codex turn manager uses — so the executor's existing
 * `bridgeToolCall` path works unchanged.
 */function hostTools(request: CopilotTurnRequest, state: () => TurnSession | undefined): Tool<any>[] {
  return request.tools.map((spec) => defineTool(spec.name, {
    description: spec.description,
    parameters: spec.inputSchema,
    // OpenChatCut runs its own approval gate (approval-mode.ts); the CLI must
    // not add a second, unrelated confirmation prompt on top of it.
    skipPermission: true,
    handler: async (args: unknown) => {
      const active = state();
      if (!active) throw new Error('Copilot turn is no longer active.');
      const callId = randomUUID();
      const settled = new Promise<{ success: boolean; result: unknown }>((resolve) => {
        active.pendingTools.set(callId, { name: spec.name, args, startedAt: Date.now(), resolve });
      });
      active.emit({ type: 'tool-start', callId, name: spec.name, args });
      const outcome = await settled;
      active.emit({
        type: 'tool-end',
        callId,
        name: spec.name,
        args,
        result: outcome.result,
        success: outcome.success,
      });
      if (!outcome.success) {
        // Throwing here would collapse to a generic "Tool execution failed" and
        // strip OpenChatCut's diagnostic, which the agent needs in order to
        // recover. Return a typed failure so the real reason reaches the model.
        const detail = object(outcome.result)?.error;
        const message = typeof detail === 'string' && detail
          ? detail
          : `Tool ${spec.name} failed.`;
        return {
          resultType: 'failure' as const,
          error: message,
          textResultForLlm: JSON.stringify(outcome.result ?? { error: message }),
        };
      }
      return successToolResult(outcome.result, spec.name);
    },
  }));
}

/**
 * Settle a tool call the host executed on the agent's behalf. Mirrors
 * `codexTurnManager.settleToolResult`.
 */
export function settleToolResult(request: CopilotToolResultRequest): 'ok' | 'unknown-request' | 'unknown-call' {
  const active = sessions.get(request.requestId);
  if (!active) return 'unknown-request';
  const pending = active.pendingTools.get(request.callId);
  if (!pending) return 'unknown-call';
  active.pendingTools.delete(request.callId);
  pending.resolve({ success: request.success, result: request.result });
  return 'ok';
}

/** True while `requestId` has an in-flight turn, so the caller can reject reuse. */
export function hasCopilotRequest(requestId: string): boolean {
  return sessions.has(requestId);
}

export interface RunCopilotTurnOptions {
  /** Context window for usage reporting; from `listCopilotModels()`. */
  readonly contextWindowTokens?: number | null;
}

/**
 * Run one Copilot turn. Emits the same stream-event union the Codex backend
 * produces, so `executeServerCodexTurn`'s consumption logic ports directly.
 */
export async function runCopilotTurn(
  request: CopilotTurnRequest,
  emit: (event: CopilotTurnStreamEvent) => void,
  signal: AbortSignal,
  options: RunCopilotTurnOptions = {},
): Promise<void> {
  if (sessions.has(request.requestId)) {
    throw new CopilotProcessError(`Copilot turn ${request.requestId} is already running.`);
  }
  const client = await copilotClient();
  let active: TurnSession | undefined;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let armIdle = (): void => undefined;
  /** Every stream event counts as progress and re-arms the idle timer. */
  const emitTracked = (event: CopilotTurnStreamEvent): void => {
    armIdle();
    emit(event);
  };
  const session = await client.createSession({
    ...(request.model ? { model: request.model } : {}),
    ...(request.reasoningEffort ? { reasoningEffort: request.reasoningEffort as any } : {}),
    systemMessage: { mode: 'replace', content: request.system },
    tools: hostTools(request, () => active),
    // Only OpenChatCut tools. No shell, no filesystem, no web, no MCP.
    availableTools: new ToolSet().addCustom('*'),
    // Any permission request here means a non-OpenChatCut tool slipped through
    // the `availableTools` filter, so refuse it rather than prompting.
    onPermissionRequest: () => ({
      kind: 'reject' as const,
      feedback: 'OpenChatCut only permits its own editing tools.',
    }),
    enableSessionStore: false,
  });

  active = {
    requestId: request.requestId,
    session,
    emit: emitTracked,
    pendingTools: new Map(),
    terminal: false,
  };
  sessions.set(request.requestId, active);

  const { promise, resolve } = Promise.withResolvers<void>();
  let errorMessage: string | null = null;

  const finish = (message: string | null): void => {
    if (!active || active.terminal) return;
    active.terminal = true;
    errorMessage = message;
    resolve();
  };

  session.on('assistant.message_delta', (event: any) => {
    const delta = event?.data?.deltaContent;
    if (typeof delta === 'string' && delta) emitTracked({ type: 'text-delta', delta });
  });
  session.on('assistant.reasoning_delta', (event: any) => {
    const delta = event?.data?.deltaContent;
    if (typeof delta === 'string' && delta) emitTracked({ type: 'thinking-delta', delta });
  });
  session.on('assistant.usage', (event: any) => {
    const data = object(event?.data);
    if (!data) return;
    const usage = contextUsageEvent(data, options.contextWindowTokens ?? null);
    if (usage) emitTracked(usage);
  });
  session.on('session.error', (event: any) => {
    const data = object(event?.data);
    finish(data ? errorSummary(data) : 'Copilot turn failed.');
  });
  session.on('session.idle', () => finish(null));

  const onAbort = (): void => finish('Copilot turn was cancelled.');
  signal.addEventListener('abort', onAbort, { once: true });
  const onIdle = (): void => {
    // A pending tool call is real work (frame rendering, generation jobs) that
    // produces no stream events; re-arm instead of declaring the turn stuck.
    // Bounded by TOOL_PENDING_GRACE_MS so a never-settled call cannot hang us.
    const now = Date.now();
    const waiting = [...(active?.pendingTools.values() ?? [])]
      .some((call) => now - call.startedAt < TOOL_PENDING_GRACE_MS);
    if (waiting) {
      armIdle();
      return;
    }
    finish(`Copilot turn stalled: no activity for ${Math.round(IDLE_TIMEOUT_MS / 1000)}s.`);
  };
  armIdle = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(onIdle, IDLE_TIMEOUT_MS);
  };
  armIdle();

  try {
    if (signal.aborted) finish('Copilot turn was cancelled.');
    else await session.send({ prompt: request.prompt });
    await promise;
  } catch (error) {
    errorMessage = error instanceof Error ? error.message : 'Copilot turn failed.';
  } finally {
    clearTimeout(idleTimer);
    signal.removeEventListener('abort', onAbort);
    sessions.delete(request.requestId);
    // Unblock any handler still waiting on a settle so the SDK call can unwind.
    for (const [callId, pending] of active.pendingTools) {
      active.pendingTools.delete(callId);
      pending.resolve({ success: false, result: { error: 'Copilot turn ended.' } });
    }
    await session.disconnect().catch(() => undefined);
  }

  if (errorMessage) {
    emit({ type: 'error', message: errorMessage });
    return;
  }
  emit({ type: 'done' });
}
