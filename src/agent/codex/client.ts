import type {
  CodexAgentModelsResponse,
  CodexAgentStatus,
  CodexLoginMode,
  CodexLoginStartResponse,
  CodexToolResultRequest,
  CodexTurnRequest,
  CodexTurnStreamEvent,
} from '../../../shared/codex-agent';

const MAX_NDJSON_LINE_BYTES = 1024 * 1024;

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function optionalTokenCount(value: unknown): boolean {
  return value === undefined
    || (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0);
}


function isStreamEvent(value: unknown): value is CodexTurnStreamEvent {
  if (!isRecord(value) || typeof value.type !== 'string') return false;
  if (value.type === 'text-delta' || value.type === 'thinking-delta') {
    return typeof value.delta === 'string';
  }
  if (value.type === 'tool-start') {
    return typeof value.callId === 'string' && typeof value.name === 'string' && 'args' in value;
  }
  if (value.type === 'tool-end') {
    return typeof value.callId === 'string'
      && typeof value.name === 'string'
      && 'args' in value
      && 'result' in value
      && typeof value.success === 'boolean';
  }
  if (value.type === 'context-usage') {
    const contextWindow = value.contextWindowTokens;
    return typeof value.inputTokens === 'number'
      && Number.isSafeInteger(value.inputTokens)
      && value.inputTokens >= 0
      && optionalTokenCount(value.outputTokens)
      && optionalTokenCount(value.reasoningTokens)
      && optionalTokenCount(value.cacheReadTokens)
      && optionalTokenCount(value.noCacheInputTokens)
      && (contextWindow === undefined
        || (typeof contextWindow === 'number' && Number.isSafeInteger(contextWindow)
          && contextWindow > 0));
  }
  if (value.type === 'error') return typeof value.message === 'string';
  return value.type === 'done';
}

function parseStreamLine(line: string): CodexTurnStreamEvent {
  if (!line.trim()) throw new Error('Malformed Codex stream: empty NDJSON line.');
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    throw new Error('Malformed Codex stream: invalid JSON.');
  }
  if (!isStreamEvent(parsed)) throw new Error('Malformed Codex stream: invalid event.');
  return parsed;
}

async function responseError(response: Response): Promise<Error> {
  let message = '';
  try {
    const body = await response.json() as { error?: unknown };
    if (typeof body.error === 'string') message = body.error.trim();
  } catch {
    // The status text below remains useful when an upstream proxy returns HTML.
  }
  return new Error(message || `${response.status} ${response.statusText || 'Request failed'}`);
}

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  if (!response.ok) throw await responseError(response);
  try {
    return await response.json() as T;
  } catch {
    throw new Error(`Invalid JSON response from ${path}.`);
  }
}

async function requestVoid(path: string, init: RequestInit): Promise<void> {
  const response = await fetch(path, init);
  if (!response.ok) throw await responseError(response);
}

function postJson(body?: unknown, signal?: AbortSignal): RequestInit {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    ...(signal ? { signal } : {}),
  };
}

export function fetchCodexStatus(): Promise<CodexAgentStatus> {
  return requestJson<CodexAgentStatus>('/api/codex/status');
}

export function fetchCodexModels(): Promise<CodexAgentModelsResponse> {
  return requestJson<CodexAgentModelsResponse>('/api/codex/models');
}

export function startCodexLogin(mode: CodexLoginMode): Promise<CodexLoginStartResponse> {
  return requestJson<CodexLoginStartResponse>('/api/codex/login/start', postJson({ mode }));
}

export function cancelCodexLogin(loginId?: string): Promise<void> {
  return requestVoid('/api/codex/login/cancel', postJson(loginId ? { loginId } : {}));
}

export function logoutCodex(): Promise<void> {
  return requestVoid('/api/codex/logout', postJson());
}
export function submitCodexToolResult(result: CodexToolResultRequest): Promise<void> {
  return requestVoid('/api/codex/tool-result', postJson(result));
}


async function consumeNdjson(
  body: ReadableStream<Uint8Array>,
  onEvent: (event: CodexTurnStreamEvent) => void | Promise<void>,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let line = '';
  let lineBytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      let start = 0;
      for (let index = 0; index <= value.length; index += 1) {
        if (index < value.length && value[index] !== 10) continue;
        const segment = value.subarray(start, index);
        lineBytes += segment.byteLength;
        if (lineBytes > MAX_NDJSON_LINE_BYTES) throw new Error('Codex stream line exceeds the 1 MiB limit.');
        line += decoder.decode(segment, { stream: true });
        if (index === value.length) break;
        line += decoder.decode();
        await onEvent(parseStreamLine(line.endsWith('\r') ? line.slice(0, -1) : line));
        line = '';
        lineBytes = 0;
        start = index + 1;
      }
    }
    line += decoder.decode();
    if (lineBytes > 0 || line.length > 0) {
      await onEvent(parseStreamLine(line.endsWith('\r') ? line.slice(0, -1) : line));
    }
  } catch (error) {
    await reader.cancel(error).catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
}

export async function runCodexTurn(
  request: CodexTurnRequest,
  onEvent: (event: CodexTurnStreamEvent) => void | Promise<void>,
  signal?: AbortSignal,
): Promise<void> {
  const response = await fetch('/api/codex/turn', postJson(request, signal));
  if (!response.ok) throw await responseError(response);
  if (!response.body) throw new Error('Codex turn returned no response stream.');
  await consumeNdjson(response.body, onEvent);
}
