import type {
  ProjectStoreRequest,
  ProjectStoreResponse,
} from '../../shared/project-store-transport';

const API_PATH = '/api/project-store';
const LAUNCH_TOKEN_HEADER = 'X-OpenChatCut-Editor-Launch-Token';
const SESSION_HEADER = 'X-OpenChatCut-Project-Store-Session';
const TOKEN_FRAGMENT_KEY = 'openchatcut-editor-token';
const SESSION_STORAGE_KEY = 'openchatcut.projectStoreSession';
const LAUNCH_STORAGE_KEY = 'openchatcut.projectStoreLaunchToken';
let launchToken: string | null | undefined;
let sessionToken: string | null | undefined;
let sessionPromise: Promise<string> | null = null;
const browserOwnerships = new Map<string, BrowserProjectOwnership>();

interface StoredSession {
  token: string;
}

interface DesktopProjectStoreTransport {
  projectStore(request: ProjectStoreRequest): Promise<ProjectStoreResponse>;
}

export interface BrowserProjectOwnership {
  readonly projectId: string;
  readonly ownerId: string;
  readonly epoch: number;
  readonly baseRevision: string;
  readonly registrationCapability: string;
}

export function installBrowserProjectOwnership(ownership: BrowserProjectOwnership): void {
  browserOwnerships.set(ownership.projectId, ownership);
}

export function browserProjectOwnership(projectId: string): BrowserProjectOwnership | undefined {
  return browserOwnerships.get(projectId);
}

export function advanceBrowserProjectOwnership(
  ownership: BrowserProjectOwnership,
  baseRevision: string,
): BrowserProjectOwnership | undefined {
  const current = browserOwnerships.get(ownership.projectId);
  if (current?.ownerId !== ownership.ownerId || current.epoch !== ownership.epoch) return undefined;
  const advanced = { ...current, baseRevision };
  browserOwnerships.set(ownership.projectId, advanced);
  return advanced;
}

export function clearBrowserProjectOwnership(ownership: BrowserProjectOwnership): void {
  const current = browserOwnerships.get(ownership.projectId);
  if (current?.ownerId === ownership.ownerId && current.epoch === ownership.epoch) {
    browserOwnerships.delete(ownership.projectId);
  }
}

function desktopTransport(): DesktopProjectStoreTransport | undefined {
  if (typeof window === 'undefined') return undefined;
  const desktopWindow = window as typeof window & {
    openChatCutDesktop?: DesktopProjectStoreTransport;
  };
  return desktopWindow.openChatCutDesktop;
}

function removeLaunchFragment(params: URLSearchParams): void {
  if (!params.has(TOKEN_FRAGMENT_KEY)) return;
  params.delete(TOKEN_FRAGMENT_KEY);
  const suffix = params.toString();
  try {
    history.replaceState(history.state, '', `${location.pathname}${location.search}${suffix ? `#${suffix}` : ''}`);
  } catch {
    // The in-memory token remains usable if history is unavailable.
  }
}

function rememberLaunchToken(token: string): void {
  launchToken = token;
  try {
    sessionStorage.setItem(LAUNCH_STORAGE_KEY, token);
  } catch {
    // The in-memory launch credential remains usable for this page lifetime.
  }
  try {
    localStorage.setItem(LAUNCH_STORAGE_KEY, token);
  } catch {
    // Persistence across tabs is best-effort; the session storage copy
    // keeps this tab alive either way.
  }
}

function readStoredLaunchToken(): string | null {
  try {
    const tabScoped = sessionStorage.getItem(LAUNCH_STORAGE_KEY)?.trim() ?? '';
    if (tabScoped.length >= 32) return tabScoped;
  } catch {
    // Privacy-restricted environments may not expose storage.
  }
  try {
    const persistent = localStorage.getItem(LAUNCH_STORAGE_KEY)?.trim() ?? '';
    if (persistent.length >= 32) return persistent;
  } catch {
    // Non-browser environments have no persistent storage.
  }
  return null;
}

// The URL fragment is the only place a fresh launch credential can arrive
// (vite opens /#openchatcut-editor-token=...). Consume it as early as
// possible: the hash router may rewrite the URL before the first write
// request triggers ensureHttpSession.
if (typeof location !== 'undefined' && typeof history !== 'undefined' && typeof window !== 'undefined') {
  try {
    const params = new URLSearchParams(location.hash.startsWith('#') ? location.hash.slice(1) : '');
    const candidate = params.get(TOKEN_FRAGMENT_KEY)?.trim() ?? '';
    if (candidate.length >= 32) rememberLaunchToken(candidate);
  } catch {
    // Non-browser environments leave the fragment for the first consume.
  }
}

function consumeLaunchToken(): string | null {
  // Cache only SUCCESSFUL lookups: a failed read must not poison later
  // attempts (e.g. a token stored by another tab after this one booted).
  if (launchToken !== undefined) return launchToken;
  const stored = readStoredLaunchToken();
  if (stored) {
    launchToken = stored;
    return launchToken;
  }
  if (typeof location === 'undefined' || typeof history === 'undefined') return null;
  const params = new URLSearchParams(location.hash.startsWith('#') ? location.hash.slice(1) : '');
  const candidate = params.get(TOKEN_FRAGMENT_KEY)?.trim() ?? '';
  if (candidate.length >= 32) rememberLaunchToken(candidate);
  removeLaunchFragment(params);
  return launchToken ?? null;
}

function loadStoredSession(): string | null {
  // Cache only SUCCESSFUL lookups (same reasoning as consumeLaunchToken).
  if (sessionToken !== undefined) return sessionToken;
  if (typeof sessionStorage === 'undefined') return null;
  try {
    const parsed: unknown = JSON.parse(sessionStorage.getItem(SESSION_STORAGE_KEY) ?? 'null');
    if (parsed && typeof parsed === 'object') {
      const value = parsed as Partial<StoredSession>;
      if (typeof value.token === 'string' && value.token.length >= 32) {
        sessionToken = value.token;
        return sessionToken;
      }
      sessionStorage.removeItem(SESSION_STORAGE_KEY);
    }
  } catch {
    sessionStorage.removeItem(SESSION_STORAGE_KEY);
  }
  return null;
}

function clearStoredSession(expected?: string): void {
  if (expected && loadStoredSession() !== expected) return;
  sessionToken = null;
  try {
    sessionStorage.removeItem(SESSION_STORAGE_KEY);
  } catch {
    // The in-memory session is still cleared.
  }
}

async function exchangeLaunchToken(): Promise<string> {
  const token = consumeLaunchToken();
  if (!token) {
    throw new Error(
      'project store HTTP transport is unavailable (editor launch credential missing; reopen the editor from its launcher link)',
    );
  }
  const response = await fetch(`${API_PATH}/session`, {
    method: 'POST',
    cache: 'no-store',
    headers: { [LAUNCH_TOKEN_HEADER]: token },
  });
  if (!response.ok) throw new Error(`project store session exchange failed: ${response.status}`);
  const value: unknown = await response.json();
  if (!value || typeof value !== 'object') throw new Error('invalid project store session response');
  const session = value as Partial<{ sessionToken: string }>;
  if (typeof session.sessionToken !== 'string' || session.sessionToken.length < 32) {
    throw new Error('invalid project store session response');
  }
  sessionToken = session.sessionToken;
  try {
    sessionStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify({
      token: session.sessionToken,
    } satisfies StoredSession));
  } catch {
    // The in-memory session remains valid for this page lifetime.
  }
  return session.sessionToken;
}

async function refreshHttpSession(staleSession: string): Promise<string> {
  const current = loadStoredSession();
  if (current && current !== staleSession) return current;
  clearStoredSession(staleSession);
  sessionPromise ??= exchangeLaunchToken().finally(() => { sessionPromise = null; });
  return sessionPromise;
}

async function ensureHttpSession(): Promise<string> {
  const existing = loadStoredSession();
  if (existing) return existing;
  sessionPromise ??= exchangeLaunchToken().finally(() => { sessionPromise = null; });
  return sessionPromise;
}

function withSessionHeader(init: RequestInit | undefined, session: string): RequestInit {
  const headers = new Headers(init?.headers);
  headers.set(SESSION_HEADER, session);
  return { ...init, headers };
}

async function fetchWithSession(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  required: boolean,
): Promise<Response> {
  let session: string | null = null;
  try {
    session = await ensureHttpSession();
  } catch (error) {
    if (required) throw error;
  }
  let response = await fetch(input, session ? withSessionHeader(init, session) : init);
  if (!session || (response.status !== 401 && response.status !== 403)
    || consumeLaunchToken() === null) return response;
  try {
    session = await refreshHttpSession(session);
    response = await fetch(input, withSessionHeader(init, session));
  } catch {
    // Preserve the original authorization response when renewal is unavailable.
  }
  return response;
}

export function fetchWithEditorSession(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  return fetchWithSession(input, init, true);
}

function httpAvailable(): boolean {
  // Any loopback http(s) page may READ the shared library (server allows
  // sessionless loopback-origin reads). Writes still need a session.
  return typeof location !== 'undefined'
    && (location.protocol === 'http:' || location.protocol === 'https:');
}

/** Whether this origin holds a WRITE credential for the shared library. */
export function projectStoreWriteCredential(): boolean {
  return !!desktopTransport()
    || (typeof location !== 'undefined'
      && (location.protocol === 'http:' || location.protocol === 'https:')
      && (loadStoredSession() !== null || consumeLaunchToken() !== null));
}

export function projectStoreRemoteAvailable(): boolean {
  return !!desktopTransport() || httpAvailable();
}

function postJson(
  init: RequestInit,
  headers: Record<string, string>,
  value: unknown,
): RequestInit {
  headers['Content-Type'] = 'application/json';
  return { ...init, method: 'POST', body: JSON.stringify(value) };
}

async function requestHttp(request: ProjectStoreRequest): Promise<ProjectStoreResponse> {
  const headers: Record<string, string> = {};
  let path = '';
  let init: RequestInit = { cache: 'no-store', headers };
  switch (request.operation) {
    case 'snapshot':
      break;
    case 'entry':
      path = `/entry?key=${encodeURIComponent(request.key)}`;
      break;
    case 'merge':
      path = '/merge';
      init = postJson(init, headers, { entries: request.entries });
      break;
    case 'agent-runtime-cas':
      path = '/agent-runtime/cas';
      init = postJson(init, headers, request);
      break;
    case 'project-document-cas':
      path = '/project-document/cas';
      init = postJson(init, headers, request);
      break;
    case 'agent-run-lease':
      path = '/agent-runtime/lease';
      init = postJson(init, headers, request);
      break;
    case 'set':
      path = '/entry';
      headers['Content-Type'] = 'application/json';
      init = { ...init, method: 'PUT', body: JSON.stringify({ key: request.key, value: request.value }) };
      break;
    case 'delete':
      path = `/entry?key=${encodeURIComponent(request.key)}`;
      init = { ...init, method: 'DELETE' };
      break;
    case 'purge-project':
      path = '/project/purge';
      init = postJson(init, headers, request);
      break;
  }
  const response = await fetchWithSession(`${API_PATH}${path}`, init, false);
  if (!response.ok) {
    throw Object.assign(new Error(`project store request failed: ${response.status}`), { status: response.status });
  }
  return response.json() as Promise<ProjectStoreResponse>;
}

export async function requestProjectStore(
  request: ProjectStoreRequest,
): Promise<ProjectStoreResponse> {
  const desktop = desktopTransport();
  return desktop ? desktop.projectStore(request) : requestHttp(request);
}


export function resetProjectStoreTransport(): void {
  launchToken = undefined;
  sessionToken = undefined;
  sessionPromise = null;
  browserOwnerships.clear();
  try {
    sessionStorage.removeItem(SESSION_STORAGE_KEY);
    sessionStorage.removeItem(LAUNCH_STORAGE_KEY);
  } catch {
    // Test or privacy-restricted environments may not expose storage.
  }
}
