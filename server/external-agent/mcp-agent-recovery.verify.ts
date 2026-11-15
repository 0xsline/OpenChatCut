// Unattended-agent recovery: an agent must be able to get itself unstuck
// without a human restarting OpenChatCut.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import {
  editorBinding,
  ExternalEditorCallError,
  externalToolTimeoutMs,
  invokeEditorTool,
  nextEditorCall,
  pendingEditorCallsForTest,
  registerEditor,
  resetExternalAgentBrokerForTest,
  settleEditorCall,
} from './broker.ts';
import {
  handleMcpRequest,
  MCP_EDIT_OWNER_IDLE_MS,
  resetMcpSessionsForTest,
  setMcpSessionLastUsedForTest,
} from './mcp.ts';
import { callOutcome, closeClient, connectClient, type ConnectedClient } from './mcp-session-verifier.ts';

await resetMcpSessionsForTest();
resetExternalAgentBrokerForTest();

const projectId = 'agent-recovery-project';
const editorId = 'agent-recovery-editor';
const revision = 'v1-agent-recovery';
const tool = {
  name: 'agent_recovery_check',
  description: 'Read project',
  input_schema: { type: 'object' as const, properties: {} },
};
const sessionTool = (name: string) => ({
  name,
  input_schema: {
    type: 'object' as const,
    properties: { editSessionId: { type: 'string' }, action: { type: 'string' }, approvalMode: { type: 'string' } },
  },
});
registerEditor(projectId, editorId, revision, [
  tool,
  ...['begin_edit_session', 'list_edit_sessions', 'recover_edit_session', 'get_edit_session'].map(sessionTool),
]);
const take = () => nextEditorCall(projectId, editorId, revision, AbortSignal.timeout(1_000));
const outcomeOf = (error: unknown) => error instanceof ExternalEditorCallError ? error.outcome : 'other';

// 1. Session-management calls fail fast; heavy media calls get room to finish.
assert.ok(externalToolTimeoutMs('list_edit_sessions') < externalToolTimeoutMs('read_timeline'));
assert.ok(externalToolTimeoutMs('get_edit_session') <= 30_000);
assert.ok(externalToolTimeoutMs('import_folder') >= 300_000);
assert.ok(externalToolTimeoutMs('view_timeline_frames') > externalToolTimeoutMs('get_edit_session'));

// 2. A client that gives up releases its call instead of leaving it queued.
{
  const binding = editorBinding(projectId)!;
  const controller = new AbortController();
  const pending = invokeEditorTool('cancel-owner', binding, tool.name, {}, undefined, controller.signal);
  assert.equal(pendingEditorCallsForTest('cancel-owner').length, 1);
  controller.abort();
  await assert.rejects(pending, (error) => outcomeOf(error) === 'cancelled');
  assert.equal(pendingEditorCallsForTest('cancel-owner').length, 0, 'client cancellation settles the broker call');
}

// 3. A timeout says what the editor was busy with.
{
  const binding = editorBinding(projectId)!;
  const busy = invokeEditorTool('busy-owner', binding, 'import_asset', {});
  const busyCall = await take();
  assert.equal(busyCall?.name, 'import_asset');
  const blocked = invokeEditorTool('blocked-owner', binding, tool.name, {}, 1_000);
  await assert.rejects(blocked, (error: unknown) => outcomeOf(error) === 'cancelled'
    && error instanceof Error && /busy with import_asset/.test(error.message));
  settleEditorCall(busyCall!.id, 'applied', { ok: true });
  await busy;
}

const server = createServer((req, res) => {
  void handleMcpRequest(req, res, 'http://127.0.0.1').catch(() => {
    if (!res.headersSent) res.writeHead(500);
    res.end();
  });
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
assert(address && typeof address !== 'string');
const mcpUrl = new URL(`http://127.0.0.1:${address.port}/mcp`);
const clients: ConnectedClient[] = [];

async function connectTargeted(name: string): Promise<ConnectedClient> {
  const connection = await connectClient(mcpUrl, name);
  clients.push(connection);
  assert.notEqual((await connection.client.callTool({ name: 'target_project', arguments: { projectId } })).isError, true);
  return connection;
}

async function begin(connection: ConnectedClient, editSessionId: string): Promise<void> {
  const pending = connection.client.callTool({ name: 'begin_edit_session', arguments: { approvalMode: 'auto' } });
  const call = await take();
  assert.equal(call?.name, 'begin_edit_session');
  settleEditorCall(call!.id, 'applied', { editSessionId, status: 'drafting' });
  assert.notEqual((await pending).isError, true);
}

async function listAs(connection: ConnectedClient, editSessionId: string) {
  const pending = connection.client.callTool({ name: 'list_edit_sessions', arguments: {} });
  const call = await take();
  settleEditorCall(call!.id, 'applied', [{ editSessionId, status: 'drafting' }]);
  const rows = (await pending).structuredContent?.result as Array<Record<string, unknown>>;
  assert.ok(Array.isArray(rows));
  return rows[0]!;
}

try {
  // 4. The same agent reconnecting on a new transport can take back its idle draft.
  const owner = await connectTargeted('unattended-agent');
  await begin(owner, 'idle-draft');
  const reconnected = await connectTargeted('unattended-agent');
  const fresh = await listAs(reconnected, 'idle-draft');
  assert.equal(fresh.orphaned, false, 'a recently active owner keeps its draft');
  assert.equal(fresh.ownerOnline, true);

  setMcpSessionLastUsedForTest(owner.sessionId, Date.now() - MCP_EDIT_OWNER_IDLE_MS - 1_000);
  const idle = await listAs(reconnected, 'idle-draft');
  assert.equal(idle.orphaned, true, 'an idle owner no longer locks the draft for an hour');
  assert.deepEqual(idle.recoveryActions, ['resume', 'discard']);
  const resumePending = reconnected.client.callTool({
    name: 'recover_edit_session', arguments: { editSessionId: 'idle-draft', action: 'resume' },
  });
  const resume = await take();
  assert.equal(resume?.name, 'recover_edit_session');
  settleEditorCall(resume!.id, 'applied', { editSessionId: 'idle-draft', status: 'drafting' });
  assert.notEqual((await resumePending).isError, true, 'the reconnected transport resumes its draft');
  const stolen = await owner.client.callTool({ name: 'get_edit_session', arguments: { editSessionId: 'idle-draft' } });
  assert.equal(callOutcome(stolen), 'rejected', 'the old transport lost the draft it abandoned');

  // 5. A different agent never takes over another agent's draft, idle or not.
  const first = await connectTargeted('agent-one');
  await begin(first, 'agent-one-draft');
  const second = await connectTargeted('agent-two');
  setMcpSessionLastUsedForTest(first.sessionId, Date.now() - MCP_EDIT_OWNER_IDLE_MS - 1_000);
  const foreign = await listAs(second, 'agent-one-draft');
  assert.equal(foreign.orphaned, false, 'another client cannot orphan a live transport draft');
  const takeover = await second.client.callTool({
    name: 'recover_edit_session', arguments: { editSessionId: 'agent-one-draft', action: 'discard' },
  });
  assert.equal(callOutcome(takeover), 'rejected');
} finally {
  await Promise.all(clients.map(closeClient));
  await resetMcpSessionsForTest();
  resetExternalAgentBrokerForTest();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

console.log('MCP agent recovery: per-tool timeouts, client cancel, idle-owner takeover passed');
