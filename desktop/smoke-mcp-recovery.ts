import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

type ClientResult = Awaited<ReturnType<Client['callTool']>>;

interface McpConnection {
  client: Client;
  transport: StreamableHTTPClientTransport;
}

function content(result: ClientResult): Record<string, unknown> {
  if (
    !('structuredContent' in result) ||
    !result.structuredContent ||
    typeof result.structuredContent !== 'object' ||
    Array.isArray(result.structuredContent)
  ) {
    throw new Error('MCP tool returned no structured content');
  }
  return result.structuredContent as Record<string, unknown>;
}

function stringField(result: ClientResult, key: string): string {
  const value = content(result)[key];
  if (typeof value !== 'string') throw new Error(`MCP field ${key} is not a string`);
  return value;
}

function failed(result: ClientResult): boolean {
  return 'isError' in result && result.isError === true;
}

async function connect(origin: string, token: string, name: string): Promise<McpConnection> {
  const client = new Client({ name, version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(
    new URL(`${origin}/api/external-mcp/mcp`),
    { requestInit: { headers: { Authorization: `Bearer ${token}` } } },
  );
  await client.connect(transport);
  return { client, transport };
}

async function close(connection: McpConnection): Promise<void> {
  await connection.transport.terminateSession();
  await connection.client.close();
  await new Promise((resolve) => setTimeout(resolve, 50));
}

async function target(client: Client, projectId: string): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const result = await client.callTool({ name: 'target_project', arguments: { projectId } });
    if (!failed(result)) {
      assert.equal(content(result).bindingMode, 'offline');
      return;
    }
    const message = String(content(result).message ?? '');
    if (!message.includes('already has an active')) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('offline project ownership was not released after MCP transport close');
}

async function begin(client: Client): Promise<ClientResult> {
  const result = await client.callTool({
    name: 'begin_edit_session',
    arguments: { approvalMode: 'auto' },
  });
  assert.equal(failed(result), false, JSON.stringify(content(result)));
  return result;
}

export async function runDesktopMcpRecoverySmoke(origin: string, token: string): Promise<void> {
  const seed = await connect(origin, token, 'desktop-smoke-seed');
  const created = await seed.client.callTool({
    name: 'create_project',
    arguments: { name: 'Desktop MCP recovery smoke' },
  });
  const projectId = stringField(created, 'id');
  await target(seed.client, projectId);
  const seedBegin = await begin(seed.client);
  assert.equal(content(seedBegin).resumed, false);
  const edit = await seed.client.callTool({
    name: 'set_aspect_ratio',
    arguments: { editSessionId: stringField(seedBegin, 'editSessionId'), ratio: '9:16' },
  });
  assert.equal(failed(edit), false, JSON.stringify(content(edit)));
  await close(seed);

  const resumed = await connect(origin, token, 'desktop-smoke-resume');
  try {
    await target(resumed.client, projectId);
    const resumedBegin = await begin(resumed.client);
    assert.equal(content(resumedBegin).resumed, true);
    assert.equal(stringField(resumedBegin, 'editSessionId'), stringField(seedBegin, 'editSessionId'));
    const read = await resumed.client.callTool({
      name: 'read_project',
      arguments: { editSessionId: stringField(resumedBegin, 'editSessionId') },
    });
    assert.equal(failed(read), false, JSON.stringify(content(read)));
    assert.equal(content(read).ok, true);
  } finally {
    await close(resumed);
  }
  console.log('[smoke] packaged MCP checkpoint recovery ok');
}
