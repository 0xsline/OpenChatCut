import assert from 'node:assert/strict';
import {
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
      assert.equal(new Headers(init?.headers).get('X-OpenChatCut-Editor-Launch-Token'), launch);
      return Response.json({ sessionToken: session, expiresAt: Date.now() + 60_000 });
    }
    assert.equal(new Headers(init?.headers).get('X-OpenChatCut-Project-Store-Session'), session);
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
  assert.equal(globals.location.hash, '', 'launch credential must be removed from the visible URL');

  resetProjectStoreTransport();
  globals.location.hash = '';
  // No credential: the shared library stays reachable for READS (sessionless
  // loopback-origin reads keep other dev ports consistent), but writes must
  // not be attempted without a credential.
  assert.equal(projectStoreRemoteAvailable(), true,
    'http pages may read the shared library without a session credential');
  assert.equal(projectStoreWriteCredential(), false,
    'write credential is absent without a session or launch token');
} finally {
  globalThis.fetch = originalFetch;
  globals.window = originalWindow;
  globals.location = originalLocation;
  globals.history = originalHistory;
  globals.sessionStorage = originalSessionStorage;
  resetProjectStoreTransport();
}

console.log('project store renderer transport verification passed');
