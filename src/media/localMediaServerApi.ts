// Server-backed local media for a browser-hosted editor (issue #185). The
// desktop renderer uses its Electron IPC bridge; a plain browser tab has none,
// so the Agent's browse_local_media and import_* tools call these same-origin
// endpoints, which run the identical core under an explicit AGENT_IMPORT_ROOTS
// allowlist (server/plugins/local-media.ts).
import type { AgentLocalMediaRequest, AgentLocalMediaResult } from '../../shared/agent-local-media';
import type { AgentPathImportRequest, AgentPathImportResult } from '../../shared/directory-import';

const BROWSE_URL = '/api/local-media/browse';
const IMPORT_URL = '/api/local-media/import';

/**
 * `code` mirrors the desktop IPC error contract (IMPORT_ROOTS_NOT_CONFIGURED,
 * PATH_OUTSIDE_IMPORT_ROOTS) so the model sees the same actionable shape from
 * either host instead of a bare message.
 */
function requestError(payload: { error?: unknown; code?: unknown } | null, status: number): Error {
  const message = typeof payload?.error === 'string' && payload.error
    ? payload.error
    : `local media request failed with HTTP ${status}`;
  return typeof payload?.code === 'string' && payload.code
    ? Object.assign(new Error(message), { code: payload.code })
    : new Error(message);
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => null) as
    (T & { error?: unknown; code?: unknown }) | null;
  if (!response.ok) throw requestError(payload, response.status);
  if (!payload) throw new Error(`local media request to ${url} returned no body`);
  return payload;
}

export function browseLocalMediaOverHttp(
  request: AgentLocalMediaRequest,
): Promise<AgentLocalMediaResult> {
  return postJson<AgentLocalMediaResult>(BROWSE_URL, request);
}

export function importAgentPathsOverHttp(
  request: AgentPathImportRequest,
): Promise<AgentPathImportResult> {
  return postJson<AgentPathImportResult>(IMPORT_URL, request);
}
