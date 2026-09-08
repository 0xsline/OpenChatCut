import { randomUUID } from 'node:crypto';
import { ToolSet, defineTool, type CopilotSession, type SessionConfig, type Tool } from '@github/copilot-sdk';
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
 */
function hostTools(request: CopilotTurnRequest, state: () => TurnSession | undefined): Tool<any>[] {
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

function copilotReasoningEffort(value: string | null | undefined): SessionConfig['reasoningEffort'] {
  if (!value) return undefined;
  if (value === 'low' || value === 'medium' || value === 'high' || value === 'xhigh' || value === 'max') {
    return value;
  }
  throw new CopilotProcessError(`Unsupported Copilot reasoning effort: ${value}`);
}

export function copilotSessionConfig(
  request: CopilotTurnRequest,
  state: () => TurnSession | undefined,
): SessionConfig {
  const reasoningEffort = copilotReasoningEffort(request.reasoningEffort);
  return {
    streaming: true,
    ...(request.model ? { model: request.model } : {}),
    ...(reasoningEffort ? { reasoningEffort } : {}),
    systemMessage: { mode: 'replace', content: request.system },
    tools: hostTools(request, state),
    availableTools: new ToolSet().addCustom('*'),
    onPermissionRequest: () => ({
      kind: 'reject',
      feedback: 'OpenChatCut only permits its own editing tools.',
    }),
    enableSessionStore: false,
  };
}

interface TurnLifecycle {
  readonly active: TurnSession;
  readonly promise: Promise<void>;
  readonly finish: (message: string | null) => void;
  readonly error: () => string | null;
}

function trackSessionEvents(lifecycle: TurnLifecycle, contextWindowTokens: number | null): void {
  const { active, finish } = lifecycle;
  active.session.on('assistant.message_delta', ({ data }) => {
    if (data.deltaContent) active.emit({ type: 'text-delta', delta: data.deltaContent });
  });
  active.session.on('assistant.reasoning_delta', ({ data }) => {
    if (data.deltaContent) active.emit({ type: 'thinking-delta', delta: data.deltaContent });
  });
  active.session.on('assistant.usage', ({ data }) => {
    const usage = contextUsageEvent(data, contextWindowTokens);
    if (usage) active.emit(usage);
  });
  active.session.on('session.error', ({ data }) => finish(errorSummary(data)));
  active.session.on('session.idle', () => finish(null));
}

function turnLifecycle(active: TurnSession): TurnLifecycle {
  const { promise, resolve } = Promise.withResolvers<void>();
  let errorMessage: string | null = null;
  return {
    active, promise, error: () => errorMessage,
    finish(message) {
      if (active.terminal) return;
      active.terminal = true;
      errorMessage = message;
      resolve();
    },
  };
}

function idleWatchdog(lifecycle: TurnLifecycle): { arm: () => void; stop: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const arm = (): void => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      const now = Date.now();
      const waiting = [...lifecycle.active.pendingTools.values()]
        .some((call) => now - call.startedAt < TOOL_PENDING_GRACE_MS);
      if (waiting) arm();
      else lifecycle.finish(`Copilot turn stalled: no activity for ${IDLE_TIMEOUT_MS / 1000}s.`);
    }, IDLE_TIMEOUT_MS);
  };
  return { arm, stop: () => clearTimeout(timer) };
}

async function sendSessionPrompt(
  lifecycle: TurnLifecycle,
  prompt: string,
  signal: AbortSignal,
): Promise<void> {
  const onAbort = (): void => lifecycle.finish('Copilot turn was cancelled.');
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    if (signal.aborted) onAbort();
    else await lifecycle.active.session.send({ prompt });
    await lifecycle.promise;
  } catch (error) {
    lifecycle.finish(error instanceof Error ? error.message : 'Copilot turn failed.');
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

async function disconnectTurn(active: TurnSession): Promise<void> {
  sessions.delete(active.requestId);
  for (const [callId, pending] of active.pendingTools) {
    active.pendingTools.delete(callId);
    pending.resolve({ success: false, result: { error: 'Copilot turn ended.' } });
  }
  await active.session.disconnect().catch(() => undefined);
}

/** Run a host-tool-only turn with streaming and bounded inactivity. */
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
  let armIdle = (): void => undefined;
  const session = await client.createSession(copilotSessionConfig(request, () => active));
  active = {
    requestId: request.requestId, session, pendingTools: new Map(), terminal: false,
    emit: (event) => { armIdle(); emit(event); },
  };
  sessions.set(request.requestId, active);
  const lifecycle = turnLifecycle(active);
  const watchdog = idleWatchdog(lifecycle);
  armIdle = watchdog.arm;
  trackSessionEvents(lifecycle, options.contextWindowTokens ?? null);
  armIdle();
  try {
    await sendSessionPrompt(lifecycle, request.prompt, signal);
  } finally {
    watchdog.stop();
    await disconnectTurn(active);
  }
  const message = lifecycle.error();
  emit(message ? { type: 'error', message } : { type: 'done' });
}
