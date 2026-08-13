import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createMiniConnect } from '../desktop/mini-connect.ts';
import {
  EDITOR_BOOTSTRAP_HEADER,
  EDITOR_TOKEN_HEADER,
  editorApiToken,
  editorBootstrapPayload,
  editorHttpBootstrapPayload,
  externalMcpToken,
} from './editor-auth.ts';
import { authorizePrivilegedEditorRequest } from './plugins/editor-api-auth.ts';
import { bypassProductAssets } from './product-assets.ts';
import { serverPlugins } from './plugins/index.ts';

assert.notEqual(editorApiToken(), externalMcpToken(), 'editor and MCP credentials must be independent');
assert.equal(editorBootstrapPayload().editorToken, editorApiToken());
assert.equal(editorBootstrapPayload().mcpToken, externalMcpToken());
assert.deepEqual(editorHttpBootstrapPayload(), { editorToken: editorApiToken() },
  'HTTP bootstrap must not expose the external MCP credential');
assert.equal(serverPlugins()[0]?.name, 'openchatcut-editor-api-auth');
for (const path of ['/api/check', '/render-still/future', '/render-clip/future']) {
  assert.equal(bypassProductAssets(path), true, `${path} must bypass static assets before auth`);
}

const app = createMiniConnect((error) => { throw error; });
app.use(authorizePrivilegedEditorRequest);
let privilegedCalls = 0;
const privilegedRoutes = [
  '/api/check', '/llm/check', '/assemblyai/check', '/upload/check', '/generate/check',
  '/export/check', '/render-still', '/render-still/future', '/render-clip',
  '/render-clip/future', '/e2b/check',
];
for (const route of privilegedRoutes) {
  app.use(route, (_req, res) => {
    privilegedCalls += 1;
    res.statusCode = 204;
    res.end();
  });
}
app.use('/api/external-agent/bootstrap', (_req, res) => { res.statusCode = 204; res.end(); });
app.use('/api/external-mcp/mcp', (_req, res) => { res.statusCode = 204; res.end(); });
app.use('/upload', (_req, res) => { res.statusCode = 204; res.end(); });

const server = createServer((req, res) => app.handle(req, res));
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const address = server.address();
assert(address && typeof address === 'object');
const origin = `http://127.0.0.1:${address.port}`;
const editorHeaders = { [EDITOR_TOKEN_HEADER]: editorApiToken() };

try {
  for (const route of privilegedRoutes) {
    const missing = await fetch(`${origin}${route}`);
    assert.equal(missing.status, 401, `${route} must reject a missing editor token`);
    assert.equal(missing.headers.get('cache-control'), 'no-store');
    assert.equal(missing.headers.get('x-openchatcut-editor-auth'), 'required');
    assert.equal((await fetch(`${origin}${route}`, {
      headers: { [EDITOR_TOKEN_HEADER]: externalMcpToken() },
    })).status, 401, 'the MCP token must not authorize editor APIs');
    assert.equal((await fetch(`${origin}${route}`, { headers: editorHeaders })).status, 204);
  }
  assert.equal(privilegedCalls, privilegedRoutes.length, 'denied requests must not reach route side effects');

  assert.equal((await fetch(`${origin}/api/check`, {
    method: 'POST',
    headers: { ...editorHeaders, Origin: 'http://evil.example' },
  })).status, 403, 'cross-origin writes must be rejected');
  assert.equal((await fetch(`${origin}/api/check`, {
    method: 'POST',
    headers: {
      ...editorHeaders,
      Host: `evil.example:${address.port}`,
      Origin: `http://evil.example:${address.port}`,
    },
  })).status, 403, 'non-local Host values must be rejected');

  assert.equal((await fetch(`${origin}/api/external-agent/bootstrap`)).status, 401,
    'only POST may use the bootstrap exemption');
  assert.equal((await fetch(`${origin}/api/external-agent/bootstrap`, {
    method: 'POST',
  })).status, 204);
  assert.equal((await fetch(`${origin}/api/external-mcp/mcp`)).status, 204);
  assert.equal((await fetch(`${origin}/api/external-agent/bootstrap/future`)).status, 401,
    'bootstrap exemption must be exact');
  assert.equal((await fetch(`${origin}/api/external-mcp/mcp/future`)).status, 401,
    'MCP exemption must be exact');
  assert.equal((await fetch(`${origin}/upload?handoff=one-time-ticket`, {
    method: 'POST',
    headers: { 'content-type': 'image/png' },
    body: 'x',
  })).status, 204, 'handoff uploads must reach their existing single-use verifier');
  assert.equal((await fetch(`${origin}/upload?handoff=one-time-ticket`)).status, 401,
    'GET must not bypass editor authorization because a handoff query is present');
} finally {
  server.close();
  await once(server, 'close');
}

function deniedStatus(remoteAddress: string): number {
  const req = {
    method: 'GET',
    url: '/api/check',
    headers: { host: '127.0.0.1:5199', [EDITOR_TOKEN_HEADER]: editorApiToken() },
    socket: { remoteAddress },
  } as unknown as IncomingMessage;
  let ended = false;
  const headers = new Map<string, string>();
  const res = {
    statusCode: 200,
    setHeader: (name: string, value: string) => { headers.set(name.toLowerCase(), value); },
    end: () => { ended = true; },
  } as unknown as ServerResponse;
  authorizePrivilegedEditorRequest(req, res, () => assert.fail('non-loopback request advanced'));
  assert.equal(ended, true);
  assert.equal(headers.get('cache-control'), 'no-store');
  return res.statusCode;
}
assert.equal(deniedStatus('192.0.2.10'), 403, 'non-loopback sockets must be rejected');

assert.equal(EDITOR_BOOTSTRAP_HEADER, 'x-openchatcut-editor-bootstrap');

console.log('editor-api-auth.verify: ok');
