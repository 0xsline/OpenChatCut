import type {
  ProjectStoreRequest,
  ProjectStoreResponse,
} from '../../shared/project-store-transport';

const API_PATH = '/api/project-store';
const LAUNCH_TOKEN_HEADER = 'X-OpenChatCut-Editor-Launch-Token';
const SESSION_HEADER = 'X-OpenChatCut-Project-Store-Session';
const TOKEN_FRAGMENT_KEY = 'openchatcut-editor-token';
const SESSION_STORAGE_KEY = 'openchatcut.projectStoreSession';
let launchToken: string | null | undefined;
let sessionToken: string | null | undefined;
let sessionPromise: Promise<string> | null = null;

interface StoredSession {
  token: string;
  expiresAt: number;
}

interface DesktopProjectStoreTransport {
  projectStore(request: ProjectStoreRequest): Promise<ProjectStoreResponse>;
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

function consumeLaunchToken(): string | null {
  if (launchToken !== undefined) return launchToken;
  launchToken = null;
  if (typeof location === 'undefined' || typeof history === 'undefined') return null;
  const params = new URLSearchParams(location.hash.startsWith('#') ? location.hash.slice(1) : '');
  const candidate = params.get(TOKEN_FRAGMENT_KEY)?.trim() ?? '';
  if (candidate.length >= 32) launchToken = candidate;
  removeLaunchFragment(params);
  return launchToken;
}

function loadStoredSession(): string | null {
  if (sessionToken !== undefined) return sessionToken;
  sessionToken = null;
  if (typeof sessionStorage === 'undefined') return null;
  try {
    const parsed: unknown = JSON.parse(sessionStorage.getItem(SESSION_STORAGE_KEY) ?? 'null');
    if (parsed && typeof parsed === 'object') {
      const value = parsed as Partial<StoredSession>;
      if (typeof value.token === 'string' && value.token.length >= 32
        && typeof value.expiresAt === 'number' && value.expiresAt > Date.now()) {
        sessionToken = value.token;
      } else {
        sessionStorage.removeItem(SESSION_STORAGE_KEY);
      }
    }
  } catch {
    sessionStorage.removeItem(SESSION_STORAGE_KEY);
  }
  return sessionToken;
}

async function exchangeLaunchToken(): Promise<string> {
  const token = consumeLaunchToken();
  if (!token) throw new Error('project store HTTP transport is unavailable');
  const response = await fetch(`${API_PATH}/session`, {
    method: 'POST',
    cache: 'no-store',
    headers: { [LAUNCH_TOKEN_HEADER]: token },
  });
  launchToken = null;
  if (!response.ok) throw new Error(`project store session exchange failed: ${response.status}`);
  const value: unknown = await response.json();
  if (!value || typeof value !== 'object') throw new Error('invalid project store session response');
  const session = value as Partial<{ sessionToken: string; expiresAt: number }>;
  if (typeof session.sessionToken !== 'string' || session.sessionToken.length < 32
    || typeof session.expiresAt !== 'number' || session.expiresAt <= Date.now()) {
    throw new Error('invalid project store session response');
  }
  sessionToken = session.sessionToken;
  try {
    sessionStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify({
      token: session.sessionToken,
      expiresAt: session.expiresAt,
    } satisfies StoredSession));
  } catch {
    // The in-memory session remains valid for this page lifetime.
  }
  return session.sessionToken;
}

async function ensureHttpSession(): Promise<string> {
  const existing = loadStoredSession();
  if (existing) return existing;
  sessionPromise ??= exchangeLaunchToken().finally(() => { sessionPromise = null; });
  return sessionPromise;
}

function httpAvailable(): boolean {
  return typeof location !== 'undefined'
    && (location.protocol === 'http:' || location.protocol === 'https:')
    && (loadStoredSession() !== null || consumeLaunchToken() !== null);
}

export function projectStoreRemoteAvailable(): boolean {
  return !!desktopTransport() || httpAvailable();
}

async function requestHttp(request: ProjectStoreRequest): Promise<ProjectStoreResponse> {
  const session = await ensureHttpSession();
  const headers: Record<string, string> = { [SESSION_HEADER]: session };
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
      headers['Content-Type'] = 'application/json';
      init = { ...init, method: 'POST', body: JSON.stringify({ entries: request.entries }) };
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
  }
  const response = await fetch(`${API_PATH}${path}`, init);
  if (!response.ok) throw new Error(`project store request failed: ${response.status}`);
  return response.json() as Promise<ProjectStoreResponse>;
}

export async function requestProjectStore(
  request: ProjectStoreRequest,
): Promise<ProjectStoreResponse> {
  const desktop = desktopTransport();
  return desktop ? desktop.projectStore(request) : requestHttp(request);
}

export async function editorSessionCredentialHeaders(headers?: HeadersInit): Promise<Headers> {
  const result = new Headers(headers);
  result.set(SESSION_HEADER, await ensureHttpSession());
  return result;
}

export function resetProjectStoreTransport(): void {
  launchToken = undefined;
  sessionToken = undefined;
  sessionPromise = null;
  try {
    sessionStorage.removeItem(SESSION_STORAGE_KEY);
  } catch {
    // Test or privacy-restricted environments may not expose storage.
  }
}
