import assert from 'node:assert/strict';

interface TestGlobals {
  history: {
    state: unknown;
    replaceState(state: unknown, title: string, url?: string | URL | null): void;
  };
  localStorage: Storage;
  location: { hash: string; pathname: string; protocol: string; search: string };
  sessionStorage: Storage;
  window: {
    openChatCutDesktop?: {
      projectStore(request: unknown): Promise<unknown>;
      editorCredentials?(): Promise<{ mcpToken: string }>;
    };
  };
}

function mapStorage(values: Map<string, string>): Storage {
  return {
    get length() {
      return values.size;
    },
    clear: () => {
      values.clear();
    },
    getItem: (key) => {
      return values.get(key) ?? null;
    },
    key: (index) => {
      return [...values.keys()][index] ?? null;
    },
    removeItem: (key) => {
      values.delete(key);
    },
    setItem: (key, value) => {
      values.set(key, value);
    },
  };
}

async function loadProjectStoreTransport() {
  // Intentional test boundary: browser globals must predate module evaluation.
  return import('./projectStoreTransport.ts');
}

async function loadEditorCredential() {
  // A static import would transitively evaluate the transport before the browser fixture.
  return import('../agent/editor-credential.ts');
}

const globals = globalThis as unknown as TestGlobals;
const originalFetch = globalThis.fetch;
const originalWindow = globals.window;
const originalLocation = globals.location;
const originalHistory = globals.history;
const originalLocalStorage = globals.localStorage;
const originalSessionStorage = globals.sessionStorage;
const stored = new Map<string, string>();
let resetImportedTransport: (() => void) | undefined;

globals.window = {};
globals.location = {
  hash: '',
  pathname: '/',
  protocol: 'http:',
  search: '',
};
globals.history = {
  state: null,
  replaceState: (_state, _title, url) => {
    const next = String(url ?? '');
    const hashIndex = next.indexOf('#');
    globals.location.hash = hashIndex >= 0 ? next.slice(hashIndex) : '';
  },
};
globals.sessionStorage = mapStorage(stored);
globals.localStorage = mapStorage(new Map<string, string>());
globalThis.fetch = async () => {
  throw new Error('fetch was not configured for this verification step');
};
try {
  // This verifier runs in its own process. Browser globals must exist before
  // this first import so module-initialization is real.
  const transport = await loadProjectStoreTransport();
  const {
    advanceBrowserProjectOwnership,
    browserProjectOwnership,
    clearBrowserProjectOwnership,
    fetchWithEditorSession,
    installBrowserProjectOwnership,
    projectStoreRemoteAvailable,
    projectStoreWriteCredential,
    requestProjectStore,
    resetProjectStoreTransport,
    waitForBrowserProjectOwnership,
  } = transport;
  resetImportedTransport = resetProjectStoreTransport;

  // A loopback editor tab is fully trusted: no token, no session handshake.
  assert.equal(projectStoreWriteCredential(), true,
    'any loopback editor tab holds a write credential');
  assert.equal(projectStoreRemoteAvailable(), true,
    'any loopback editor tab can reach the shared library');

  // HTTP requests must carry no credential headers whatsoever.
  const calls: Array<{ url: string; headers: Headers; init?: RequestInit }> = [];
  const httpFetchMock = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, headers: new Headers(init?.headers), init });
    if (url.endsWith('/entry?key=projects')) {
      return Response.json({ found: true, value: 'http' });
    }
    if (url.endsWith('/entry?key=other')) {
      return Response.json({ found: false });
    }
    return Response.json({ ok: true });
  };
  globalThis.fetch = httpFetchMock;

  assert.deepEqual(await requestProjectStore({ operation: 'entry', key: 'projects' }), {
    found: true,
    value: 'http',
  });
  const writeCall = calls[0];
  for (const name of writeCall.headers.keys()) {
    assert.ok(!/x-openchatcut/i.test(name),
      `requests must not carry credential headers (found ${name})`);
  }
  assert.equal(writeCall.url, '/api/project-store/entry?key=projects');

  // Other operations keep their paths and payloads.
  calls.length = 0;
  await requestProjectStore({ operation: 'merge', entries: { a: '1' } });
  assert.equal(calls[0].url, '/api/project-store/merge');
  assert.equal(calls[0].init?.method, 'POST');
  calls.length = 0;
  await requestProjectStore({ operation: 'purge-project', projectId: 'project-to-purge' });
  assert.equal(calls[0].url, '/api/project-store/project/purge');

  // fetchWithEditorSession is a plain fetch without any session machinery.
  const recovered = await fetchWithEditorSession('/api/external-agent/bootstrap', { method: 'POST' });
  assert.equal(recovered.status, 200);
  assert.equal(calls[calls.length - 1].url, '/api/external-agent/bootstrap');
  for (const name of calls[calls.length - 1].headers.keys()) {
    assert.ok(!/x-openchatcut/i.test(name),
      `editor fetches must not carry credential headers (found ${name})`);
  }

  // Outside a loopback http(s) page nothing claims a write credential.
  globals.location = { hash: '', pathname: '/', protocol: 'file:', search: '' };
  resetProjectStoreTransport();
  assert.equal(projectStoreWriteCredential(), false,
    'non-loopback pages must not claim a write credential');
  assert.equal(projectStoreRemoteAvailable(), false,
    'non-loopback pages have no remote store');
  globals.location = { hash: '', pathname: '/', protocol: 'http:', search: '' };

  // Desktop IPC takes precedence over HTTP when present.
  resetProjectStoreTransport();
  let ipcRequest: unknown;
  globals.window = {
    openChatCutDesktop: {
      projectStore: async (request: unknown) => {
        ipcRequest = request;
        return { found: true, value: 'ipc' };
      },
    },
  };
  globalThis.fetch = async () => {
    throw new Error('HTTP must not run when desktop IPC is available');
  };
  assert.deepEqual(await requestProjectStore({ operation: 'entry', key: 'projects' }), {
    found: true,
    value: 'ipc',
  });
  assert.deepEqual(ipcRequest, { operation: 'entry', key: 'projects' });

  // Editor bootstrap only returns the MCP token (no editor credential).
  const { editorBootstrapInfo, invalidateEditorBootstrapInfo } = await loadEditorCredential();
  let credentialCalls = 0;
  const credentials = [
    { mcpToken: 'mcp-token-one' },
    { mcpToken: 'mcp-token-two' },
  ];
  globals.window = {
    openChatCutDesktop: {
      projectStore: async () => ({ found: false }),
      editorCredentials: async () => credentials[Math.min(credentialCalls++, 1)],
    },
  };
  const firstBootstrap = await editorBootstrapInfo();
  assert.deepEqual(await editorBootstrapInfo(), firstBootstrap);
  assert.equal(credentialCalls, 1, 'bootstrap info should remain cached normally');
  invalidateEditorBootstrapInfo();
  assert.deepEqual(await editorBootstrapInfo(), credentials[1]);
  assert.equal(credentialCalls, 2, 'invalidation must refetch the MCP token');

  // Browser project ownership: install / wait / advance / clear / reset.
  resetProjectStoreTransport();
  const pendingOwnership = waitForBrowserProjectOwnership('project-race', 1_000);
  const installedOwnership = {
    projectId: 'project-race',
    ownerId: 'browser-owner',
    epoch: 1,
    baseRevision: 'v7-initial',
    registrationCapability: 'capability',
  };
  installBrowserProjectOwnership(installedOwnership);
  assert.deepEqual(await pendingOwnership, installedOwnership,
    'a save started during editor registration must resume with installed ownership');
  assert.deepEqual(await waitForBrowserProjectOwnership('project-race', 1), installedOwnership,
    'an existing ownership must be returned without waiting');
  const advanced = advanceBrowserProjectOwnership(installedOwnership, 'v7-next');
  assert.equal(advanced?.baseRevision, 'v7-next',
    'ownership advances with the authoritative base revision');
  assert.equal(advanceBrowserProjectOwnership({ ...installedOwnership, epoch: 2 }, 'v7-stale'), undefined,
    'a stale epoch must not advance ownership');
  assert.equal(browserProjectOwnership('project-race')?.baseRevision, 'v7-next');
  clearBrowserProjectOwnership(installedOwnership);
  assert.equal(browserProjectOwnership('project-race'), undefined,
    'clear removes ownership for the matching owner');
  const resetWait = waitForBrowserProjectOwnership('project-reset', 1_000);
  resetProjectStoreTransport();
  assert.equal(await resetWait, undefined, 'transport reset must settle pending ownership waits');
  assert.equal(browserProjectOwnership('project-reset'), undefined);

  // Reset must not leave any session-like storage behind (nothing is stored).
  assert.equal(stored.size, 0,
    'the transport must never write session or token keys to storage');
} finally {
  resetImportedTransport?.();
  globalThis.fetch = originalFetch;
  globals.window = originalWindow;
  globals.location = originalLocation;
  globals.history = originalHistory;
  globals.localStorage = originalLocalStorage;
  globals.sessionStorage = originalSessionStorage;
}
