import type {
  CopilotAgentModelsResponse,
  CopilotAgentStatus,
  CopilotToolResultRequest,
} from '../../../shared/copilot-agent';

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

export function fetchCopilotStatus(): Promise<CopilotAgentStatus> {
  return requestJson<CopilotAgentStatus>('/api/copilot/status');
}

export function fetchCopilotModels(): Promise<CopilotAgentModelsResponse> {
  return requestJson<CopilotAgentModelsResponse>('/api/copilot/models');
}

export function submitCopilotToolResult(result: CopilotToolResultRequest): Promise<void> {
  return requestVoid('/api/copilot/tool-result', postJson(result));
}
