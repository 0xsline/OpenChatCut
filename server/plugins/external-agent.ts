import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin } from 'vite';
import {
  nextEditorCall,
  nextEditorCancellation,
  registerEditor,
  settleEditorCall,
  unregisterEditor,
  type ExternalCallTerminalOutcome,
  type ExternalToolSchema,
} from '../external-agent/broker.ts';
import { handleMcpRequest, mcpTools } from '../external-agent/mcp.ts';

const MAX_BODY_BYTES = 2 * 1024 * 1024;

export interface BridgeOperations {
  registerEditor: typeof registerEditor;
  unregisterEditor: typeof unregisterEditor;
  nextEditorCall: typeof nextEditorCall;
  nextEditorCancellation: typeof nextEditorCancellation;
  settleEditorCall: typeof settleEditorCall;
  mcpTools: typeof mcpTools;
}

const bridgeOperations: BridgeOperations = {
  registerEditor,
  unregisterEditor,
  nextEditorCall,
  nextEditorCancellation,
  settleEditorCall,
  mcpTools,
};


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
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('body must be a JSON object');
  }
  return parsed as Record<string, unknown>;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

function validTools(value: unknown): value is ExternalToolSchema[] {
  return Array.isArray(value) && value.every((tool) => {
    if (!tool || typeof tool !== 'object' || Array.isArray(tool)) return false;
    if (
      !('name' in tool)
      || typeof tool.name !== 'string'
      || !('input_schema' in tool)
      || !tool.input_schema
      || typeof tool.input_schema !== 'object'
      || Array.isArray(tool.input_schema)
      || !('type' in tool.input_schema)
    ) return false;
    return tool.input_schema.type === 'object';
  });
}

function validOutcome(value: unknown): value is ExternalCallTerminalOutcome {
  return value === 'applied'
    || value === 'rejected'
    || value === 'cancelled'
    || value === 'stale'
    || value === 'failed';
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

export async function handleExternalAgentBridge(
  req: IncomingMessage,
  res: ServerResponse,
  operations: BridgeOperations = bridgeOperations,
): Promise<void> {
  if (!authorized(req)) {
    sendJson(res, 401, { error: 'invalid OpenChatCut MCP token' });
    return;
  }
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (req.method === 'POST' && url.pathname === '/register') {
    const body = await readJson(req);
    if (
      typeof body.projectId !== 'string'
      || typeof body.editorId !== 'string'
      || typeof body.baseRevision !== 'string'
      || !body.projectId.trim()
      || !body.editorId.trim()
      || !body.baseRevision.trim()
      || !validTools(body.tools)
    ) {
      throw new Error('invalid editor registration');
    }
    operations.registerEditor(
      body.projectId.trim(),
      body.editorId.trim(),
      body.baseRevision.trim(),
      body.tools,
    );
    sendJson(res, 200, { ok: true });
    return;
  }
  if (req.method === 'POST' && url.pathname === '/unregister') {
    const body = await readJson(req);
    if (
      typeof body.projectId !== 'string'
      || typeof body.editorId !== 'string'
      || !body.projectId.trim()
      || !body.editorId.trim()
    ) {
      throw new Error('invalid editor unregistration');
    }
    sendJson(
      res,
      operations.unregisterEditor(body.projectId.trim(), body.editorId.trim()) ? 200 : 404,
      { ok: true },
    );
    return;
  }
  if (req.method === 'GET' && url.pathname === '/poll') {
    const projectId = url.searchParams.get('projectId') ?? '';
    const editorId = url.searchParams.get('editorId') ?? '';
    const baseRevision = url.searchParams.get('baseRevision') ?? '';
    if (!projectId || !editorId || !baseRevision) throw new Error('projectId, editorId, and baseRevision are required');
    const call = await operations.nextEditorCall(
      projectId,
      editorId,
      baseRevision,
      AbortSignal.timeout(26_000),
    );
    if (!call) {
      res.statusCode = 204;
      res.end();
    } else sendJson(res, 200, call);
    return;
  }
  if (req.method === 'GET' && url.pathname === '/cancellation') {
    const projectId = url.searchParams.get('projectId') ?? '';
    const editorId = url.searchParams.get('editorId') ?? '';
    if (!projectId || !editorId) throw new Error('projectId and editorId are required');
    const cancellation = await operations.nextEditorCancellation(
      projectId,
      editorId,
      AbortSignal.timeout(26_000),
    );
    if (!cancellation) {
      res.statusCode = 204;
      res.end();
    } else sendJson(res, 200, cancellation);
    return;
  }
  if (req.method === 'POST' && url.pathname === '/result') {
    const body = await readJson(req);
    if (typeof body.id !== 'string') throw new Error('invalid tool result');
    const outcome = validOutcome(body.outcome)
      ? body.outcome
      : body.ok === true
        ? 'applied'
        : body.ok === false
          ? 'failed'
          : null;
    if (!outcome) throw new Error('invalid tool result outcome');
    sendJson(res, operations.settleEditorCall(body.id, outcome, body.value) ? 200 : 404, { ok: true });
    return;
  }
  if (req.method === 'GET' && url.pathname === '/tools') {
    sendJson(res, 200, { tools: operations.mcpTools() });
    return;
  }
  sendJson(res, 404, { error: 'not found' });
}

export function externalAgentPlugin(): Plugin {
  return {
    name: 'openchatcut-external-agent',
    configureServer(server) {
      server.middlewares.use('/api/external-agent', (req, res) => {
        void handleExternalAgentBridge(req, res).catch((error) => {
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
