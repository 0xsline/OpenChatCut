// Runnable check: `npx tsx server/plugins/external-agent.verify.ts`.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { externalMcpAuthorized } from '../editor-auth.ts';
import { mintUploadReceipt } from '../external-agent/import-token.ts';
import {
  exchangeProjectStoreLaunchToken,
  PROJECT_STORE_LAUNCH_TOKEN_HEADER,
  PROJECT_STORE_SESSION_HEADER,
  projectStoreLaunchToken,
  resetProjectStoreHttpAuthForTests,
} from '../project-store-http-auth.ts';
import {
  handleExternalAgentBridge,
  type BridgeOperations,
} from './external-agent.ts';

const calls: Record<keyof BridgeOperations, number> = {
  registerEditor: 0,
  unregisterEditor: 0,
  nextEditorCall: 0,
  nextEditorCancellation: 0,
  settleEditorCall: 0,
  mcpTools: 0,
};

const operations = {
  registerEditor: () => { calls.registerEditor += 1; },
  unregisterEditor: () => {
    calls.unregisterEditor += 1;
    return true;
  },
  nextEditorCall: async () => {
    calls.nextEditorCall += 1;
    return null;
  },
  nextEditorCancellation: async () => {
    calls.nextEditorCancellation += 1;
    return null;
  },
  settleEditorCall: () => {
    calls.settleEditorCall += 1;
    return true;
  },
  mcpTools: () => {
    calls.mcpTools += 1;
    return [];
  },
} satisfies BridgeOperations;

const server = createServer((req, res) => {
  if (req.url === '/api/project-store/session') {
    const session = exchangeProjectStoreLaunchToken(req);
    res.statusCode = session ? 200 : 403;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(session ?? { error: 'invalid launch credential' }));
    return;
  }
  if (req.url === '/api/external-mcp/mcp') {
    res.statusCode = externalMcpAuthorized(req) ? 204 : 401;
    res.end();
    return;
  }
  req.url = req.url?.replace(/^\/api\/external-agent/, '') ?? '/';
  void handleExternalAgentBridge(req, res, operations).catch((error) => {
    res.statusCode = 500;
    res.end(error instanceof Error ? error.message : String(error));
  });
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const address = server.address();
assert(address && typeof address === 'object');
const origin = `http://127.0.0.1:${address.port}`;

const registerRequest: RequestInit = {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ projectId: 'project-a', editorId: 'editor-a', baseRevision: 'rev-a', tools: [] }),
};

const bridgeRequests: Array<[keyof BridgeOperations, string, RequestInit | undefined]> = [
  ['registerEditor', '/register', registerRequest],
  ['nextEditorCall', '/poll?projectId=project-a&editorId=editor-a&baseRevision=rev-a', undefined],
  ['nextEditorCancellation', '/cancellation?projectId=project-a&editorId=editor-a', undefined],
  ['settleEditorCall', '/result', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 'call-a', outcome: 'applied', value: { ok: true } }),
  }],
  ['unregisterEditor', '/unregister', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectId: 'project-a', editorId: 'editor-a' }),
  }],
  ['mcpTools', '/tools', undefined],
];

interface BridgeRequestOptions {
  credential?: string;
  origin?: string | null;
  host?: string;
  authorization?: string;
  launchToken?: string;
  sessionToken?: string;
}

async function requestBridge(
  path: string,
  init: RequestInit | undefined,
  options: BridgeRequestOptions = {},
): Promise<Response> {
  const headers = new Headers(init?.headers);
  const requestOrigin = options.origin === undefined ? origin : options.origin;
  if (requestOrigin) headers.set('Origin', requestOrigin);
  if (options.host) headers.set('Host', options.host);
  if (options.authorization) headers.set('Authorization', options.authorization);
  if (options.credential) {
    headers.set('X-OpenChatCut-Editor-Credential', options.credential);
  }
  if (options.launchToken) headers.set(PROJECT_STORE_LAUNCH_TOKEN_HEADER, options.launchToken);
  if (options.sessionToken) headers.set(PROJECT_STORE_SESSION_HEADER, options.sessionToken);
  return fetch(`${origin}/api/external-agent${path}`, { ...init, headers });
}

async function bootstrap(options: BridgeRequestOptions = {}): Promise<Response> {
  return requestBridge('/bootstrap', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-OpenChatCut-Editor-Bootstrap': '1',
    },
    body: '{}',
  }, options);
}

interface BootstrapValue { credential: string; mcpToken: string }
async function readBootstrap(response: Response): Promise<BootstrapValue> {
  assert.equal(response.status, 200);
  const value: unknown = await response.json();
  assert(value && typeof value === 'object' && !Array.isArray(value));
  assert('credential' in value && typeof value.credential === 'string' && value.credential);
  assert('mcpToken' in value && typeof value.mcpToken === 'string' && value.mcpToken);
  return { credential: value.credential, mcpToken: value.mcpToken };
}

async function readCredential(response: Response): Promise<string> {
  return (await readBootstrap(response)).credential;
}

async function exchangeSession(launchToken: string): Promise<string> {
  const response = await fetch(`${origin}/api/project-store/session`, {
    method: 'POST',
    headers: {
      Origin: origin,
      [PROJECT_STORE_LAUNCH_TOKEN_HEADER]: launchToken,
    },
  });
  assert.equal(response.status, 200);
  const value = await response.json() as Record<string, unknown>;
  assert.equal(typeof value.sessionToken, 'string');
  return value.sessionToken as string;
}

const originalToken = process.env.OPENCHATCUT_MCP_TOKEN;
const originalEditorUrl = process.env.OPENCHATCUT_EDITOR_URL;
try {
  process.env.OPENCHATCUT_MCP_TOKEN = 'mcp-secret';
  delete process.env.OPENCHATCUT_EDITOR_URL;
  resetProjectStoreHttpAuthForTests();
  const launchToken = projectStoreLaunchToken();
  const sessionToken = await exchangeSession(launchToken);
  for (const [, path, init] of bridgeRequests) {
    const response = await requestBridge(path, init, {
      authorization: 'Bearer mcp-secret',
    });
    assert.equal(response.status, 401, `${path} must reject the MCP Bearer without an editor credential`);
  }
  assert.deepEqual(calls, {
    registerEditor: 0,
    unregisterEditor: 0,
    nextEditorCall: 0,
    nextEditorCancellation: 0,
    settleEditorCall: 0,
    mcpTools: 0,
  });

  assert.equal((await bootstrap()).status, 401);
  assert.equal((await bootstrap({ launchToken })).status, 401,
    'one-time launch credentials must not authorize editor bootstrap directly');
  const credential = await readCredential(await bootstrap({ sessionToken }));
  assert.notEqual(credential, 'mcp-secret');
  assert.equal(await readCredential(await bootstrap({ sessionToken })), credential);
  const mintRequest: RequestInit = {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sessionId: 'sess-ticket',
      assetId: 'asset-ticket',
      assetType: 'video',
      filename: 'clip.mov',
      projectId: 'project-a',
      method: 'POST',
      contentType: 'video/quicktime',
      expectedBytes: 1_024,
    }),
  };
  assert.equal((await requestBridge('/import-token', mintRequest)).status, 401);
  assert.equal((await requestBridge('/import-token', mintRequest, {
    credential,
    origin: 'http://evil.example',
  })).status, 403);
  const mintedResponse = await requestBridge('/import-token', mintRequest, { credential });
  assert.equal(mintedResponse.status, 201);
  const minted = await mintedResponse.json() as Record<string, unknown>;
  assert.equal(typeof minted.uploadUrl, 'string');
  assert.equal('token' in minted, false, 'mint response exposes the ticket only inside its intended URL');
  assert.deepEqual(minted.allowedMethods, ['POST']);
  const uploadReceipt = mintUploadReceipt({
    sessionId: 'sess-receipt',
    assetId: 'asset-receipt',
    assetType: 'video',
    filename: 'receipt.mov',
    projectId: 'project-a',
    method: 'POST',
    contentType: 'video/quicktime',
    expectedBytes: 4,
  }, {
    path: '/media/uploads/asset-receipt.mov',
    fileKey: 'uploads/asset-receipt.mov',
    bytes: 4,
    contentHash: 'ab'.repeat(32),
  });
  const receiptRequest = (projectId: string): RequestInit => ({
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ receipt: uploadReceipt, projectId }),
  });
  assert.equal((await requestBridge('/upload-receipt', receiptRequest('project-a'))).status, 401);
  assert.equal((await requestBridge('/upload-receipt', receiptRequest('project-b'), { credential })).status, 409);
  const receiptResponse = await requestBridge('/upload-receipt', receiptRequest('project-a'), { credential });
  assert.equal(receiptResponse.status, 200);
  const receiptValue = await receiptResponse.json() as Record<string, unknown>;
  assert.equal(receiptValue.sessionId, 'sess-receipt');
  assert.equal(receiptValue.contentHash, 'ab'.repeat(32));
  assert.equal(
    (await requestBridge('/upload-receipt', receiptRequest('project-a'), { credential })).status,
    409,
    'receipt must not replay',
  );
  for (const [operation, path, init] of bridgeRequests) {
    const response = await requestBridge(path, init, { credential });
    assert(
      response.status === 200 || response.status === 204,
      `${path} must accept the bootstrapped editor credential`,
    );
    assert.equal(calls[operation], 1);
  }

  assert.equal((await fetch(`${origin}/api/external-mcp/mcp`)).status, 401);
  assert.equal((await fetch(`${origin}/api/external-mcp/mcp`, {
    headers: { Authorization: 'Bearer wrong-secret' },
  })).status, 401);
  assert.equal((await fetch(`${origin}/api/external-mcp/mcp`, {
    headers: { Authorization: 'Bearer mcp-secret' },
  })).status, 204);

  assert.equal((await bootstrap({ origin: 'http://evil.example' })).status, 403);
  assert.equal((await bootstrap({
    origin: 'http://evil.example',
    host: 'evil.example',
  })).status, 403);
  const registerBefore = calls.registerEditor;
  assert.equal((await requestBridge('/register', registerRequest, {
    credential,
    origin: 'http://evil.example',
  })).status, 403);
  assert.equal((await requestBridge('/register', registerRequest, {
    credential,
    origin: 'http://evil.example',
    host: 'evil.example',
  })).status, 403);
  assert.equal(calls.registerEditor, registerBefore);

  assert.equal((await requestBridge('/register', {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: '{}',
  }, { credential })).status, 415);
  assert.equal((await requestBridge('/bootstrap', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  }, { sessionToken })).status, 415);

  process.env.OPENCHATCUT_EDITOR_URL = origin;
  assert.equal((await bootstrap({ sessionToken })).status, 200);
  assert.equal((await bootstrap({
    sessionToken,
    origin: `http://localhost:${address.port}`,
    host: `localhost:${address.port}`,
  })).status, 403);

  delete process.env.OPENCHATCUT_MCP_TOKEN;
  delete process.env.OPENCHATCUT_EDITOR_URL;
  const tokenlessBootstrap = await readBootstrap(await bootstrap({ sessionToken }));
  const tokenlessRegister = await requestBridge('/register', registerRequest, {
    credential: tokenlessBootstrap.credential,
  });
  assert.equal(tokenlessRegister.status, 200);
  assert.equal((await fetch(`${origin}/api/external-mcp/mcp`)).status, 401);
  assert.equal((await fetch(`${origin}/api/external-mcp/mcp`, {
    headers: { Authorization: `Bearer ${tokenlessBootstrap.mcpToken}` },
  })).status, 204);
} finally {
  if (originalToken === undefined) delete process.env.OPENCHATCUT_MCP_TOKEN;
  else process.env.OPENCHATCUT_MCP_TOKEN = originalToken;
  if (originalEditorUrl === undefined) delete process.env.OPENCHATCUT_EDITOR_URL;
  else process.env.OPENCHATCUT_EDITOR_URL = originalEditorUrl;
  resetProjectStoreHttpAuthForTests();
  server.close();
  await once(server, 'close');
}

console.log('external-agent editor credential verification passed');
