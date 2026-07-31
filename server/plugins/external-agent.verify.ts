// Runnable check: `npx tsx server/plugins/external-agent.verify.ts`.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
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

const bridgeRequests: Array<[keyof BridgeOperations, string, RequestInit | undefined]> = [
  ['registerEditor', '/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectId: 'project-a', editorId: 'editor-a', baseRevision: 'rev-a', tools: [] }),
  }],
  ['unregisterEditor', '/unregister', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectId: 'project-a', editorId: 'editor-a' }),
  }],
  ['nextEditorCall', '/poll?projectId=project-a&editorId=editor-a&baseRevision=rev-a', undefined],
  ['nextEditorCancellation', '/cancellation?projectId=project-a&editorId=editor-a', undefined],
  ['settleEditorCall', '/result', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 'call-a', outcome: 'applied', value: { ok: true } }),
  }],
  ['mcpTools', '/tools', undefined],
];

async function requestBridge(
  path: string,
  init: RequestInit | undefined,
  authorization?: string,
): Promise<Response> {
  const headers = new Headers(init?.headers);
  if (authorization) headers.set('Authorization', authorization);
  return fetch(`${origin}${path}`, { ...init, headers });
}

const originalToken = process.env.OPENCHATCUT_MCP_TOKEN;
try {
  process.env.OPENCHATCUT_MCP_TOKEN = 'bridge-secret';
  for (const authorization of [undefined, 'Bearer wrong-secret']) {
    for (const [, path, init] of bridgeRequests) {
      const response = await requestBridge(path, init, authorization);
      assert.equal(response.status, 401, `${path} must reject missing or incorrect Bearer authentication`);
    }
  }
  assert.deepEqual(
    calls,
    {
      registerEditor: 0,
      unregisterEditor: 0,
      nextEditorCall: 0,
      nextEditorCancellation: 0,
      settleEditorCall: 0,
      mcpTools: 0,
    },
    'unauthorized bridge requests must not touch broker operations',
  );

  for (const [operation, path, init] of bridgeRequests) {
    const response = await requestBridge(path, init, 'Bearer bridge-secret');
    assert(response.status === 200 || response.status === 204, `${path} must accept the configured Bearer token`);
    assert.equal(calls[operation], 1, `${path} must reach its broker operation after authentication`);
  }

  delete process.env.OPENCHATCUT_MCP_TOKEN;
  for (const [operation, path, init] of bridgeRequests) {
    const before = calls[operation];
    const response = await requestBridge(path, init);
    assert(response.status === 200 || response.status === 204, `${path} must preserve unconfigured local mode`);
    assert.equal(calls[operation], before + 1, `${path} must remain available in local mode`);
  }
} finally {
  if (originalToken === undefined) delete process.env.OPENCHATCUT_MCP_TOKEN;
  else process.env.OPENCHATCUT_MCP_TOKEN = originalToken;
  server.close();
  await once(server, 'close');
}

console.log('external-agent bridge auth verification passed');
