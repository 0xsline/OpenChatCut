import type {
  ClaudeCodeAgentModelsResponse,
  ClaudeCodeAgentStatus,
} from '../../../shared/claude-code-agent';

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

export function fetchClaudeCodeStatus(): Promise<ClaudeCodeAgentStatus> {
  return requestJson<ClaudeCodeAgentStatus>('/api/claude-code/status');
}

export function fetchClaudeCodeModels(): Promise<ClaudeCodeAgentModelsResponse> {
  return requestJson<ClaudeCodeAgentModelsResponse>('/api/claude-code/models');
}
