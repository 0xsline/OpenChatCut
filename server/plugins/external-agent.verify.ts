// Runnable check: `npx tsx server/plugins/external-agent.verify.ts`.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, type IncomingMessage } from 'node:http';
import { externalMcpAuthorized, trustedEditorRequest } from '../editor-auth.ts';
import { mintUploadReceipt } from '../external-agent/import-token.ts';
import {
  handleExternalAgentBridge,
  type BridgeOperations,
} from './external-agent.ts';

const calls: Record<keyof BridgeOperations, number> = {
  editorRegistrationMatches: 0,
  claimBrowserOwnership: 0,
  registerEditor: 0,
  unregisterEditor: 0,
  nextEditorCall: 0,
  nextEditorCancellation: 0,
  settleEditorCall: 0,
  mcpTools: 0,
};

let staleBrowserRevision = false;
const registrationCapability = 'r'.repeat(43);
const operations = {
  claimBrowserOwnership: async (
    projectId: string,
    ownerId: string,
    baseRevision: string,
    _allowExistingBrowserOwner?: boolean,
  ) => {
    calls.claimBrowserOwnership += 1;
    if (staleBrowserRevision) return { status: 'stale' as const, currentRevision: 'authoritative-revision' };
    return {
      status: 'claimed' as const,
      claim: { projectId, ownerKind: 'browser' as const, ownerId, epoch: 1, baseRevision },
    };
  },
  editorRegistrationMatches: (_projectId: string, _editorId: string, capability: unknown) => {
    calls.editorRegistrationMatches += 1;
    return capability === registrationCapability;
  },
  registerEditor: () => {
    calls.registerEditor += 1;
    return registrationCapability;
  },
  unregisterEditor: async (_projectId, _editorId, capability) => {
    calls.unregisterEditor += 1;
    assert.equal(capability, registrationCapability);
    return true;
  },
  nextEditorCall: async (_projectId, _editorId, _revision, _signal, capability) => {
    calls.nextEditorCall += 1;
    assert.equal(capability, registrationCapability);
    return null;
  },
  nextEditorCancellation: async (_projectId, _editorId, _signal, capability) => {
    calls.nextEditorCancellation += 1;
    assert.equal(capability, registrationCapability);
    return null;
  },
  settleEditorCall: (_id, _outcome, _value, capability) => {
    calls.settleEditorCall += 1;
    assert.equal(capability, registrationCapability);
    return true;
  },
  mcpTools: () => {
    calls.mcpTools += 1;
    return [];
  },
} satisfies BridgeOperations;

const server = createServer((req, res) => {
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

function editorRequestShape(
  remoteAddress: string,
  requestOrigin = origin,
  host = new URL(origin).host,
): IncomingMessage {
  return {
    headers: { host, origin: requestOrigin },
    socket: { remoteAddress },
  } as unknown as IncomingMessage;
}

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
  origin?: string | null;
  host?: string;
  authorization?: string;
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

interface BootstrapValue { mcpToken: string }
async function readBootstrap(response: Response): Promise<BootstrapValue> {
  assert.equal(response.status, 200);
  const value: unknown = await response.json();
  assert(value && typeof value === 'object' && !Array.isArray(value));
  assert.equal('credential' in value, false,
    'bootstrap must not expose any editor credential');
  assert('mcpToken' in value && typeof value.mcpToken === 'string' && value.mcpToken);
  return { mcpToken: value.mcpToken };
}

const originalToken = process.env.OPENCHATCUT_MCP_TOKEN;
const originalEditorUrl = process.env.OPENCHATCUT_EDITOR_URL;
try {
  process.env.OPENCHATCUT_MCP_TOKEN = 'mcp-secret';
  delete process.env.OPENCHATCUT_EDITOR_URL;
  assert.equal(trustedEditorRequest(editorRequestShape('127.0.0.1'), true), true,
    'an actual IPv4 loopback socket with matching Host and Origin stays trusted');
  assert.equal(trustedEditorRequest(editorRequestShape('::1'), true), true,
    'an IPv6 loopback socket with matching Host and Origin stays trusted');
  assert.equal(trustedEditorRequest(editorRequestShape('::ffff:127.0.0.1'), true), true,
    'an IPv4-mapped loopback socket with matching Host and Origin stays trusted');
  assert.equal(trustedEditorRequest(editorRequestShape('192.0.2.10'), true), false,
    'matching Host and Origin cannot spoof a non-loopback socket');
  process.env.OPENCHATCUT_EDITOR_URL = 'https://editor.example';
  assert.equal(trustedEditorRequest(editorRequestShape(
    '192.0.2.10',
    'https://editor.example',
    'editor.example',
  ), true), false, 'a configured remote editor URL cannot authorize a non-loopback socket');
  delete process.env.OPENCHATCUT_EDITOR_URL;

  // The bridge is authorized purely by the loopback editor request shape:
  // registration works with NO credential headers; the rest of the endpoints
  // additionally require the registration capability (asserted below).
  const registerNoCredential = await requestBridge('/register', registerRequest);
  assert.equal(registerNoCredential.status, 200, 'a loopback editor request needs no credential');
  assert.equal(calls.registerEditor, 1);
  for (const [, path] of bridgeRequests.slice(1)) {
    // GET endpoints reject a missing capability outright; tools needs none
    // and the POST endpoints (result / unregister) are covered below.
    if (!path.startsWith('/poll') && !path.startsWith('/cancellation')) continue;
    const response = await requestBridge(path, undefined);
    assert.equal(response.status, 500,
      `${path} must reject a missing registration capability`);
  }

  // Bootstrap returns only the MCP token.
  const bootstrapped = await readBootstrap(await bootstrap());
  assert.equal(typeof bootstrapped.mcpToken, 'string');

  // Cross-origin pages are rejected on every endpoint.
  assert.equal((await bootstrap({ origin: 'http://evil.example' })).status, 403);
  assert.equal((await bootstrap({
    origin: 'http://evil.example',
    host: 'evil.example',
  })).status, 403);
  const registerBefore = calls.registerEditor;
  assert.equal((await requestBridge('/register', registerRequest, {
    origin: 'http://evil.example',
  })).status, 403);
  assert.equal((await requestBridge('/register', registerRequest, {
    origin: 'http://evil.example',
    host: 'evil.example',
  })).status, 403);
  assert.equal((await requestBridge('/register', registerRequest, {
    origin: null,
  })).status, 403, 'missing Origin must not authorize editor requests');
  assert.equal(calls.registerEditor, registerBefore);

  // The MCP Bearer token is a separate mechanism for external MCP clients.
  assert.equal((await fetch(`${origin}/api/external-mcp/mcp`)).status, 401);
  assert.equal((await fetch(`${origin}/api/external-mcp/mcp`, {
    headers: { Authorization: 'Bearer wrong-secret' },
  })).status, 401);
  assert.equal((await fetch(`${origin}/api/external-mcp/mcp`, {
    headers: { Authorization: 'Bearer mcp-secret' },
  })).status, 204);

  // Upload ticket minting and receipts follow the same loopback-origin trust.
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
  assert.equal((await requestBridge('/import-token', mintRequest)).status, 201);
  assert.equal((await requestBridge('/import-token', mintRequest, {
    origin: 'http://evil.example',
  })).status, 403);
  const minted = await (await requestBridge('/import-token', mintRequest)).json() as Record<string, unknown>;
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
  const receiptRequest = (
    projectId: string,
    action: 'claim' | 'commit' | 'abort',
    claimId?: unknown,
  ): RequestInit => ({
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, receipt: uploadReceipt, projectId, claimId }),
  });
  assert.equal((await requestBridge('/upload-receipt', receiptRequest('project-b', 'claim'))).status, 409);
  const receiptResponse = await requestBridge('/upload-receipt', receiptRequest('project-a', 'claim'));
  assert.equal(receiptResponse.status, 200);
  const receiptValue = await receiptResponse.json() as Record<string, unknown>;
  assert.equal(receiptValue.sessionId, 'sess-receipt');
  assert.equal(receiptValue.contentHash, 'ab'.repeat(32));
  assert.equal(
    (await requestBridge('/upload-receipt', receiptRequest('project-a', 'claim'))).status,
    409,
    'receipt must deny a concurrent claim',
  );
  assert.equal(
    (await requestBridge('/upload-receipt', receiptRequest(
      'project-a',
      'abort',
      receiptValue.claimId,
    ))).status,
    200,
  );
  const retryReceipt = await requestBridge('/upload-receipt', receiptRequest('project-a', 'claim'));
  assert.equal(retryReceipt.status, 200);
  const retryValue = await retryReceipt.json() as Record<string, unknown>;
  assert.equal(
    (await requestBridge('/upload-receipt', receiptRequest(
      'project-a',
      'commit',
      retryValue.claimId,
    ))).status,
    200,
  );
  assert.equal(
    (await requestBridge('/upload-receipt', receiptRequest('project-a', 'claim'))).status,
    409,
    'receipt must not replay after commit',
  );

  // Registration capability semantics.
  const registerCount = calls.registerEditor;
  staleBrowserRevision = true;
  const staleRegistration = await requestBridge('/register', registerRequest);
  staleBrowserRevision = false;
  assert.equal(staleRegistration.status, 409);
  assert.deepEqual(await staleRegistration.json(), {
    error: 'project changed after the browser loaded it',
    currentRevision: 'authoritative-revision',
    reloadRequired: true,
  });
  assert.equal(calls.registerEditor, registerCount,
    'a stale browser revision must not be installed in the broker');
  const registrationResponse = await requestBridge('/register', registerRequest);
  assert.equal(registrationResponse.status, 200);
  const registrationValue = await registrationResponse.json() as Record<string, unknown>;
  assert.equal(registrationValue.registrationCapability, registrationCapability);
  assert.equal(calls.registerEditor, registerCount + 1);
  const wrongCapabilityHeaders = {
    'X-OpenChatCut-Editor-Registration': 'w'.repeat(43),
  };
  const claimCount = calls.claimBrowserOwnership;
  assert.equal((await requestBridge('/register', {
    ...registerRequest,
    headers: {
      ...Object.fromEntries(new Headers(registerRequest.headers)),
      ...wrongCapabilityHeaders,
    },
  })).status, 409);
  assert.equal(calls.claimBrowserOwnership, claimCount,
    'a wrong registration capability cannot renew persisted browser ownership');
  assert.equal((await requestBridge(
    '/poll?projectId=project-a&editorId=editor-a&baseRevision=rev-a',
    { headers: wrongCapabilityHeaders },
  )).status, 409);
  assert.equal(calls.nextEditorCall, 0, 'a wrong capability cannot poll as the live editor');
  for (const [operation, path, init] of bridgeRequests.slice(1)) {
    const response = await requestBridge(path, {
      ...init,
      headers: {
        ...Object.fromEntries(new Headers(init?.headers)),
        'X-OpenChatCut-Editor-Registration': registrationCapability,
      },
    });
    assert(
      response.status === 200 || response.status === 204,
      `${path} must accept the owning editor registration capability`,
    );
    assert.equal(calls[operation], 1);
  }

  assert.equal((await requestBridge('/register', {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: '{}',
  })).status, 415);
  assert.equal((await requestBridge('/bootstrap', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  })).status, 415);

  process.env.OPENCHATCUT_EDITOR_URL = origin;
  assert.equal((await bootstrap()).status, 200);
  assert.equal((await bootstrap({
    origin: `http://localhost:${address.port}`,
    host: `localhost:${address.port}`,
  })).status, 403);

  delete process.env.OPENCHATCUT_MCP_TOKEN;
  delete process.env.OPENCHATCUT_EDITOR_URL;
  const tokenlessBootstrap = await readBootstrap(await bootstrap());
  assert.equal((await fetch(`${origin}/api/external-mcp/mcp`)).status, 401);
  assert.equal((await fetch(`${origin}/api/external-mcp/mcp`, {
    headers: { Authorization: `Bearer ${tokenlessBootstrap.mcpToken}` },
  })).status, 204);
} finally {
  if (originalToken === undefined) delete process.env.OPENCHATCUT_MCP_TOKEN;
  else process.env.OPENCHATCUT_MCP_TOKEN = originalToken;
  if (originalEditorUrl === undefined) delete process.env.OPENCHATCUT_EDITOR_URL;
  else process.env.OPENCHATCUT_EDITOR_URL = originalEditorUrl;
  server.close();
  await once(server, 'close');
}

console.log('external-agent loopback trust verification passed');
