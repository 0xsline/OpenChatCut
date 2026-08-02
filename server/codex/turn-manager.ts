import type {
  CodexAgentToolSpec,
  CodexToolResultRequest,
  CodexTurnRequest,
  CodexTurnStreamEvent,
} from '../../shared/codex-agent.ts';
import {
  CODEX_DISABLED_FEATURES,
  CodexAppServerClient,
  CodexRpcError,
  CodexTimeoutError,
  type CodexNotification,
  type CodexServerRequest,
} from './app-server.ts';

const THREAD_START_TIMEOUT_MS = 20_000;
const TURN_START_TIMEOUT_MS = 20_000;
const CLEANUP_TIMEOUT_MS = 3_000;
const ERROR_SUMMARY_LIMIT = 500;

type StreamSink = (event: CodexTurnStreamEvent) => void;

interface PendingToolCall {
  readonly request: CodexServerRequest;
  readonly name: string;
  readonly args: unknown;
}

interface TurnSession {
  readonly requestId: string;
  readonly client: CodexAppServerClient;
  readonly toolNames: ReadonlySet<string>;
  readonly emit: StreamSink;
  readonly completion: Promise<void>;
  readonly finish: (event: Extract<CodexTurnStreamEvent, { type: 'done' | 'error' }>) => boolean;
  readonly pendingTools: Map<string, PendingToolCall>;
  threadId: string | null;
  turnId: string | null;
  clientAlive: boolean;
  terminal: boolean;
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function identifier(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 ? value : null;
}

function sessionError(error: unknown): string {
  if (error instanceof CodexTimeoutError) return 'Codex took too long to start the turn. Try again.';
  if (error instanceof CodexRpcError) return 'Codex could not start this turn. Sign in or choose another model.';
  return 'Codex app-server stopped before the turn completed.';
}

function browserFailureSummary(result: unknown): string {
  if (typeof result === 'string') return result.replace(/\s+/g, ' ').slice(0, ERROR_SUMMARY_LIMIT);
  const shaped = object(result);
  const candidate = shaped?.error ?? shaped?.message ?? shaped?.note;
  if (typeof candidate === 'string') return candidate.replace(/\s+/g, ' ').slice(0, ERROR_SUMMARY_LIMIT);
  return 'OpenChatCut tool execution failed.';
}

function validImagePayload(value: unknown): value is Array<{ base64: string }> {
  return Array.isArray(value) && value.length > 0 && value.every((image) => {
    const shaped = object(image);
    return typeof shaped?.base64 === 'string' && shaped.base64.length > 0;
  });
}

function dynamicToolResult(body: CodexToolResultRequest): Record<string, unknown> {
  const shaped = object(body.result);
  if (validImagePayload(shaped?.__images)) {
    const note = typeof shaped?.note === 'string'
      ? shaped.note.slice(0, 4_000)
      : `${shaped.__images.length} frames rendered`;
    return {
      contentItems: [
        ...shaped.__images.map((image) => ({
          type: 'inputImage',
          imageUrl: `data:image/jpeg;base64,${image.base64}`,
        })),
        { type: 'inputText', text: note },
      ],
      success: body.success,
    };
  }
  return {
    contentItems: [{ type: 'inputText', text: JSON.stringify(body.result) ?? 'null' }],
    success: body.success,
  };
}

function dynamicTools(tools: readonly CodexAgentToolSpec[], askOnly: boolean): unknown[] {
  if (askOnly) return [];
  return tools.map((tool) => ({
    type: 'function',
    name: tool.name,
    description: tool.description ?? tool.name,
    inputSchema: tool.inputSchema,
  }));
}

function baseInstructions(request: CodexTurnRequest): string {
  const mode = request.askOnly
    ? 'Answer the user without calling tools. No OpenChatCut editor tools are available in this turn.'
    : [
        'Use only the provided OpenChatCut editor tools when the task needs project reads or changes.',
        'Their results come from the existing OpenChatCut proposal workflow; never claim a change succeeded before its tool result confirms success.',
      ].join(' ');
  return [
    request.system.trim(),
    'OpenChatCut runtime rules:',
    `The requested project id is ${JSON.stringify(request.projectId)}. Do not switch to another project.`,
    mode,
    'Shell, direct filesystem edits, web search, image-view, and multi-agent tools are disabled.',
  ].filter(Boolean).join('\n\n');
}

function threadStartParams(request: CodexTurnRequest): Record<string, unknown> {
  return {
    ...(request.model?.trim() ? { model: request.model.trim() } : {}),
    cwd: null,
    approvalPolicy: 'never',
    sandbox: 'read-only',
    ephemeral: true,
    baseInstructions: baseInstructions(request),
    dynamicTools: dynamicTools(request.tools, request.askOnly === true),
    config: {
      features: Object.fromEntries(
        CODEX_DISABLED_FEATURES.map((feature) => [feature, false]),
      ),
      tools: { view_image: false },
      web_search: 'disabled',
    },
  };
}

function turnStartParams(threadId: string, request: CodexTurnRequest): Record<string, unknown> {
  return {
    threadId,
    input: [{ type: 'text', text: request.prompt, text_elements: [] }],
    approvalPolicy: 'never',
    ...(request.reasoningEffort?.trim() ? { effort: request.reasoningEffort.trim() } : {}),
  };
}

function createSession(request: CodexTurnRequest, client: CodexAppServerClient, emit: StreamSink): TurnSession {
  const { promise: completion, resolve: resolveCompletion } = Promise.withResolvers<void>();
  let session: TurnSession;
  session = {
    requestId: request.requestId,
    client,
    toolNames: new Set(request.tools.map((tool) => tool.name)),
    emit,
    completion,
    pendingTools: new Map<string, PendingToolCall>(),
    threadId: null,
    turnId: null,
    clientAlive: true,
    terminal: false,
    finish: (event) => {
      if (session.terminal) return false;
      session.terminal = true;
      session.emit(event);
      resolveCompletion();
      return true;
    },
  };
  return session;
}

export class CodexTurnManager {
  private readonly sessions = new Map<string, TurnSession>();

  hasRequest(requestId: string): boolean {
    return this.sessions.has(requestId);
  }

  async run(
    client: CodexAppServerClient,
    request: CodexTurnRequest,
    emit: StreamSink,
    signal: AbortSignal,
  ): Promise<void> {
    if (this.sessions.has(request.requestId)) throw new Error('requestId is already active');
    const session = createSession(request, client, emit);
    this.sessions.set(request.requestId, session);
    const subscriptions = this.subscribe(session);
    const onAbort = () => session.finish({ type: 'error', message: 'Codex turn cancelled.' });
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      await this.startTurn(session, request, signal);
      await session.completion;
    } catch (error) {
      session.finish({ type: 'error', message: sessionError(error) });
    } finally {
      signal.removeEventListener('abort', onAbort);
      await this.cleanup(session, signal.aborted);
      subscriptions.forEach((unsubscribe) => unsubscribe());
      this.sessions.delete(session.requestId);
    }
  }

  settleToolResult(body: CodexToolResultRequest): 'ok' | 'unknown-request' | 'unknown-call' {
    const session = this.sessions.get(body.requestId);
    if (!session || session.terminal) return 'unknown-request';
    const pending = session.pendingTools.get(body.callId);
    if (!pending) return 'unknown-call';
    session.pendingTools.delete(body.callId);
    if (!pending.request.respond(dynamicToolResult(body))) return 'unknown-call';
    session.emit({
      type: 'tool-end',
      callId: body.callId,
      name: pending.name,
      args: pending.args,
      result: body.success ? null : browserFailureSummary(body.result),
      success: body.success,
    });
    return 'ok';
  }

  private subscribe(session: TurnSession): Array<() => void> {
    return [
      session.client.onNotification((notification) => this.notification(session, notification)),
      session.client.onServerRequest((request) => this.serverRequest(session, request)),
      session.client.onExit(() => {
        session.clientAlive = false;
        session.finish({ type: 'error', message: 'Codex app-server stopped before the turn completed.' });
      }),
    ];
  }

  private async startTurn(session: TurnSession, request: CodexTurnRequest, signal: AbortSignal): Promise<void> {
    const threadResponse = object(await session.client.request(
      'thread/start',
      threadStartParams(request),
      { timeoutMs: THREAD_START_TIMEOUT_MS, restartOnTimeout: true, signal },
    ));
    session.threadId = identifier(object(threadResponse?.thread)?.id);
    if (!session.threadId) throw new Error('Codex did not return a thread id.');
    const turnResponse = object(await session.client.request(
      'turn/start',
      turnStartParams(session.threadId, request),
      { timeoutMs: TURN_START_TIMEOUT_MS, restartOnTimeout: true, signal },
    ));
    session.turnId = identifier(object(turnResponse?.turn)?.id) ?? session.turnId;
    if (!session.turnId) throw new Error('Codex did not return a turn id.');
  }

  private notification(session: TurnSession, notification: CodexNotification): void {
    const params = notification.params;
    if (!this.matchesThread(session, params)) return;
    const turn = object(params.turn);
    const turnId = identifier(params.turnId) ?? identifier(turn?.id);
    if (turnId && !session.turnId) session.turnId = turnId;
    if (turnId && session.turnId !== turnId) return;
    if (notification.method === 'item/agentMessage/delta' && typeof params.delta === 'string') {
      session.emit({ type: 'text-delta', delta: params.delta });
      return;
    }
    if ((notification.method === 'item/reasoning/summaryTextDelta' || notification.method === 'item/reasoning/textDelta')
      && typeof params.delta === 'string') {
      session.emit({ type: 'thinking-delta', delta: params.delta });
      return;
    }
    if (notification.method === 'error' && params.willRetry !== true) {
      session.finish({ type: 'error', message: 'Codex turn failed. Try again.' });
      return;
    }
    if (notification.method === 'turn/completed') this.completeTurn(session, turn);
  }

  private matchesThread(session: TurnSession, params: Record<string, unknown>): boolean {
    const threadId = identifier(params.threadId);
    return Boolean(session.threadId && threadId === session.threadId);
  }

  private completeTurn(session: TurnSession, turn: Record<string, unknown> | null): void {
    if (turn?.status === 'completed') session.finish({ type: 'done' });
    else if (turn?.status === 'interrupted') session.finish({ type: 'error', message: 'Codex turn was interrupted.' });
    else session.finish({ type: 'error', message: 'Codex turn failed. Try again.' });
  }

  private serverRequest(session: TurnSession, request: CodexServerRequest): boolean {
    if (request.method !== 'item/tool/call') return false;
    const threadId = identifier(request.params.threadId);
    if (!session.threadId || threadId !== session.threadId) return false;
    const turnId = identifier(request.params.turnId);
    if (turnId && !session.turnId) session.turnId = turnId;
    if (!turnId || session.turnId !== turnId) return false;
    const callId = identifier(request.params.callId);
    const name = identifier(request.params.tool);
    if (!callId || !name || !session.toolNames.has(name) || session.pendingTools.has(callId)) {
      request.respond({
        contentItems: [{ type: 'inputText', text: 'This OpenChatCut tool call is unavailable.' }],
        success: false,
      });
      return true;
    }
    const args = request.params.arguments ?? {};
    session.pendingTools.set(callId, { request, name, args });
    session.emit({ type: 'tool-start', callId, name, args });
    return true;
  }

  private async cleanup(session: TurnSession, aborted: boolean): Promise<void> {
    this.abortPendingTools(session);
    if (!session.clientAlive) return;
    if (!session.threadId) {
      session.client.restart('Codex turn ended before thread cleanup was possible.');
      return;
    }
    if (aborted && session.turnId) {
      await session.client.request(
        'turn/interrupt',
        { threadId: session.threadId, turnId: session.turnId },
        { timeoutMs: CLEANUP_TIMEOUT_MS },
      ).catch(() => {});
    }
    await session.client.request(
      'thread/delete',
      { threadId: session.threadId },
      { timeoutMs: CLEANUP_TIMEOUT_MS, restartOnTimeout: true },
    ).catch(() => {});
  }

  private abortPendingTools(session: TurnSession): void {
    for (const pending of session.pendingTools.values()) {
      pending.request.respond({
        contentItems: [{ type: 'inputText', text: 'OpenChatCut cancelled this tool call.' }],
        success: false,
      });
    }
    session.pendingTools.clear();
  }
}

export const codexTurnManager = new CodexTurnManager();
