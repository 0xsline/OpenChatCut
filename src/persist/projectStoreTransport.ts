import type {
  ProjectStoreRequest,
  ProjectStoreResponse,
} from '../../shared/project-store-transport';

const API_PATH = '/api/project-store';
const browserOwnerships = new Map<string, BrowserProjectOwnership>();
const PROJECT_OWNERSHIP_READY_TIMEOUT_MS = 15_000;
const browserOwnershipWaiters = new Map<string, Set<BrowserProjectOwnershipWaiter>>();

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

interface BrowserProjectOwnershipWaiter {
  resolve: (ownership: BrowserProjectOwnership | undefined) => void;
  timeout: ReturnType<typeof setTimeout>;
}

function resolveBrowserProjectOwnershipWaiters(
  projectId: string,
  ownership: BrowserProjectOwnership | undefined,
): void {
  const waiters = browserOwnershipWaiters.get(projectId);
  if (!waiters) return;
  browserOwnershipWaiters.delete(projectId);
  for (const waiter of waiters) {
    clearTimeout(waiter.timeout);
    waiter.resolve(ownership);
  }
}

export function installBrowserProjectOwnership(ownership: BrowserProjectOwnership): void {
  browserOwnerships.set(ownership.projectId, ownership);
  resolveBrowserProjectOwnershipWaiters(ownership.projectId, ownership);
}

export function browserProjectOwnership(projectId: string): BrowserProjectOwnership | undefined {
  return browserOwnerships.get(projectId);
}

export function waitForBrowserProjectOwnership(
  projectId: string,
  timeoutMs = PROJECT_OWNERSHIP_READY_TIMEOUT_MS,
): Promise<BrowserProjectOwnership | undefined> {
  const current = browserOwnerships.get(projectId);
  if (current) return Promise.resolve(current);
  return new Promise((resolve) => {
    const waiters = browserOwnershipWaiters.get(projectId) ?? new Set();
    let waiter: BrowserProjectOwnershipWaiter;
    const timeout = setTimeout(() => {
      waiters.delete(waiter);
      if (waiters.size === 0) browserOwnershipWaiters.delete(projectId);
      resolve(browserOwnerships.get(projectId));
    }, timeoutMs);
    waiter = { resolve, timeout };
    waiters.add(waiter);
    browserOwnershipWaiters.set(projectId, waiters);
  });
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

function httpAvailable(): boolean {
  // Any loopback http(s) page may use the shared library: the server
  // authorizes loopback requests by Origin/Sec-Fetch-Site alone.
  return typeof location !== 'undefined'
    && (location.protocol === 'http:' || location.protocol === 'https:');
}

/** Whether this origin may WRITE to the shared library (loopback editor tab
 *  or the desktop shell). The server enforces the request shape itself. */
export function projectStoreWriteCredential(): boolean {
  return !!desktopTransport() || httpAvailable();
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
    case 'agent-session-rotate':
      path = '/agent-session/rotate';
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
    case 'export-recovery-lease':
      path = '/export-recovery/lease';
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
    case 'semantic-vectors-upsert':
      path = '/semantic-vectors/upsert';
      init = postJson(init, headers, request);
      break;
    case 'semantic-vectors-search':
      path = '/semantic-vectors/search';
      init = postJson(init, headers, request);
      break;
    case 'semantic-vectors-prune':
      path = '/semantic-vectors/prune';
      init = postJson(init, headers, request);
      break;
    case 'semantic-vectors-clear':
      path = '/semantic-vectors/clear';
      init = postJson(init, headers, request);
      break;
  }
  const response = await fetch(`${API_PATH}${path}`, init);
  if (!response.ok) {
    let details: { error?: string; code?: string; run?: unknown } = {};
    try {
      const value: unknown = await response.json();
      if (value && typeof value === 'object') details = value as typeof details;
    } catch {
      // Non-JSON responses retain the status-only fallback below.
    }
    const message = typeof details.error === 'string'
      ? details.error
      : `project store request failed: ${response.status}`;
    throw Object.assign(new Error(message), {
      status: response.status,
      code: details.code,
      run: details.run,
    });
  }
  return response.json() as Promise<ProjectStoreResponse>;
}

export async function requestProjectStore(
  request: ProjectStoreRequest,
): Promise<ProjectStoreResponse> {
  const desktop = desktopTransport();
  return desktop ? desktop.projectStore(request) : requestHttp(request);
}

/** Fetch helper for editor-side HTTP endpoints (bootstrap, storage
 *  migration). The server authorizes by loopback request shape; no session
 *  header is attached. */
export function fetchWithEditorSession(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  return fetch(input, { ...init, cache: 'no-store' });
}

export function resetProjectStoreTransport(): void {
  browserOwnerships.clear();
  for (const projectId of browserOwnershipWaiters.keys()) {
    resolveBrowserProjectOwnershipWaiters(projectId, undefined);
  }
}
