import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const fixture = await mkdtemp(join(tmpdir(), 'occ-mcp-recovery-'));
const previousDataDir = process.env.OPENCHATCUT_DATA_DIR;
process.env.OPENCHATCUT_DATA_DIR = fixture;

// Store paths are captured at import time; keep the real SQLite store isolated.
const { setStoredEntry } = await import('../plugins/project-store.ts');
const { resetSqliteStoreForTests } = await import('../storage/sqlite-store.ts');
const { claimBrowserProjectOwnership } = await import('./project-edit-ownership.ts');
const { docFromTimeline } = await import('../../src/persist/projectStore.ts');
const { INITIAL } = await import('../../src/editor/initial.ts');
const { revisionOf } = await import('../../src/agent/external-edit-session.ts');
const { registerEditor, touchEditor, nextEditorCall, settleEditorCall,
  pendingEditorCallsForTest, resetExternalAgentBrokerForTest } = await import('./broker.ts');
const { handleMcpRequest, mcpSessionsForTest, resetMcpSessionsForTest } = await import('./mcp.ts');
const { connectClient, closeClient, callOutcome, waitForPending } = await import('./mcp-session-verifier.ts');

const projectId = 'recovery-race';
const editorId = 'recovery-editor';
const tool = { name: 'pending_recovery_probe', input_schema: { type: 'object' as const, properties: {} } };
const server = createServer((req, res) => {
  void handleMcpRequest(req, res, 'http://127.0.0.1').catch((error) => {
    if (!res.headersSent) res.writeHead(500);
    res.end(String(error));
  });
});
let connection: Awaited<ReturnType<typeof connectClient>> | undefined;

try {
  const first = docFromTimeline({ ...INITIAL, width: 1920, height: 1080, items: [] });
  await setStoredEntry(`project:${projectId}`, first);
  const claim = await claimBrowserProjectOwnership(projectId, editorId, revisionOf(first));
  assert.equal(claim.status, 'claimed');
  if (claim.status !== 'claimed') throw new Error('Browser ownership was not claimed');
  registerEditor(projectId, editorId, revisionOf(first), [tool], claim.claim);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  connection = await connectClient(new URL(`http://127.0.0.1:${address.port}/mcp`), 'recovery-race');
  await connection.client.callTool({ name: 'target_project', arguments: { projectId } });

  for (const explicit of [true, false]) {
    const obsolete = connection.client.callTool({ name: tool.name, arguments: {} });
    void obsolete.catch(() => undefined); // Cleanup can close an outstanding SDK request after a failed assertion.
    await waitForPending(connection.sessionId);
    const updated = structuredClone(first);
    updated.timelines[0]!.width = explicit ? 1280 : 640;
    await setStoredEntry(`project:${projectId}`, updated);
    const revision = revisionOf(updated);
    assert.equal((await claimBrowserProjectOwnership(projectId, editorId, revision)).status, 'claimed');
    assert.equal(await touchEditor(projectId, editorId, revision), true);
    assert.equal(pendingEditorCallsForTest(connection.sessionId).length, 1,
      'stored ownership renewal leaves the obsolete request for recovery to cancel');

    if (explicit) {
      const target = await connection.client.callTool({ name: 'target_project', arguments: { projectId } });
      assert.notEqual(target.isError, true);
    }
    const resumed = connection.client.callTool({ name: tool.name, arguments: {} });
    void resumed.catch(() => undefined);
    assert.equal(callOutcome(await obsolete), 'stale');
    const session = mcpSessionsForTest().find((candidate) => candidate.id === connection!.sessionId);
    assert.equal(session?.binding?.baseRevision, revision);
    assert.equal(session?.staleReason, null, 'a late obsolete result must not poison the recovered binding');
    const call = await nextEditorCall(projectId, editorId, revision, AbortSignal.timeout(1000));
    assert.equal(call?.name, tool.name);
    assert.equal(settleEditorCall(call!.id, 'applied', { ok: true }), true);
    assert.notEqual((await resumed).isError, true, 'the recovered binding dispatches a real follow-up request');
    assert.equal(pendingEditorCallsForTest(connection.sessionId).length, 0);
  }
} finally {
  if (connection) await closeClient(connection);
  await resetMcpSessionsForTest();
  resetExternalAgentBrokerForTest();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  resetSqliteStoreForTests();
  if (previousDataDir === undefined) delete process.env.OPENCHATCUT_DATA_DIR;
  else process.env.OPENCHATCUT_DATA_DIR = previousDataDir;
  await rm(fixture, { recursive: true, force: true });
}

console.log('MCP recovery race: explicit rebind and automatic adoption preserve the live session');
