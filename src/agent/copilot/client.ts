import type {
  CopilotAgentModelsResponse,
  CopilotAgentStatus,
  CopilotToolResultRequest,
} from '../../../shared/copilot-agent';
import type { CopilotAuthState } from '../../../shared/copilot-auth';

const STATUS_TIMEOUT_MS = 30_000;

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

function requestSignal(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(STATUS_TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

export function fetchCopilotStatus(signal?: AbortSignal): Promise<CopilotAgentStatus> {
  return requestJson<CopilotAgentStatus>('/api/copilot/status', {
    signal: requestSignal(signal),
  });
}

export function fetchCopilotModels(signal?: AbortSignal): Promise<CopilotAgentModelsResponse> {
  return requestJson<CopilotAgentModelsResponse>('/api/copilot/models', {
    signal: requestSignal(signal),
  });
}

export function fetchCopilotAuth(signal?: AbortSignal): Promise<CopilotAuthState> {
  return requestJson<CopilotAuthState>('/api/copilot/auth', {
    cache: 'no-store',
    signal: requestSignal(signal),
  });
}

export function startCopilotAuth(signal?: AbortSignal): Promise<CopilotAuthState> {
  return requestJson<CopilotAuthState>('/api/copilot/auth/start', postJson({}, requestSignal(signal)));
}

export function cancelCopilotAuth(id: string, signal?: AbortSignal): Promise<CopilotAuthState> {
  return requestJson<CopilotAuthState>('/api/copilot/auth/cancel', postJson({ id }, requestSignal(signal)));
}

export function logoutCopilotAuth(signal?: AbortSignal): Promise<CopilotAuthState> {
  return requestJson<CopilotAuthState>('/api/copilot/auth/logout', postJson({}, requestSignal(signal)));
}

export function submitCopilotToolResult(result: CopilotToolResultRequest): Promise<void> {
  return requestVoid('/api/copilot/tool-result', postJson(result));
}
