import assert from 'node:assert/strict';
import {
  editorBootstrapInfo,
  invalidateEditorBootstrapInfo,
} from '../agent/editor-credential.ts';
import {
  fetchWithEditorSession,
  projectStoreRemoteAvailable,
  projectStoreWriteCredential,
  requestProjectStore,
  resetProjectStoreTransport,
} from './projectStoreTransport.ts';

interface TestGlobals {
  history: { state: unknown; replaceState(state: unknown, title: string, url?: string | URL | null): void };
  location: { hash: string; pathname: string; protocol: string; search: string };
  sessionStorage: Storage;
  window: {
    openChatCutDesktop?: {
      projectStore(request: unknown): Promise<unknown>;
      editorCredentials?(): Promise<{ credential: string; mcpToken: string }>;
    };
  };
}
const globals = globalThis as unknown as TestGlobals;
const originalFetch = globalThis.fetch;
const originalWindow = globals.window;
const originalLocation = globals.location;
const originalHistory = globals.history;
const originalSessionStorage = globals.sessionStorage;

const stored = new Map<string, string>();
const storage: Storage = {
  get length() { return stored.size; },
  clear: () => stored.clear(),
  getItem: (key) => stored.get(key) ?? null,
  key: (index) => [...stored.keys()][index] ?? null,
  removeItem: (key) => { stored.delete(key); },
  setItem: (key, value) => { stored.set(key, value); },
};

try {
  let ipcRequest: unknown;
  globals.window = {
    openChatCutDesktop: {
      projectStore: async (request: unknown) => {
        ipcRequest = request;
        return { found: true, value: 'ipc' };
      },
    },
  };
  globals.location = { hash: '', pathname: '/', protocol: 'http:', search: '' };
  globals.history = { state: null, replaceState: () => undefined };
  globals.sessionStorage = storage;
  globalThis.fetch = async () => { throw new Error('HTTP must not run when desktop IPC is available'); };
  resetProjectStoreTransport();
  assert.equal(projectStoreRemoteAvailable(), true);
  assert.deepEqual(await requestProjectStore({ operation: 'entry', key: 'projects' }), {
    found: true,
    value: 'ipc',
  });
  assert.deepEqual(ipcRequest, { operation: 'entry', key: 'projects' });

  const launch = 'launch-'.padEnd(48, 'x');
  const session = 'session-'.padEnd(48, 'y');
  const renewedSession = 'renewed-session-'.padEnd(48, 'z');
  let rejectSessionOnce = false;
  let exchangeCount = 0;
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  globals.window = {};
  globals.location = {
    hash: `#openchatcut-editor-token=${launch}`,
    pathname: '/',
    protocol: 'http:',
    search: '',
  };
  globals.history = {
    state: null,
    replaceState: (_state, _title, url) => { globals.location.hash = String(url ?? '').split('#')[1] ?? ''; },
  };
  stored.clear();
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.endsWith('/session')) {
      const headers = new Headers(init?.headers);
      assert.equal(headers.get('X-OpenChatCut-Editor-Launch-Token'), launch);
      exchangeCount += 1;
      assert.equal(headers.get('X-OpenChatCut-Project-Store-Session'), null);
      return Response.json({
        sessionToken: exchangeCount === 1 ? session : renewedSession,
      });
    }
    const presented = new Headers(init?.headers).get('X-OpenChatCut-Project-Store-Session');
    if (rejectSessionOnce && presented === session) {
      rejectSessionOnce = false;
      return Response.json({ error: 'invalid project store session' }, { status: 403 });
    }
    assert.equal(presented, exchangeCount > 1 ? renewedSession : session);
    return Response.json({ found: true, value: 'http' });
  };
  resetProjectStoreTransport();
  assert.equal(projectStoreRemoteAvailable(), true);
  assert.deepEqual(await requestProjectStore({ operation: 'entry', key: 'projects' }), {
    found: true,
    value: 'http',
  });
  assert.equal(calls.length, 2, 'first HTTP request should exchange once then access the store');
  await requestProjectStore({ operation: 'entry', key: 'projects' });
  assert.equal(calls.length, 3, 'subsequent requests must reuse the editor session');
  await requestProjectStore({ operation: 'purge-project', projectId: 'project-to-purge' });
  assert.equal(calls.length, 4, 'project purge sends one value-free request without fetching a snapshot');
  const purgeCall = calls.at(-1);
  assert.equal(purgeCall?.url, '/api/project-store/project/purge');
  assert.equal(purgeCall?.init?.method, 'POST');
  assert.deepEqual(JSON.parse(String(purgeCall?.init?.body)), {
    operation: 'purge-project',
    projectId: 'project-to-purge',
  });
  assert.equal(globals.location.hash, '', 'launch credential must be removed from the visible URL');
  assert.equal(stored.get('openchatcut.projectStoreLaunchToken'), launch,
    'the launch credential must remain tab-scoped for server restart recovery');
  rejectSessionOnce = true;
  const recovered = await fetchWithEditorSession('/api/external-agent/bootstrap', { method: 'POST' });
  assert.equal(recovered.status, 200);
  assert.equal(calls.length, 7,
    'a rejected stale session must exchange once and retry the original request once');
  await requestProjectStore({ operation: 'entry', key: 'projects' });
  assert.equal(calls.length, 8, 'project-store requests must reuse the renewed session');

  resetProjectStoreTransport();
  globals.location.hash = '';
  // No credential: the shared library stays reachable for READS (sessionless
  // loopback-origin reads keep other dev ports consistent), but writes must
  // not be attempted without a credential.
  assert.equal(projectStoreRemoteAvailable(), true,
    'http pages may read the shared library without a session credential');
  assert.equal(projectStoreWriteCredential(), false,
    'write credential is absent without a session or launch token');

  let credentialCalls = 0;
  const credentials = [
    { credential: 'editor-credential-one', mcpToken: 'mcp-token-one' },
    { credential: 'editor-credential-two', mcpToken: 'mcp-token-two' },
  ];
  globals.window = {
    openChatCutDesktop: {
      projectStore: async () => ({ found: false }),
      editorCredentials: async () => credentials[Math.min(credentialCalls++, 1)],
    },
  };
  const firstCredential = await editorBootstrapInfo();
  assert.deepEqual(await editorBootstrapInfo(), firstCredential);
  assert.equal(credentialCalls, 1, 'editor bootstrap credentials should remain cached normally');
  invalidateEditorBootstrapInfo('different-credential');
  assert.deepEqual(await editorBootstrapInfo(), firstCredential);
  assert.equal(credentialCalls, 1, 'an unrelated failure must not evict a newer credential');
  invalidateEditorBootstrapInfo(firstCredential.credential);
  assert.deepEqual(await editorBootstrapInfo(), credentials[1]);
  assert.equal(credentialCalls, 2, 'a rejected bridge credential must bootstrap again');
} finally {
  globalThis.fetch = originalFetch;
  globals.window = originalWindow;
  globals.location = originalLocation;
  globals.history = originalHistory;
  globals.sessionStorage = originalSessionStorage;
  resetProjectStoreTransport();
}

console.log('project store renderer transport verification passed');
