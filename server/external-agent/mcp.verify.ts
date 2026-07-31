import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { connectedProjectIds, registerEditor } from './broker.ts';
import { handleMcpRequest } from './mcp.ts';

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert(address && typeof address !== 'string');
  return address.port;
}

const server = createServer((req, res) => {
  void handleMcpRequest(req, res, 'http://127.0.0.1').catch((error) => {
    if (!res.headersSent) res.writeHead(500);
    res.end(error instanceof Error ? error.message : String(error));
  });
});
const port = await listen(server);
const client = new Client({ name: 'openchatcut-mcp-check', version: '1.0.0' });
const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`));

try {
  let notify!: () => void;
  const changed = new Promise<void>((resolve) => { notify = resolve; });
  client.setNotificationHandler(ToolListChangedNotificationSchema, () => notify());
  await client.connect(transport);
  const before = await client.listTools();
  assert.ok(before.tools.length >= 5, 'every session exposes control tools');
  const projectId = connectedProjectIds()[0] ?? 'mcp-check-project';
  registerEditor(projectId, 'mcp-check-editor', [{
    name: 'mcp_dynamic_check',
    description: 'Read project',
    input_schema: { type: 'object', properties: {} },
  }]);
  await Promise.race([
    changed,
    new Promise((_, reject) => setTimeout(() => reject(new Error('tools/list_changed timeout')), 2_000)),
  ]);
  assert.ok((await client.listTools()).tools.some((tool) => tool.name === 'mcp_dynamic_check'));
} finally {
  await client.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

console.log('external MCP session check passed (stateful session + tools/list_changed)');
