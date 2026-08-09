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
      editorCredentials?(): Promise<{ credential: string; mcpToken: string }>;
    };
  };
}

function mapStorage(values: Map<string, string>, accessed = () => undefined): Storage {
  return {
    get length() {
      accessed();
      return values.size;
    },
    clear: () => {
      accessed();
      values.clear();
    },
    getItem: (key) => {
      accessed();
      return values.get(key) ?? null;
    },
    key: (index) => {
      accessed();
      return [...values.keys()][index] ?? null;
    },
    removeItem: (key) => {
      accessed();
      values.delete(key);
    },
    setItem: (key, value) => {
      accessed();
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
const localStored = new Map<string, string>();
const initialLaunch = 'initial-launch-'.padEnd(48, 'x');
let localStorageAccesses = 0;
let scrubCount = 0;
let resetImportedTransport: (() => void) | undefined;

globals.window = {};
globals.location = {
  hash: `#openchatcut-editor-token=${initialLaunch}`,
  pathname: '/',
  protocol: 'http:',
  search: '',
};
globals.history = {
  state: null,
  replaceState: (_state, _title, url) => {
    scrubCount += 1;
    const next = String(url ?? '');
    const hashIndex = next.indexOf('#');
    globals.location.hash = hashIndex >= 0 ? next.slice(hashIndex) : '';
  },
};
stored.set('openchatcut.projectStoreLaunchToken', 'cached-launch-'.padEnd(48, 'c'));
globals.sessionStorage = mapStorage(stored);
globals.localStorage = mapStorage(localStored, () => {
  localStorageAccesses += 1;
});
globalThis.fetch = async () => {
  throw new Error('fetch was not configured for this verification step');
};

try {
  // This verifier runs in its own process. Browser globals and the launch hash
  // must exist before this first import so module-initialization capture is real.
  const transport = await loadProjectStoreTransport();
  const {
    browserProjectOwnership,
    fetchWithEditorSession,
    installBrowserProjectOwnership,
    projectStoreRemoteAvailable,
    projectStoreWriteCredential,
    requestProjectStore,
    resetProjectStoreTransport,
    waitForBrowserProjectOwnership,
  } = transport;
  resetImportedTransport = resetProjectStoreTransport;

  assert.equal(globals.location.hash, '', 'module initialization must scrub the launch fragment');
  assert.equal(scrubCount, 1, 'the launch fragment must be scrubbed immediately');
  assert.equal(stored.get('openchatcut.projectStoreLaunchToken'), initialLaunch,
    'an explicit fragment must replace an already-cached tab launch token');
  assert.equal(projectStoreWriteCredential(), true);
  assert.equal(localStorageAccesses, 0, 'root launch authority must never read or write localStorage');

  const session = 'session-'.padEnd(48, 'y');
  const renewedSession = 'renewed-session-'.padEnd(48, 'z');
  let rejectSessionOnce = false;
  let exchangeCount = 0;
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.endsWith('/session')) {
      const headers = new Headers(init?.headers);
      assert.equal(headers.get('X-OpenChatCut-Editor-Launch-Token'), initialLaunch);
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

  assert.equal(projectStoreRemoteAvailable(), true);
  assert.deepEqual(await requestProjectStore({ operation: 'entry', key: 'projects' }), {
    found: true,
    value: 'http',
  });
  assert.equal(calls.length, 2, 'first HTTP request should exchange once then access the store');
  await requestProjectStore({ operation: 'entry', key: 'projects' });
  assert.equal(calls.length, 3, 'subsequent requests must reuse the editor session');

  await requestProjectStore({ operation: 'agent-session-rotate', projectId: 'project-to-rotate' });
  const rotationCall = calls.at(-1);
  assert.equal(rotationCall?.url, '/api/project-store/agent-session/rotate');
  assert.equal(rotationCall?.init?.method, 'POST');
  assert.deepEqual(JSON.parse(String(rotationCall?.init?.body)), {
    operation: 'agent-session-rotate',
    projectId: 'project-to-rotate',
  });

  await requestProjectStore({ operation: 'purge-project', projectId: 'project-to-purge' });
  const purgeCall = calls.at(-1);
  assert.equal(purgeCall?.url, '/api/project-store/project/purge');
  assert.equal(purgeCall?.init?.method, 'POST');
  assert.deepEqual(JSON.parse(String(purgeCall?.init?.body)), {
    operation: 'purge-project',
    projectId: 'project-to-purge',
  });

  rejectSessionOnce = true;
  const staleCallStart = calls.length;
  const recovered = await fetchWithEditorSession('/api/external-agent/bootstrap', { method: 'POST' });
  assert.equal(recovered.status, 200);
  assert.equal(calls.length - staleCallStart, 3,
    'a rejected stale session must exchange once and retry the original request once');
  await requestProjectStore({ operation: 'entry', key: 'projects' });
  assert.equal(new Headers(calls.at(-1)?.init?.headers).get(
    'X-OpenChatCut-Project-Store-Session',
  ), renewedSession, 'project-store requests must reuse the renewed session');

  resetProjectStoreTransport();
  globals.location.hash = '';
  assert.equal(projectStoreRemoteAvailable(), true,
    'loopback HTTP pages may read the shared library without a credential');
  assert.equal(projectStoreWriteCredential(), false,
    'a bare tab must not gain a project-store write credential');

  const lateLaunch = 'late-launch-'.padEnd(48, 'l');
  globals.location.hash = `#openchatcut-editor-token=${lateLaunch}`;
  assert.equal(projectStoreWriteCredential(), true,
    'an earlier empty lookup must not hide a later explicit launch token');
  assert.equal(globals.location.hash, '', 'late launch fragments must also be scrubbed immediately');
  assert.equal(stored.get('openchatcut.projectStoreLaunchToken'), lateLaunch);

  resetProjectStoreTransport();
  const rejectedLaunch = 'rejected-launch-'.padEnd(48, 'r');
  const rejectedSession = 'rejected-session-'.padEnd(48, 's');
  const replacementLaunch = 'replacement-launch-'.padEnd(48, 'n');
  const replacementSession = 'replacement-session-'.padEnd(48, 'p');
  stored.set('openchatcut.projectStoreSession', JSON.stringify({ token: rejectedSession }));
  globals.location.hash = `#openchatcut-editor-token=${rejectedLaunch}`;
  const recoveryCalls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    recoveryCalls.push({ url, init });
    const headers = new Headers(init?.headers);
    if (url.endsWith('/session')) {
      const presentedLaunch = headers.get('X-OpenChatCut-Editor-Launch-Token');
      if (presentedLaunch === rejectedLaunch) {
        return Response.json({ error: 'rejected launch token' }, { status: 403 });
      }
      assert.equal(presentedLaunch, replacementLaunch);
      return Response.json({ sessionToken: replacementSession });
    }
    const presentedSession = headers.get('X-OpenChatCut-Project-Store-Session');
    if (presentedSession === rejectedSession) {
      return Response.json({ error: 'original authorization response' }, { status: 403 });
    }
    assert.equal(presentedSession, replacementSession);
    return Response.json({ ok: true });
  };

  const rejectedStart = recoveryCalls.length;
  const originalAuthorization = await fetchWithEditorSession('/api/protected');
  assert.equal(originalAuthorization.status, 403);
  assert.deepEqual(await originalAuthorization.json(), { error: 'original authorization response' },
    'failed renewal must preserve the original authorization response');
  assert.equal(recoveryCalls.length - rejectedStart, 2,
    'unavailable renewal must not retry the protected request');
  assert.equal(stored.has('openchatcut.projectStoreLaunchToken'), false,
    'a rejected launch token must be evicted from tab storage');
  assert.equal(stored.has('openchatcut.projectStoreSession'), false,
    'the rejected stale session must be evicted from tab storage');
  assert.equal(projectStoreWriteCredential(), false,
    'rejected credentials must not continue granting apparent write authority');

  globals.location.hash = `#openchatcut-editor-token=${replacementLaunch}`;
  const replacementStart = recoveryCalls.length;
  const replacementResponse = await fetchWithEditorSession('/api/protected');
  assert.equal(replacementResponse.status, 200);
  assert.equal(recoveryCalls.length - replacementStart, 2,
    'a newer explicit token should exchange once and issue the protected request once');
  assert.equal(globals.location.hash, '');
  assert.equal(stored.get('openchatcut.projectStoreLaunchToken'), replacementLaunch);

  resetProjectStoreTransport();
  const concurrentRejectedLaunch = 'concurrent-rejected-'.padEnd(48, 'q');
  const concurrentReplacementLaunch = 'concurrent-replacement-'.padEnd(48, 'w');
  const concurrentSession = 'concurrent-session-'.padEnd(48, 'e');
  let markRejectedExchangeStarted!: () => void;
  let resolveRejectedExchange!: (response: Response) => void;
  const rejectedExchangeStarted = new Promise<void>((resolve) => {
    markRejectedExchangeStarted = resolve;
  });
  const rejectedExchangeResponse = new Promise<Response>((resolve) => {
    resolveRejectedExchange = resolve;
  });
  globals.location.hash = `#openchatcut-editor-token=${concurrentRejectedLaunch}`;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    if (url.endsWith('/session')) {
      const presentedLaunch = headers.get('X-OpenChatCut-Editor-Launch-Token');
      if (presentedLaunch === concurrentRejectedLaunch) {
        markRejectedExchangeStarted();
        return rejectedExchangeResponse;
      }
      assert.equal(presentedLaunch, concurrentReplacementLaunch);
      return Response.json({ sessionToken: concurrentSession });
    }
    assert.equal(headers.get('X-OpenChatCut-Project-Store-Session'), concurrentSession);
    return Response.json({ ok: true });
  };

  const rejectedConcurrentRequest = fetchWithEditorSession('/api/concurrent-protected');
  await rejectedExchangeStarted;
  globals.location.hash = `#openchatcut-editor-token=${concurrentReplacementLaunch}`;
  assert.equal(projectStoreWriteCredential(), true,
    'a newer explicit token must be captured while an older exchange is pending');
  assert.equal(globals.location.hash, '');
  resolveRejectedExchange(Response.json({ error: 'rejected launch token' }, { status: 403 }));
  await assert.rejects(
    rejectedConcurrentRequest,
    /project store session exchange failed: 403/,
  );
  assert.equal(stored.get('openchatcut.projectStoreLaunchToken'), concurrentReplacementLaunch,
    'an older rejected exchange must not evict a concurrently captured newer token');
  const concurrentRecovery = await fetchWithEditorSession('/api/concurrent-protected');
  assert.equal(concurrentRecovery.status, 200);

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

  const {
    editorBootstrapInfo,
    invalidateEditorBootstrapInfo,
  } = await loadEditorCredential();
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
  const resetWait = waitForBrowserProjectOwnership('project-reset', 1_000);
  resetProjectStoreTransport();
  assert.equal(await resetWait, undefined, 'transport reset must settle pending ownership waits');
  assert.equal(browserProjectOwnership('project-race'), undefined);
  assert.equal(stored.has('openchatcut.projectStoreLaunchToken'), false);
  assert.equal(stored.has('openchatcut.projectStoreSession'), false);
  assert.equal(localStorageAccesses, 0, 'transport lifecycle must never access localStorage');
} finally {
  resetImportedTransport?.();
  globalThis.fetch = originalFetch;
  globals.window = originalWindow;
  globals.location = originalLocation;
  globals.history = originalHistory;
  globals.localStorage = originalLocalStorage;
  globals.sessionStorage = originalSessionStorage;
}
