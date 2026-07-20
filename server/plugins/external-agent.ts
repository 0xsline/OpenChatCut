import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin } from 'vite';
import {
  nextEditorCall,
  registerEditor,
  settleEditorCall,
  type ExternalToolSchema,
} from '../external-agent/broker.ts';
import { handleMcpRequest, mcpTools } from '../external-agent/mcp.ts';

const MAX_BODY_BYTES = 2 * 1024 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new Error('request body too large');
    chunks.push(buffer);
  }
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  if (!isRecord(parsed)) throw new Error('body must be a JSON object');
  return parsed;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

function validTools(value: unknown): value is ExternalToolSchema[] {
  return Array.isArray(value) && value.every((tool) => (
    isRecord(tool)
    && typeof tool.name === 'string'
    && isRecord(tool.input_schema)
    && tool.input_schema.type === 'object'
  ));
}

function authorized(req: IncomingMessage): boolean {
  const token = process.env.OPENCHATCUT_MCP_TOKEN?.trim();
  return !token || req.headers.authorization === `Bearer ${token}`;
}

function requestBaseUrl(req: IncomingMessage): string {
  const configured = process.env.OPENCHATCUT_EDITOR_URL?.trim();
  if (configured) return configured;
  const proto = String(req.headers['x-forwarded-proto'] ?? 'http').split(',')[0].trim();
  const host = String(req.headers['x-forwarded-host'] ?? req.headers.host ?? '127.0.0.1:5199').split(',')[0].trim();
  return `${proto}://${host}`;
}

async function handleBridge(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (req.method === 'POST' && url.pathname === '/register') {
    const body = await readJson(req);
    if (typeof body.projectId !== 'string' || typeof body.editorId !== 'string' || !validTools(body.tools)) {
      throw new Error('invalid editor registration');
    }
    registerEditor(body.projectId, body.editorId, body.tools);
    sendJson(res, 200, { ok: true });
    return;
  }
  if (req.method === 'GET' && url.pathname === '/poll') {
    const projectId = url.searchParams.get('projectId') ?? '';
    const editorId = url.searchParams.get('editorId') ?? '';
    const call = await nextEditorCall(projectId, editorId, AbortSignal.timeout(26_000));
    if (!call) {
      res.statusCode = 204;
      res.end();
    } else sendJson(res, 200, call);
    return;
  }
  if (req.method === 'POST' && url.pathname === '/result') {
    const body = await readJson(req);
    if (typeof body.id !== 'string' || typeof body.ok !== 'boolean') throw new Error('invalid tool result');
    sendJson(res, settleEditorCall(body.id, body.ok, body.value) ? 200 : 404, { ok: true });
    return;
  }
  if (!authorized(req)) {
    sendJson(res, 401, { error: 'invalid OpenChatCut MCP token' });
    return;
  }
  if (req.method === 'GET' && url.pathname === '/tools') {
    sendJson(res, 200, { tools: mcpTools() });
    return;
  }
  sendJson(res, 404, { error: 'not found' });
}

export function externalAgentPlugin(): Plugin {
  return {
    name: 'openchatcut-external-agent',
    configureServer(server) {
      server.middlewares.use('/api/external-agent', (req, res) => {
        void handleBridge(req, res).catch((error) => {
          if (!res.headersSent) sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
        });
      });
      server.middlewares.use('/api/external-mcp/mcp', (req, res) => {
        if (!authorized(req)) {
          sendJson(res, 401, { error: 'invalid OpenChatCut MCP token' });
          return;
        }
        void handleMcpRequest(req, res, requestBaseUrl(req)).catch((error) => {
          server.config.logger.error(`[external-mcp] ${error instanceof Error ? error.message : String(error)}`);
          if (!res.headersSent) sendJson(res, 500, { error: 'MCP request failed' });
        });
      });
    },
  };
}
