import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import {
  pendingEditorCallsForTest,
  nextEditorCall,
  registerEditor,
  resetExternalAgentBrokerForTest,
  unregisterEditor,
  settleEditorCall,
} from './broker.ts';
import {
  handleMcpRequest,
  MCP_POST_BODY_LIMIT_BYTES,
  MCP_SESSION_COUNT_LIMIT,
  MCP_SESSION_IDLE_LIMIT_MS,
  mcpSessionsForTest,
  resetMcpSessionsForTest,
  setMcpSessionLastUsedForTest,
} from './mcp.ts';
import {
  callOutcome,
  closeClient,
  connectClient,
  verifyMcpEditSessions,
  waitForPending,
  type ConnectedClient,
} from './mcp-session-verifier.ts';


async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert(address && typeof address !== 'string');
  return address.port;
}


async function rawSessionRequest(
  url: URL,
  sessionId: string,
  method: 'POST' | 'DELETE',
): Promise<Response> {
  const response = await fetch(url, {
    method,
    headers: {
      Accept: 'application/json, text/event-stream',
      'Content-Type': 'application/json',
      'mcp-session-id': sessionId,
    },
    body: method === 'POST'
      ? JSON.stringify({ jsonrpc: '2.0', id: 99, method: 'tools/list', params: {} })
      : undefined,
  });
  await response.arrayBuffer();
  return response;
}

await resetMcpSessionsForTest();
resetExternalAgentBrokerForTest();

const projectA = 'mcp-project-a';
const projectB = 'mcp-project-b';
const editorA = 'mcp-editor-a';
const editorB = 'mcp-editor-b';
const revisionA = 'v1-mcp-project-a';
const revisionB = 'v1-mcp-project-b';
const dynamicTool = {
  name: 'mcp_dynamic_check',
  description: 'Read project',
  input_schema: { type: 'object' as const, properties: {} },
};
const extraTool = {
  name: 'mcp_extra_check',
  description: 'Read more project state',
  input_schema: { type: 'object' as const, properties: {} },
};
const editTools = [
  {
    name: 'begin_edit_session',
    input_schema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'review_edit_session',
    input_schema: {
      type: 'object' as const,
      properties: { editSessionId: { type: 'string' }, summary: { type: 'string' } },
      required: ['editSessionId'],
    },
  },
  {
    name: 'get_edit_session',
    input_schema: {
      type: 'object' as const,
      properties: { editSessionId: { type: 'string' } },
      required: ['editSessionId'],
    },
  },
  {
    name: 'discard_edit_session',
    input_schema: {
      type: 'object' as const,
      properties: { editSessionId: { type: 'string' } },
      required: ['editSessionId'],
    },
  },
  {
    name: 'mcp_mutating_check',
    input_schema: {
      type: 'object' as const,
      properties: { editSessionId: { type: 'string' } },
      required: ['editSessionId'],
    },
  },
];
const discoveryTools = [
  {
    name: 'ToolSearch',
    description: 'Search editor tools',
    input_schema: {
      type: 'object' as const,
      properties: { query: { type: 'string' } },
      required: ['query'],
    },
  },
  {
    name: 'load_skill',
    description: 'Load a skill playbook',
    input_schema: {
      type: 'object' as const,
      properties: { name: { type: 'string' } },
      required: ['name'],
    },
  },
];
const editorTools = [dynamicTool, extraTool, ...discoveryTools, ...editTools];
await registerEditor(projectA, editorA, revisionA, [dynamicTool]);

const server = createServer((req, res) => {
  void handleMcpRequest(req, res, 'http://127.0.0.1').catch((error) => {
    if (!res.headersSent) res.writeHead(500);
    res.end(error instanceof Error ? error.message : String(error));
  });
});
const port = await listen(server);
const mcpUrl = new URL(`http://127.0.0.1:${port}/mcp`);
const clients: ConnectedClient[] = [];

try {
  const oversized = await fetch(mcpUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ payload: 'x'.repeat(MCP_POST_BODY_LIMIT_BYTES) }),
  });
  assert.equal(oversized.status, 413, 'MCP POST bodies over 2 MiB fail before transport dispatch');
  const invalidJson = await fetch(mcpUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{',
  });
  assert.equal(invalidJson.status, 400, 'MCP POST JSON is parsed before transport dispatch');
  const boundA = await connectClient(mcpUrl, 'openchatcut-mcp-binding-a');
  clients.push(boundA);
  let notify!: () => void;
  const changed = new Promise<void>((resolve) => { notify = resolve; });
  boundA.client.setNotificationHandler(ToolListChangedNotificationSchema, () => notify());
  assert.ok((await boundA.client.listTools()).tools.some((tool) => tool.name === dynamicTool.name));
  await registerEditor(projectA, editorA, revisionA, editorTools);
  await Promise.race([
    changed,
    new Promise((_, reject) => setTimeout(() => reject(new Error('tools/list_changed timeout')), 30_000)),
  ]);
  assert.ok((await boundA.client.listTools()).tools.some((tool) => tool.name === extraTool.name));
  const exposureHeaders = { 'x-openchatcut-tool-exposure': 'progressive' };
  const progressiveA = await connectClient(mcpUrl, 'openchatcut-progressive-a', exposureHeaders);
  const progressiveB = await connectClient(mcpUrl, 'openchatcut-progressive-b', exposureHeaders);
  clients.push(progressiveA, progressiveB);
  const initialProgressive = await progressiveA.client.listTools();
  assert.equal(initialProgressive.tools.some((tool) => tool.name === 'ToolSearch'), true);
  assert.equal(initialProgressive.tools.some((tool) => tool.name === dynamicTool.name), false);
  await progressiveA.client.callTool({ name: 'target_project', arguments: { projectId: projectA } });
  await progressiveB.client.callTool({ name: 'target_project', arguments: { projectId: projectA } });
  const hiddenBeforeSearch = await progressiveA.client.callTool({
    name: dynamicTool.name,
    arguments: {},
  });
  assert.equal(hiddenBeforeSearch.isError, true, 'a hidden tool cannot bypass the session projection');
  let progressiveChanged!: () => void;
  const progressiveListChanged = new Promise<void>((resolve) => { progressiveChanged = resolve; });
  progressiveA.client.setNotificationHandler(
    ToolListChangedNotificationSchema,
    () => progressiveChanged(),
  );
  const searchPending = progressiveA.client.callTool({
    name: 'ToolSearch',
    arguments: { query: 'dynamic check' },
  });
  const searchCall = await nextEditorCall(
    projectA,
    editorA,
    revisionA,
    AbortSignal.timeout(1_000),
  );
  assert.equal(searchCall?.name, 'ToolSearch');
  settleEditorCall(searchCall!.id, 'applied', {
    results: [{ name: dynamicTool.name, description: dynamicTool.description }],
  });
  const searchResult = await searchPending;
  assert.notEqual(searchResult.isError, true);
  assert.deepEqual(searchResult.structuredContent?.activatedTools, [dynamicTool.name]);
  await Promise.race([
    progressiveListChanged,
    new Promise((_, reject) => setTimeout(
      () => reject(new Error('progressive tools/list_changed timeout')),
      30_000,
    )),
  ]);
  assert.equal(
    (await progressiveA.client.listTools()).tools.some((tool) => tool.name === dynamicTool.name),
    true,
  );
  assert.equal(
    (await progressiveB.client.listTools()).tools.some((tool) => tool.name === dynamicTool.name),
    false,
    'tool activation remains isolated to one MCP transport session',
  );
  assert.equal(
    mcpSessionsForTest().find((session) => session.id === progressiveA.sessionId)
      ?.exposure.lastActivation?.source,
    'tool_search',
  );


  registerEditor(projectB, editorB, revisionB, editorTools);
  const targetA = await boundA.client.callTool({
    name: 'target_project',
    arguments: { projectId: projectA },
  });
  assert.notEqual(targetA.isError, true);
  assert.deepEqual(
    mcpSessionsForTest().find((session) => session.id === boundA.sessionId)?.binding,
    { projectId: projectA, editorInstanceId: editorA, baseRevision: revisionA },
  );
  const boundB = await connectClient(mcpUrl, 'openchatcut-mcp-binding-b');
  clients.push(boundB);
  assert.notEqual((await boundB.client.callTool({
    name: 'target_project',
    arguments: { projectId: projectB },
  })).isError, true);
  const crossProject = await boundA.client.callTool({
    name: dynamicTool.name,
    arguments: { editorProjectId: projectB },
  });
  assert.equal(crossProject.isError, true);
  assert.equal(callOutcome(crossProject), 'rejected');
  assert.equal(pendingEditorCallsForTest().length, 0, 'wrong-project calls never reach another editor queue');

  registerEditor(projectA, editorA, 'v2-mcp-project-a', editorTools);
  const staleSession = await boundA.client.callTool({
    name: 'openchatcut_status',
    arguments: {},
  });
  assert.equal(staleSession.isError, true);
  assert.equal(callOutcome(staleSession), 'stale', 'every tool call revalidates editor instance and base revision');
  registerEditor(projectA, editorA, revisionA, editorTools);
  const notRevived = await boundA.client.callTool({
    name: 'openchatcut_status',
    arguments: {},
  });
  assert.equal(callOutcome(notRevived), 'stale', 'a stale transport cannot revive when an old binding reappears');

  const switchClient = await connectClient(mcpUrl, 'openchatcut-mcp-switch');
  clients.push(switchClient);
  await switchClient.client.callTool({
    name: 'target_project',
    arguments: { projectId: projectA },
  });
  const switchingCall = switchClient.client.callTool({
    name: dynamicTool.name,
    arguments: {},
  });
  await waitForPending(switchClient.sessionId);
  assert.equal(await unregisterEditor(projectA, editorA), true);
  const switchingResult = await switchingCall;
  assert.equal(switchingResult.isError, true);
  assert.equal(callOutcome(switchingResult), 'cancelled');
  assert.equal(pendingEditorCallsForTest(switchClient.sessionId).length, 0);

  registerEditor(projectA, editorA, 'v3-mcp-project-a', editorTools);
  const closeClientConnection = await connectClient(mcpUrl, 'openchatcut-mcp-close');
  clients.push(closeClientConnection);
  await closeClientConnection.client.callTool({
    name: 'target_project',
    arguments: { projectId: projectA },
  });
  const closePending = closeClientConnection.client.callTool({
    name: dynamicTool.name,
    arguments: {},
  });
  const closeTerminal = closePending.then(() => 'settled' as const, () => 'settled' as const);
  await waitForPending(closeClientConnection.sessionId);
  await rawSessionRequest(mcpUrl, closeClientConnection.sessionId, 'DELETE');
  const closeOutcome = await Promise.race([
    closeTerminal,
    new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), 1_000)),
  ]);
  assert.equal(closeOutcome, 'settled', 'transport close settles its queued editor call');
  assert.equal(pendingEditorCallsForTest(closeClientConnection.sessionId).length, 0);

  await verifyMcpEditSessions({
    mcpUrl,
    clients,
    boundB,
    projectId: projectA,
    editorId: editorA,
    editorTools,
  });

  const expiredClient = await connectClient(mcpUrl, 'openchatcut-mcp-expired');
  clients.push(expiredClient);
  setMcpSessionLastUsedForTest(
    expiredClient.sessionId,
    Date.now() - MCP_SESSION_IDLE_LIMIT_MS - 1,
  );
  const expiredResponse = await rawSessionRequest(mcpUrl, expiredClient.sessionId, 'POST');
  assert.equal(expiredResponse.status, 404, 'real handleMcpRequest rejects an expired target');
  assert.equal(
    mcpSessionsForTest().some((session) => session.id === expiredClient.sessionId),
    false,
    'prune-before-touch evicts instead of reviving the expired session',
  );

  await Promise.all(clients.splice(0).map(closeClient));
  await resetMcpSessionsForTest();
  const cappedClients: ConnectedClient[] = [];
  for (let index = 0; index < MCP_SESSION_COUNT_LIMIT; index += 1) {
    cappedClients.push(await connectClient(mcpUrl, `openchatcut-mcp-cap-${index}`));
  }
  await cappedClients[1].client.callTool({
    name: 'target_project',
    arguments: { projectId: projectA },
  });
  const cappedPending = cappedClients[1].client.callTool({
    name: dynamicTool.name,
    arguments: {},
  });
  const cappedTerminal = cappedPending.then(() => 'settled' as const, () => 'settled' as const);
  await waitForPending(cappedClients[1].sessionId);
  setMcpSessionLastUsedForTest(cappedClients[1].sessionId, Date.now() - 60_000);
  await new Promise<void>((resolve) => setTimeout(resolve, 2));
  assert.equal(
    (await rawSessionRequest(mcpUrl, cappedClients[0].sessionId, 'POST')).status,
    200,
    'a live request updates session lastUsed',
  );
  cappedClients.push(await connectClient(mcpUrl, 'openchatcut-mcp-cap-overflow'));
  clients.push(...cappedClients);
  const cappedOutcome = await Promise.race([
    cappedTerminal,
    new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), 1_000)),
  ]);
  assert.equal(cappedOutcome, 'settled', 'cap eviction settles queued calls owned by the evicted transport');
  assert.equal(pendingEditorCallsForTest(cappedClients[1].sessionId).length, 0);
  const cappedSessions = mcpSessionsForTest();
  assert.equal(cappedSessions.length, MCP_SESSION_COUNT_LIMIT);
  assert.equal(
    cappedSessions.some((session) => session.id === cappedClients[0].sessionId),
    true,
    'recently used sessions survive cap eviction',
  );
  assert.equal(
    cappedSessions.some((session) => session.id === cappedClients[1].sessionId),
    false,
    'session cap evicts the least-recently-used transport',
  );
  assert.equal(
    (await rawSessionRequest(mcpUrl, cappedClients[1].sessionId, 'POST')).status,
    404,
    'an evicted session cannot be reused',
  );
} finally {
  await Promise.all(clients.map(closeClient));
  await resetMcpSessionsForTest();
  resetExternalAgentBrokerForTest();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

console.log('external MCP session checks passed (binding, cancellation, expiry, cap, list_changed)');
