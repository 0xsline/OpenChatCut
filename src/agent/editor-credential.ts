import type { EditorBootstrapInfo } from '../../shared/editor-auth-transport';

export const EDITOR_BOOTSTRAP_HEADER = 'X-OpenChatCut-Editor-Bootstrap';
export const EDITOR_TOKEN_HEADER = 'X-OpenChatCut-Editor-Token';
export const EDITOR_AUTH_RESPONSE_HEADER = 'X-OpenChatCut-Editor-Auth';

const BOOTSTRAP_PATH = '/api/external-agent/bootstrap';
const MCP_PATH = '/api/external-mcp/mcp';
const PROTECTED_PREFIXES = [
  '/api',
  '/llm',
  '/assemblyai',
  '/upload',
  '/generate',
  '/export',
  '/render-still',
  '/render-clip',
  '/e2b',
] as const;
const nativeFetch = globalThis.fetch.bind(globalThis);

let cached: EditorBootstrapInfo | null = null;
let pending: Promise<EditorBootstrapInfo> | null = null;

async function requestEditorBootstrap(signal?: AbortSignal): Promise<EditorBootstrapInfo> {
  let value: unknown;
  const desktop = typeof window === 'undefined'
    ? undefined
    : window.openChatCutDesktop?.editorCredentials;
  if (desktop) {
    value = await desktop();
  } else {
    const response = await nativeFetch(BOOTSTRAP_PATH, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        [EDITOR_BOOTSTRAP_HEADER]: '1',
      },
      body: '{}',
      cache: 'no-store',
      credentials: 'same-origin',
      redirect: 'error',
      signal,
    });
    if (!response.ok) throw new Error(`editor bootstrap failed: HTTP ${response.status}`);
    value = await response.json();
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || !('editorToken' in value) || typeof value.editorToken !== 'string' || !value.editorToken
    || ('mcpToken' in value && value.mcpToken !== undefined
      && (typeof value.mcpToken !== 'string' || !value.mcpToken))) {
    throw new Error('editor bootstrap returned invalid credentials');
  }
  return {
    editorToken: value.editorToken,
    ...('mcpToken' in value && typeof value.mcpToken === 'string'
      ? { mcpToken: value.mcpToken }
      : {}),
  };
}

export async function editorBootstrapInfo(signal?: AbortSignal): Promise<EditorBootstrapInfo> {
  if (cached) return cached;
  pending ??= requestEditorBootstrap(signal);
  try {
    cached = await pending;
    return cached;
  } finally {
    pending = null;
  }
}

export function invalidateEditorBootstrapInfo(): void {
  cached = null;
  pending = null;
}

function requestUrl(input: RequestInfo | URL): URL | null {
  if (typeof location === 'undefined') return null;
  try {
    const raw = input instanceof Request ? input.url : input.toString();
    return new URL(raw, location.href);
  } catch {
    return null;
  }
}

function isPathWithin(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

function editorProtectedUrl(input: RequestInfo | URL): boolean {
  const url = requestUrl(input);
  if (!url || url.origin !== location.origin) return false;
  if (url.pathname === BOOTSTRAP_PATH || url.pathname === MCP_PATH) return false;
  if (url.pathname === '/upload' && url.searchParams.has('handoff')) return false;
  return PROTECTED_PREFIXES.some((prefix) => isPathWithin(url.pathname, prefix));
}

/** Return an in-memory editor token only for the browser UI's own upload
 * routes. Presigned provider URLs and single-use external handoffs stay
 * independently authorized. */
export async function editorTokenForUiUpload(
  input: RequestInfo | URL,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const url = requestUrl(input);
  if (!url || url.origin !== location.origin || !isPathWithin(url.pathname, '/upload')
    || (url.pathname === '/upload' && url.searchParams.has('handoff'))) return undefined;
  return (await editorBootstrapInfo(signal)).editorToken;
}

function requestHeaders(input: RequestInfo | URL, init?: RequestInit): Headers {
  const headers = new Headers(input instanceof Request ? input.headers : undefined);
  new Headers(init?.headers).forEach((value, name) => headers.set(name, value));
  return headers;
}

function requestMethod(input: RequestInfo | URL, init?: RequestInit): string {
  return (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
}

async function fetchWithToken(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  editorToken: string,
): Promise<Response> {
  const headers = requestHeaders(input, init);
  headers.set(EDITOR_TOKEN_HEADER, editorToken);
  return nativeFetch(input, { ...init, headers, redirect: 'error' });
}

let fetchInstalled = false;

/** Install before application startup. Credentials remain in module memory and
 * are attached only to privileged same-origin routes, never provider URLs. */
export function installEditorApiFetch(): void {
  if (fetchInstalled) return;
  fetchInstalled = true;
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    if (!editorProtectedUrl(input)) return nativeFetch(input, init);
    const method = requestMethod(input, init);
    const retryInput = (method === 'GET' || method === 'HEAD') && input instanceof Request
      ? input.clone()
      : input;
    const first = await fetchWithToken(
      input,
      init,
      (await editorBootstrapInfo(init?.signal ?? undefined)).editorToken,
    );
    if (first.status !== 401
      || first.headers.get(EDITOR_AUTH_RESPONSE_HEADER) !== 'required') return first;
    invalidateEditorBootstrapInfo();
    if (method !== 'GET' && method !== 'HEAD') return first;
    return fetchWithToken(
      retryInput,
      init,
      (await editorBootstrapInfo(init?.signal ?? undefined)).editorToken,
    );
  };
}
