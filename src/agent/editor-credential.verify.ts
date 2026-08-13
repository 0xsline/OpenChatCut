import assert from 'node:assert/strict';

const originalFetch = globalThis.fetch;
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
const originalLocation = Object.getOwnPropertyDescriptor(globalThis, 'location');
const requests: Array<{
  url: string;
  headers: Headers;
  redirect: RequestRedirect | undefined;
  credentials: RequestCredentials | undefined;
  method: string | undefined;
}> = [];
const storageWrites: string[] = [];
let credentialCalls = 0;

try {
  Object.defineProperty(globalThis, 'location', {
    configurable: true,
    value: {
      href: 'http://127.0.0.1:5199/',
      origin: 'http://127.0.0.1:5199',
    },
  });
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      openChatCutDesktop: {
        editorCredentials: async () => {
          credentialCalls += 1;
          return {
            editorToken: credentialCalls === 1 ? 'editor-stale-token' : 'editor-fresh-token',
            mcpToken: 'mcp-memory-token',
          };
        },
      },
      localStorage: { setItem: (key: string) => { storageWrites.push(`local:${key}`); } },
      sessionStorage: { setItem: (key: string) => { storageWrites.push(`session:${key}`); } },
    },
  });
  globalThis.fetch = async (input, init) => {
    const request = {
      url: String(input),
      headers: new Headers(init?.headers),
      redirect: init?.redirect,
      credentials: init?.credentials,
      method: init?.method,
    };
    requests.push(request);
    if (request.url === '/api/retry'
      && request.headers.get('X-OpenChatCut-Editor-Token') === 'editor-stale-token') {
      return new Response(null, {
        status: 401,
        headers: { 'X-OpenChatCut-Editor-Auth': 'required' },
      });
    }
    if (request.url === '/api/write-retry-check') {
      return new Response(null, {
        status: 401,
        headers: { 'X-OpenChatCut-Editor-Auth': 'required' },
      });
    }
    if (request.url === '/api/provider-401') {
      return new Response(null, { status: 401 });
    }
    if (request.url === '/api/external-agent/bootstrap') {
      return Response.json({ editorToken: 'editor-web-token' });
    }
    return new Response(null, { status: 204 });
  };

  const {
    EDITOR_BOOTSTRAP_HEADER,
    EDITOR_TOKEN_HEADER,
    editorTokenForUiUpload,
    installEditorApiFetch,
    invalidateEditorBootstrapInfo,
  } = await import('./editor-credential.ts');
  installEditorApiFetch();

  const protectedUrls = [
    '/api/keys',
    '/llm/messages',
    '/assemblyai/v2/transcript',
    '/upload/presign',
    '/generate/image',
    '/export/job',
    '/render-still/frame',
    '/render-clip/job',
    '/e2b/run',
    'http://127.0.0.1:5199/api/project-store',
  ];
  for (const url of protectedUrls) await fetch(url, { redirect: 'follow' });

  assert.equal(credentialCalls, 1, 'desktop credentials should be fetched once and cached');
  for (const request of requests) {
    assert.equal(request.headers.get(EDITOR_TOKEN_HEADER), 'editor-stale-token');
    assert.equal(request.redirect, 'error', 'credentialed API fetches must reject redirects');
  }

  const firstUnprotected = requests.length;
  await fetch('/api/external-agent/bootstrap');
  await fetch('/api/external-mcp/mcp');
  await fetch('/upload?handoff=single-use-ticket');
  await fetch('/media/uploads/example.mp4');
  await fetch('https://provider.example/api');
  for (const request of requests.slice(firstUnprotected)) {
    assert.equal(
      request.headers.get(EDITOR_TOKEN_HEADER),
      null,
      'the editor token must not leave protected same-origin editor routes',
    );
  }

  const retryStart = requests.length;
  const retryResponse = await fetch('/api/retry');
  assert.equal(retryResponse.status, 204);
  assert.equal(requests.length - retryStart, 2, 'a 401 should be retried at most once');
  assert.equal(requests[retryStart]?.headers.get(EDITOR_TOKEN_HEADER), 'editor-stale-token');
  assert.equal(requests[retryStart + 1]?.headers.get(EDITOR_TOKEN_HEADER), 'editor-fresh-token');
  assert.equal(credentialCalls, 2, 'a 401 should refresh the in-memory credential once');

  const writeStart = requests.length;
  assert.equal((await fetch('/api/write-retry-check', {
    method: 'POST',
    body: 'non-idempotent',
  })).status, 401);
  assert.equal(requests.length - writeStart, 1, 'writes must never be replayed automatically');
  const provider401Start = requests.length;
  assert.equal((await fetch('/api/provider-401')).status, 401);
  assert.equal(requests.length - provider401Start, 1,
    'unmarked business/provider 401 responses must never trigger a replay');

  assert.equal(await editorTokenForUiUpload('/upload?name=clip.mp4'), 'editor-fresh-token');
  assert.equal(await editorTokenForUiUpload('/upload/multipart/init'), 'editor-fresh-token');
  assert.equal(await editorTokenForUiUpload('/upload?handoff=single-use-ticket'), undefined);
  assert.equal(await editorTokenForUiUpload('https://uploads.example/object'), undefined);

  invalidateEditorBootstrapInfo();
  window.openChatCutDesktop = undefined;
  const webStart = requests.length;
  await fetch('/api/web-bootstrap-check');
  const webRequests = requests.slice(webStart);
  assert.equal(webRequests.length, 2, 'web mode should bootstrap before the protected request');
  const bootstrap = webRequests[0];
  assert.equal(bootstrap?.url, '/api/external-agent/bootstrap');
  assert.equal(bootstrap?.method, 'POST');
  assert.equal(bootstrap?.headers.get(EDITOR_BOOTSTRAP_HEADER), '1');
  assert.equal(bootstrap?.headers.get('content-type'), 'application/json');
  assert.equal(bootstrap?.redirect, 'error');
  assert.equal(bootstrap?.credentials, 'same-origin');
  assert.equal(webRequests[1]?.headers.get(EDITOR_TOKEN_HEADER), 'editor-web-token');
  assert.deepEqual(storageWrites, [], 'credentials must never be persisted in browser storage');
} finally {
  globalThis.fetch = originalFetch;
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
  else Reflect.deleteProperty(globalThis, 'window');
  if (originalLocation) Object.defineProperty(globalThis, 'location', originalLocation);
  else Reflect.deleteProperty(globalThis, 'location');
}

console.log('editor-credential.verify: ok');
