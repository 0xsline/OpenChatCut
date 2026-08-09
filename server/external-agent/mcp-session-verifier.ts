import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import {
  ExternalEditorCallError,
  invokeEditorTool,
  nextEditorCall,
  pendingEditorCallsForTest,
  registerEditor,
  settleEditorCall,
  unregisterEditor,
  type ExternalEditorCall,
  type ExternalToolSchema,
} from './broker.ts';
import { mcpSessionsForTest } from './mcp.ts';

export interface ConnectedClient {
  client: Client;
  sessionId: string;
}

interface SessionVerifierContext {
  mcpUrl: URL;
  clients: ConnectedClient[];
  boundB: ConnectedClient;
  projectId: string;
  editorId: string;
  editorTools: ExternalToolSchema[];
}

interface AppliedSession {
  client: ConnectedClient;
  editSessionId: string;
}

export async function connectClient(
  url: URL,
  name: string,
  headers?: HeadersInit,
): Promise<ConnectedClient> {
  const before = new Set(mcpSessionsForTest().map((session) => session.id));
  const client = new Client({ name, version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(url, { requestInit: { headers } });
  await client.connect(transport);
  const session = mcpSessionsForTest().find((candidate) => !before.has(candidate.id));
  assert(session, 'initialization registers exactly one new MCP session');
  return { client, sessionId: session.id };
}

export async function closeClient(connection: ConnectedClient): Promise<void> {
  await connection.client.close().catch(() => undefined);
}

export async function waitForPending(sessionId: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (pendingEditorCallsForTest(sessionId).length) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`editor call for MCP session ${sessionId} was never queued`);
}

export function callOutcome(result: CallToolResult): unknown {
  return result.structuredContent?.outcome;
}

export function callStatus(result: CallToolResult): unknown {
  return result.structuredContent?.status;
}

function callMessage(result: CallToolResult): string {
  return typeof result.structuredContent?.message === 'string'
    ? result.structuredContent.message
    : '';
}

async function targetClient(context: SessionVerifierContext, name: string): Promise<ConnectedClient> {
  const connection = await connectClient(context.mcpUrl, name);
  context.clients.push(connection);
  await connection.client.callTool({
    name: 'target_project',
    arguments: { projectId: context.projectId },
  });
  return connection;
}

async function takeEditorCall(
  context: SessionVerifierContext,
  client: ConnectedClient,
  editorId: string,
  revision: string,
): Promise<ExternalEditorCall> {
  await waitForPending(client.sessionId);
  const call = await nextEditorCall(
    context.projectId,
    editorId,
    revision,
    AbortSignal.timeout(1_000),
  );
  assert(call);
  return call;
}

async function beginAppliedSession(context: SessionVerifierContext): Promise<AppliedSession> {
  const client = await targetClient(context, 'openchatcut-mcp-manual-applied');
  const editSessionId = 'manual-applied-edit-session';
  const pending = client.client.callTool({
    name: 'begin_edit_session',
    arguments: { approvalMode: 'manual' },
  });
  const call = await takeEditorCall(context, client, context.editorId, 'v3-mcp-project-a');
  assert.equal(call.name, 'begin_edit_session');
  settleEditorCall(call.id, 'applied', { editSessionId, status: 'drafting' });
  assert.equal(callStatus(await pending), 'drafting');
  return { client, editSessionId };
}

async function reviewAppliedSession(
  context: SessionVerifierContext,
  session: AppliedSession,
): Promise<void> {
  const pending = session.client.client.callTool({
    name: 'review_edit_session',
    arguments: { editSessionId: session.editSessionId, summary: 'Manual approval check' },
  });
  const call = await takeEditorCall(context, session.client, context.editorId, 'v3-mcp-project-a');
  assert.equal(call.name, 'review_edit_session');
  settleEditorCall(call.id, 'applied', {
    editSessionId: session.editSessionId,
    status: 'awaiting_review',
  });
  assert.equal(callStatus(await pending), 'awaiting_review');
}

async function pollAwaitingReview(
  context: SessionVerifierContext,
  session: AppliedSession,
): Promise<void> {
  const pending = session.client.client.callTool({
    name: 'get_edit_session',
    arguments: { editSessionId: session.editSessionId },
  });
  const call = await takeEditorCall(context, session.client, context.editorId, 'v3-mcp-project-a');
  settleEditorCall(call.id, 'applied', {
    editSessionId: session.editSessionId,
    status: 'awaiting_review',
  });
  assert.equal(callStatus(await pending), 'awaiting_review');
}

async function verifyAppliedTerminalRead(
  context: SessionVerifierContext,
  session: AppliedSession,
): Promise<void> {
  registerEditor(context.projectId, context.editorId, 'v4-mcp-project-a-applied', context.editorTools);
  const pending = session.client.client.callTool({
    name: 'get_edit_session',
    arguments: { editSessionId: session.editSessionId },
  });
  const call = await takeEditorCall(context, session.client, context.editorId, 'v4-mcp-project-a-applied');
  assert.equal(
    call.binding.baseRevision,
    'v3-mcp-project-a',
    'terminal reads preserve the MCP session expected revision at editor dispatch',
  );
  settleEditorCall(call.id, 'applied', {
    editSessionId: session.editSessionId,
    status: 'applied',
    warning: 'The edit was applied, but the project list timestamp could not be updated.',
  });
  const result = await pending;
  assert.notEqual(result.isError, true);
  assert.equal(callStatus(result), 'applied');
  assert.equal(
    result.structuredContent?.warning,
    'The edit was applied, but the project list timestamp could not be updated.',
  );
  assert.equal(
    mcpSessionsForTest().find((candidate) => candidate.id === session.client.sessionId)?.staleReason,
    null,
    'a successful terminal read does not permanently stale its transport',
  );
}

async function verifyLaterStaleRead(
  context: SessionVerifierContext,
  session: AppliedSession,
): Promise<void> {
  registerEditor(context.projectId, context.editorId, 'v5-mcp-project-a-unrelated', context.editorTools);
  const pending = session.client.client.callTool({
    name: 'get_edit_session',
    arguments: { editSessionId: session.editSessionId },
  });
  const call = await takeEditorCall(context, session.client, context.editorId, 'v5-mcp-project-a-unrelated');
  settleEditorCall(
    call.id,
    'stale',
    'The project advanced beyond the revision applied by this edit session.',
  );
  assert.equal(callOutcome(await pending), 'stale');
  assert.equal(
    mcpSessionsForTest().find((candidate) => candidate.id === session.client.sessionId)?.staleReason,
    null,
    'a stale get_edit_session result does not permanently stale its transport',
  );
}

async function verifyCrossOwnerRejection(
  context: SessionVerifierContext,
  session: AppliedSession,
): Promise<ConnectedClient> {
  const intruder = await targetClient(context, 'openchatcut-mcp-session-intruder');
  const mutation = await Promise.race([
    intruder.client.callTool({
      name: 'mcp_mutating_check',
      arguments: { editSessionId: session.editSessionId },
    }),
    new Promise<never>((_, reject) => setTimeout(
      () => reject(new Error('cross-owner mutation was queued instead of rejected')),
      200,
    )),
  ]);
  assert.equal(callOutcome(mutation), 'rejected');
  assert.equal(
    pendingEditorCallsForTest(intruder.sessionId).length,
    0,
    'a transport cannot enqueue mutations against another transport edit session',
  );
  const read = await intruder.client.callTool({
    name: 'get_edit_session',
    arguments: { editSessionId: session.editSessionId },
  });
  assert.equal(callOutcome(read), 'rejected');
  const crossProjectRead = await context.boundB.client.callTool({
    name: 'get_edit_session',
    arguments: { editSessionId: session.editSessionId },
  });
  assert.equal(callOutcome(crossProjectRead), 'rejected');
  return intruder;
}

function verifyBindingOwnership(context: SessionVerifierContext, session: AppliedSession): void {
  assert.throws(
    () => invokeEditorTool(
      session.client.sessionId,
      { projectId: context.projectId, editorInstanceId: 'other-editor', baseRevision: 'v3-mcp-project-a' },
      'get_edit_session',
      { editSessionId: session.editSessionId },
    ),
    (error: unknown) => error instanceof ExternalEditorCallError && error.outcome === 'rejected',
    'an owning transport cannot read its session through another editor binding',
  );
}

async function verifyOldRevisionMutation(session: AppliedSession): Promise<void> {
  const result = await session.client.client.callTool({
    name: 'mcp_mutating_check',
    arguments: { editSessionId: session.editSessionId },
  });
  assert.equal(callOutcome(result), 'stale');
  assert.notEqual(
    mcpSessionsForTest().find((candidate) => candidate.id === session.client.sessionId)?.staleReason,
    null,
    'mutating calls retain permanent stale transport behavior',
  );
}

async function beginOwnedDiscard(
  context: SessionVerifierContext,
): Promise<AppliedSession> {
  const client = await targetClient(context, 'openchatcut-mcp-discard-owner');
  const editSessionId = 'transport-owned-edit-session';
  const pending = client.client.callTool({
    name: 'begin_edit_session',
    arguments: { approvalMode: 'manual' },
  });
  const call = await takeEditorCall(context, client, context.editorId, 'v5-mcp-project-a-unrelated');
  settleEditorCall(call.id, 'applied', { editSessionId, status: 'drafting' });
  assert.equal(callStatus(await pending), 'drafting');
  return { client, editSessionId };
}

async function verifyPrivateActiveConflict(
  context: SessionVerifierContext,
  intruder: ConnectedClient,
  session: AppliedSession,
): Promise<void> {
  const pending = intruder.client.callTool({
    name: 'begin_edit_session',
    arguments: { approvalMode: 'manual' },
  });
  const call = await takeEditorCall(context, intruder, context.editorId, 'v5-mcp-project-a-unrelated');
  settleEditorCall(
    call.id,
    'rejected',
    'An edit session is already active. Resolve it before starting another.',
  );
  const result = await pending;
  assert.equal(callOutcome(result), 'rejected');
  assert.equal(
    callMessage(result).includes(session.editSessionId),
    false,
    'an active-session conflict never discloses the owning session UUID',
  );
}

async function verifyCompetingDiscard(
  intruder: ConnectedClient,
  session: AppliedSession,
): Promise<void> {
  const read = await intruder.client.callTool({
    name: 'get_edit_session',
    arguments: { editSessionId: session.editSessionId },
  });
  assert.equal(callOutcome(read), 'rejected');
  assert.equal(callMessage(read).includes(session.editSessionId), false);
  const discard = await intruder.client.callTool({
    name: 'discard_edit_session',
    arguments: { editSessionId: session.editSessionId },
  });
  assert.equal(callOutcome(discard), 'rejected');
  assert.equal(callMessage(discard).includes(session.editSessionId), false);
  assert.equal(
    pendingEditorCallsForTest(intruder.sessionId).length,
    0,
    'a competing authenticated transport cannot enqueue a discard',
  );
}

async function verifyOwnerDiscard(
  context: SessionVerifierContext,
  session: AppliedSession,
): Promise<void> {
  const pending = session.client.client.callTool({
    name: 'discard_edit_session',
    arguments: { editSessionId: session.editSessionId },
  });
  const call = await takeEditorCall(context, session.client, context.editorId, 'v5-mcp-project-a-unrelated');
  assert.equal(call.name, 'discard_edit_session');
  assert.equal(call.binding.baseRevision, 'v5-mcp-project-a-unrelated');
  settleEditorCall(call.id, 'applied', {
    editSessionId: session.editSessionId,
    status: 'cancelled',
  });
  assert.equal(callStatus(await pending), 'cancelled');
}

async function beginRejectedSession(context: SessionVerifierContext): Promise<AppliedSession> {
  const client = await targetClient(context, 'openchatcut-mcp-manual-rejected');
  const editSessionId = 'manual-rejected-edit-session';
  const beginPending = client.client.callTool({
    name: 'begin_edit_session',
    arguments: { approvalMode: 'manual' },
  });
  const beginCall = await takeEditorCall(context, client, context.editorId, 'v5-mcp-project-a-unrelated');
  settleEditorCall(beginCall.id, 'applied', { editSessionId, status: 'drafting' });
  await beginPending;
  const reviewPending = client.client.callTool({
    name: 'review_edit_session',
    arguments: { editSessionId, summary: 'Manual rejection check' },
  });
  const reviewCall = await takeEditorCall(context, client, context.editorId, 'v5-mcp-project-a-unrelated');
  settleEditorCall(reviewCall.id, 'applied', { editSessionId, status: 'awaiting_review' });
  assert.equal(callStatus(await reviewPending), 'awaiting_review');
  return { client, editSessionId };
}

async function rejectAndSwitchEditor(
  context: SessionVerifierContext,
  session: AppliedSession,
): Promise<string> {
  const pending = session.client.client.callTool({
    name: 'get_edit_session',
    arguments: { editSessionId: session.editSessionId },
  });
  const call = await takeEditorCall(context, session.client, context.editorId, 'v5-mcp-project-a-unrelated');
  settleEditorCall(call.id, 'applied', { editSessionId: session.editSessionId, status: 'rejected' });
  assert.equal(callStatus(await pending), 'rejected');
  assert.equal(await unregisterEditor(context.projectId, context.editorId), true);
  const switchedEditor = 'mcp-editor-a-after-switch';
  registerEditor(context.projectId, switchedEditor, 'v5-mcp-project-a-unrelated', context.editorTools);
  const switchedRead = await session.client.client.callTool({
    name: 'get_edit_session',
    arguments: { editSessionId: session.editSessionId },
  });
  assert.equal(callOutcome(switchedRead), 'stale');
  assert.notEqual(
    mcpSessionsForTest().find((candidate) => candidate.id === session.client.sessionId)?.staleReason,
    null,
    'a real editor/project switch still permanently stales the MCP transport',
  );
  return switchedEditor;
}

async function verifyStaleDiscard(
  context: SessionVerifierContext,
  switchedEditor: string,
): Promise<void> {
  const session = await beginStaleDiscard(context, switchedEditor);
  registerEditor(context.projectId, switchedEditor, 'v6-mcp-project-a-after-stale', context.editorTools);
  assert.throws(
    () => invokeEditorTool(
      session.client.sessionId,
      {
        projectId: context.projectId,
        editorInstanceId: switchedEditor,
        baseRevision: 'v5-mcp-project-a-unrelated',
      },
      'discard_edit_session',
      { editSessionId: session.editSessionId },
    ),
    (error: unknown) => error instanceof ExternalEditorCallError && error.outcome === 'stale',
    'the broker rejects an owner discard whose expected revision is stale',
  );
  const result = await session.client.client.callTool({
    name: 'discard_edit_session',
    arguments: { editSessionId: session.editSessionId },
  });
  assert.equal(callOutcome(result), 'stale');
  assert.equal(
    pendingEditorCallsForTest(session.client.sessionId).length,
    0,
    'discard cannot cross its owning transport expected revision',
  );
}

async function beginStaleDiscard(
  context: SessionVerifierContext,
  switchedEditor: string,
): Promise<AppliedSession> {
  const client = await targetClient(context, 'openchatcut-mcp-stale-discard-owner');
  const editSessionId = 'stale-revision-discard-session';
  const pending = client.client.callTool({
    name: 'begin_edit_session',
    arguments: { approvalMode: 'manual' },
  });
  const call = await takeEditorCall(context, client, switchedEditor, 'v5-mcp-project-a-unrelated');
  settleEditorCall(call.id, 'applied', { editSessionId, status: 'drafting' });
  await pending;
  return { client, editSessionId };
}

export async function verifyMcpEditSessions(context: SessionVerifierContext): Promise<void> {
  const applied = await beginAppliedSession(context);
  await reviewAppliedSession(context, applied);
  await pollAwaitingReview(context, applied);
  await verifyAppliedTerminalRead(context, applied);
  await verifyLaterStaleRead(context, applied);
  const intruder = await verifyCrossOwnerRejection(context, applied);
  verifyBindingOwnership(context, applied);
  await verifyOldRevisionMutation(applied);
  const owned = await beginOwnedDiscard(context);
  await verifyPrivateActiveConflict(context, intruder, owned);
  await verifyCompetingDiscard(intruder, owned);
  await verifyOwnerDiscard(context, owned);
  const rejected = await beginRejectedSession(context);
  const switchedEditor = await rejectAndSwitchEditor(context, rejected);
  await verifyStaleDiscard(context, switchedEditor);
}
