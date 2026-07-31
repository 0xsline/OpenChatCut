import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  ToolListChangedNotificationSchema,
  type CallToolResult,
} from '@modelcontextprotocol/sdk/types.js';
import {
  ExternalEditorCallError,
  pendingEditorCallsForTest,
  invokeEditorTool,
  nextEditorCall,
  registerEditor,
  resetExternalAgentBrokerForTest,
  unregisterEditor,
  settleEditorCall,
} from './broker.ts';
import {
  handleMcpRequest,
  MCP_SESSION_COUNT_LIMIT,
  MCP_SESSION_IDLE_LIMIT_MS,
  mcpSessionsForTest,
  resetMcpSessionsForTest,
  setMcpSessionLastUsedForTest,
} from './mcp.ts';

interface ConnectedClient {
  client: Client;
  sessionId: string;
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert(address && typeof address !== 'string');
  return address.port;
}

async function connectClient(url: URL, name: string): Promise<ConnectedClient> {
  const before = new Set(mcpSessionsForTest().map((session) => session.id));
  const client = new Client({ name, version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(url);
  await client.connect(transport);
  const session = mcpSessionsForTest().find((candidate) => !before.has(candidate.id));
  assert(session, 'initialization registers exactly one new MCP session');
  return { client, sessionId: session.id };
}

async function closeClient(connection: ConnectedClient): Promise<void> {
  await connection.client.close().catch(() => undefined);
}

async function waitForPending(sessionId: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (pendingEditorCallsForTest(sessionId).length) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`editor call for MCP session ${sessionId} was never queued`);
}

function callOutcome(result: CallToolResult): unknown {
  return result.structuredContent?.outcome;
}

function callStatus(result: CallToolResult): unknown {
  return result.structuredContent?.status;
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

resetMcpSessionsForTest();
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
    name: 'mcp_mutating_check',
    input_schema: {
      type: 'object' as const,
      properties: { editSessionId: { type: 'string' } },
      required: ['editSessionId'],
    },
  },
];
const editorTools = [dynamicTool, extraTool, ...editTools];
registerEditor(projectA, editorA, revisionA, [dynamicTool]);

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
  const boundA = await connectClient(mcpUrl, 'openchatcut-mcp-binding-a');
  clients.push(boundA);
  let notify!: () => void;
  const changed = new Promise<void>((resolve) => { notify = resolve; });
  boundA.client.setNotificationHandler(ToolListChangedNotificationSchema, () => notify());
  assert.ok((await boundA.client.listTools()).tools.some((tool) => tool.name === dynamicTool.name));
  registerEditor(projectA, editorA, revisionA, editorTools);
  await Promise.race([
    changed,
    new Promise((_, reject) => setTimeout(() => reject(new Error('tools/list_changed timeout')), 2_000)),
  ]);
  assert.ok((await boundA.client.listTools()).tools.some((tool) => tool.name === extraTool.name));

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
  assert.equal(unregisterEditor(projectA, editorA), true);
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

  const appliedClient = await connectClient(mcpUrl, 'openchatcut-mcp-manual-applied');
  clients.push(appliedClient);
  await appliedClient.client.callTool({
    name: 'target_project',
    arguments: { projectId: projectA },
  });
  const appliedSessionId = 'manual-applied-edit-session';
  const beginAppliedPending = appliedClient.client.callTool({
    name: 'begin_edit_session',
    arguments: { approvalMode: 'manual' },
  });
  await waitForPending(appliedClient.sessionId);
  const beginAppliedCall = await nextEditorCall(
    projectA,
    editorA,
    'v3-mcp-project-a',
    AbortSignal.timeout(1_000),
  );
  assert(beginAppliedCall);
  assert.equal(beginAppliedCall.name, 'begin_edit_session');
  settleEditorCall(beginAppliedCall.id, 'applied', {
    editSessionId: appliedSessionId,
    status: 'drafting',
  });
  assert.equal(callStatus(await beginAppliedPending), 'drafting');

  const reviewAppliedPending = appliedClient.client.callTool({
    name: 'review_edit_session',
    arguments: { editSessionId: appliedSessionId, summary: 'Manual approval check' },
  });
  await waitForPending(appliedClient.sessionId);
  const reviewAppliedCall = await nextEditorCall(
    projectA,
    editorA,
    'v3-mcp-project-a',
    AbortSignal.timeout(1_000),
  );
  assert(reviewAppliedCall);
  assert.equal(reviewAppliedCall.name, 'review_edit_session');
  settleEditorCall(reviewAppliedCall.id, 'applied', {
    editSessionId: appliedSessionId,
    status: 'awaiting_review',
  });
  assert.equal(callStatus(await reviewAppliedPending), 'awaiting_review');

  const awaitingPollPending = appliedClient.client.callTool({
    name: 'get_edit_session',
    arguments: { editSessionId: appliedSessionId },
  });
  await waitForPending(appliedClient.sessionId);
  const awaitingPollCall = await nextEditorCall(
    projectA,
    editorA,
    'v3-mcp-project-a',
    AbortSignal.timeout(1_000),
  );
  assert(awaitingPollCall);
  settleEditorCall(awaitingPollCall.id, 'applied', {
    editSessionId: appliedSessionId,
    status: 'awaiting_review',
  });
  assert.equal(callStatus(await awaitingPollPending), 'awaiting_review');

  registerEditor(projectA, editorA, 'v4-mcp-project-a-applied', editorTools);
  const appliedPollPending = appliedClient.client.callTool({
    name: 'get_edit_session',
    arguments: { editSessionId: appliedSessionId },
  });
  await waitForPending(appliedClient.sessionId);
  const appliedPollCall = await nextEditorCall(
    projectA,
    editorA,
    'v4-mcp-project-a-applied',
    AbortSignal.timeout(1_000),
  );
  assert(appliedPollCall);
  assert.equal(
    appliedPollCall.binding.baseRevision,
    'v3-mcp-project-a',
    'terminal reads preserve the MCP session expected revision at editor dispatch',
  );
  settleEditorCall(appliedPollCall.id, 'applied', {
    editSessionId: appliedSessionId,
    status: 'applied',
    warning: 'The edit was applied, but the project list timestamp could not be updated.',
  });
  const appliedPoll = await appliedPollPending;
  assert.notEqual(appliedPoll.isError, true);
  assert.equal(callStatus(appliedPoll), 'applied');
  assert.equal(
    appliedPoll.structuredContent?.warning,
    'The edit was applied, but the project list timestamp could not be updated.',
  );
  assert.equal(
    mcpSessionsForTest().find((session) => session.id === appliedClient.sessionId)?.staleReason,
    null,
    'a successful terminal read does not permanently stale its transport',
  );
  registerEditor(projectA, editorA, 'v5-mcp-project-a-unrelated', editorTools);
  const laterReadPending = appliedClient.client.callTool({
    name: 'get_edit_session',
    arguments: { editSessionId: appliedSessionId },
  });
  await waitForPending(appliedClient.sessionId);
  const laterReadCall = await nextEditorCall(
    projectA,
    editorA,
    'v5-mcp-project-a-unrelated',
    AbortSignal.timeout(1_000),
  );
  assert(laterReadCall);
  settleEditorCall(
    laterReadCall.id,
    'stale',
    'The project advanced beyond the revision applied by this edit session.',
  );
  assert.equal(callOutcome(await laterReadPending), 'stale');
  assert.equal(
    mcpSessionsForTest().find((session) => session.id === appliedClient.sessionId)?.staleReason,
    null,
    'a stale get_edit_session result does not permanently stale its transport',
  );


  const sameProjectIntruder = await connectClient(mcpUrl, 'openchatcut-mcp-session-intruder');
  clients.push(sameProjectIntruder);
  await sameProjectIntruder.client.callTool({
    name: 'target_project',
    arguments: { projectId: projectA },
  });
  const crossOwnerMutation = await Promise.race([
    sameProjectIntruder.client.callTool({
      name: 'mcp_mutating_check',
      arguments: { editSessionId: appliedSessionId },
    }),
    new Promise<never>((_, reject) => setTimeout(
      () => reject(new Error('cross-owner mutation was queued instead of rejected')),
      200,
    )),
  ]);
  assert.equal(callOutcome(crossOwnerMutation), 'rejected');
  assert.equal(
    pendingEditorCallsForTest(sameProjectIntruder.sessionId).length,
    0,
    'a transport cannot enqueue mutations against another transport edit session',
  );
  const crossOwnerRead = await sameProjectIntruder.client.callTool({
    name: 'get_edit_session',
    arguments: { editSessionId: appliedSessionId },
  });
  assert.equal(callOutcome(crossOwnerRead), 'rejected');
  const crossProjectRead = await boundB.client.callTool({
    name: 'get_edit_session',
    arguments: { editSessionId: appliedSessionId },
  });
  assert.equal(callOutcome(crossProjectRead), 'rejected');
  assert.throws(
    () => invokeEditorTool(
      appliedClient.sessionId,
      { projectId: projectA, editorInstanceId: 'other-editor', baseRevision: 'v3-mcp-project-a' },
      'get_edit_session',
      { editSessionId: appliedSessionId },
    ),
    (error: unknown) => (
      error instanceof ExternalEditorCallError
      && error.outcome === 'rejected'
    ),
    'an owning transport cannot read its session through another editor binding',
  );

  const oldRevisionMutation = await appliedClient.client.callTool({
    name: 'mcp_mutating_check',
    arguments: { editSessionId: appliedSessionId },
  });
  assert.equal(callOutcome(oldRevisionMutation), 'stale');
  assert.notEqual(
    mcpSessionsForTest().find((session) => session.id === appliedClient.sessionId)?.staleReason,
    null,
    'mutating calls retain permanent stale transport behavior',
  );

  const rejectedClient = await connectClient(mcpUrl, 'openchatcut-mcp-manual-rejected');
  clients.push(rejectedClient);
  await rejectedClient.client.callTool({
    name: 'target_project',
    arguments: { projectId: projectA },
  });
  const rejectedSessionId = 'manual-rejected-edit-session';
  const beginRejectedPending = rejectedClient.client.callTool({
    name: 'begin_edit_session',
    arguments: { approvalMode: 'manual' },
  });
  await waitForPending(rejectedClient.sessionId);
  const beginRejectedCall = await nextEditorCall(
    projectA,
    editorA,
    'v5-mcp-project-a-unrelated',
    AbortSignal.timeout(1_000),
  );
  assert(beginRejectedCall);
  settleEditorCall(beginRejectedCall.id, 'applied', {
    editSessionId: rejectedSessionId,
    status: 'drafting',
  });
  await beginRejectedPending;
  const reviewRejectedPending = rejectedClient.client.callTool({
    name: 'review_edit_session',
    arguments: { editSessionId: rejectedSessionId, summary: 'Manual rejection check' },
  });
  await waitForPending(rejectedClient.sessionId);
  const reviewRejectedCall = await nextEditorCall(
    projectA,
    editorA,
    'v5-mcp-project-a-unrelated',
    AbortSignal.timeout(1_000),
  );
  assert(reviewRejectedCall);
  settleEditorCall(reviewRejectedCall.id, 'applied', {
    editSessionId: rejectedSessionId,
    status: 'awaiting_review',
  });
  assert.equal(callStatus(await reviewRejectedPending), 'awaiting_review');
  const rejectedPollPending = rejectedClient.client.callTool({
    name: 'get_edit_session',
    arguments: { editSessionId: rejectedSessionId },
  });
  await waitForPending(rejectedClient.sessionId);
  const rejectedPollCall = await nextEditorCall(
    projectA,
    editorA,
    'v5-mcp-project-a-unrelated',
    AbortSignal.timeout(1_000),
  );
  assert(rejectedPollCall);
  settleEditorCall(rejectedPollCall.id, 'applied', {
    editSessionId: rejectedSessionId,
    status: 'rejected',
  });
  assert.equal(callStatus(await rejectedPollPending), 'rejected');

  assert.equal(unregisterEditor(projectA, editorA), true);
  const switchedEditor = 'mcp-editor-a-after-switch';
  registerEditor(projectA, switchedEditor, 'v5-mcp-project-a-unrelated', editorTools);
  const switchedTerminalRead = await rejectedClient.client.callTool({
    name: 'get_edit_session',
    arguments: { editSessionId: rejectedSessionId },
  });
  assert.equal(callOutcome(switchedTerminalRead), 'stale');
  assert.notEqual(
    mcpSessionsForTest().find((session) => session.id === rejectedClient.sessionId)?.staleReason,
    null,
    'a real editor/project switch still permanently stales the MCP transport',
  );

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
  resetMcpSessionsForTest();
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
  resetMcpSessionsForTest();
  resetExternalAgentBrokerForTest();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

console.log('external MCP session checks passed (binding, cancellation, expiry, cap, list_changed)');
