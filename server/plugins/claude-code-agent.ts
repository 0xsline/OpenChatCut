import type { IncomingMessage, ServerResponse } from 'node:http';
import { TLSSocket } from 'node:tls';
import type { Plugin } from 'vite';
import type {
  ClaudeCodeAccountSummary,
  ClaudeCodeAgentModel,
  ClaudeCodeAgentModelsResponse,
  ClaudeCodeAgentStatus,
  ClaudeCodeTurnRequest,
  ClaudeCodeTurnStreamEvent,
} from '../../shared/claude-code-agent.ts';
import { externalMcpToken } from '../editor-auth.ts';
import {
  inspectClaudeCodeInstallation,
  MINIMUM_CLAUDE_CODE_VERSION,
  type ClaudeCodeInstallation,
} from '../claude-code/installation.ts';
import { runClaudeCodeTurn } from '../claude-code/turn-runner.ts';

const JSON_BODY_LIMIT = 4 * 1024 * 1024;
const AUTH_STATUS_TIMEOUT_MS = 8_000;

// Canonical model ids, not the CLI's short aliases ("sonnet"/"opus"/"haiku").
// The CLI accepts both and resolves an alias to exactly these ids (a `--model
// sonnet` turn reports `claude-sonnet-5` back in modelUsage), but the shared
// capability catalog is keyed by canonical id: aliases miss every entry and
// fall through to the estimator, which reports a wrong context window and
// claims tools/images are unsupported. Canonical ids resolve from the catalog.
const CURATED_MODELS: readonly ClaudeCodeAgentModel[] = [
  { id: 'claude-sonnet-5', label: 'Claude Sonnet 5', isDefault: true },
  { id: 'claude-opus-5', label: 'Claude Opus 5', isDefault: false },
  { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5', isDefault: false },
];

class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.writableEnded || res.destroyed) return;
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  const { promise, resolve, reject } = Promise.withResolvers<Buffer>();
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > limit) {
    req.resume();
    reject(new HttpError(413, 'request body too large'));
    return promise;
  }
  const chunks: Buffer[] = [];
  let size = 0;
  const cleanup = () => {
    req.off('data', onData);
    req.off('end', onEnd);
    req.off('error', onError);
    req.off('aborted', onAborted);
  };
  const fail = (error: Error) => { cleanup(); req.resume(); reject(error); };
  const onData = (chunk: Buffer | string) => {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > limit) {
      fail(new HttpError(413, 'request body too large'));
      return;
    }
    chunks.push(buffer);
  };
  const onEnd = () => { cleanup(); resolve(Buffer.concat(chunks)); };
  const onError = () => fail(new HttpError(400, 'invalid request body'));
  const onAborted = () => fail(new HttpError(400, 'request body aborted'));
  req.on('data', onData);
  req.once('end', onEnd);
  req.once('error', onError);
  req.once('aborted', onAborted);
  return promise;
}

async function readJson(req: IncomingMessage, limit = JSON_BODY_LIMIT): Promise<Record<string, unknown>> {
  const buffer = await readBody(req, limit);
  let value: unknown;
  try {
    value = JSON.parse(buffer.toString('utf8') || '{}');
  } catch {
    throw new HttpError(400, 'body must be valid JSON');
  }
  const shaped = object(value);
  if (!shaped) throw new HttpError(400, 'body must be a JSON object');
  return shaped;
}

function shortString(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== 'string' || !value || value.length > maxLength) {
    throw new HttpError(400, `${field} is invalid`);
  }
  return value;
}

function unsupportedMessage(): string {
  return `Claude Code CLI ${MINIMUM_CLAUDE_CODE_VERSION} or newer is required. Update Claude Code and try again.`;
}

function unavailableMessage(installation: ClaudeCodeInstallation): string {
  if (!installation.installed) return 'Claude Code CLI is not installed.';
  if (!installation.supported) return unsupportedMessage();
  return 'Claude Code CLI is unavailable.';
}

function accountSummary(value: Record<string, unknown>): ClaudeCodeAccountSummary {
  return {
    loggedIn: value.loggedIn === true,
    email: typeof value.email === 'string' ? value.email : null,
    subscriptionType: typeof value.subscriptionType === 'string' ? value.subscriptionType : null,
    authMethod: typeof value.authMethod === 'string' ? value.authMethod : null,
  };
}

async function readAuthStatus(claudePath: string): Promise<ClaudeCodeAccountSummary | null> {
  const { execFile } = await import('node:child_process');
  const { claudeCodeCommand } = await import('../claude-code/command.ts');
  const command = claudeCodeCommand(claudePath, ['auth', 'status', '--json']);
  const { promise, resolve } = Promise.withResolvers<ClaudeCodeAccountSummary | null>();
  execFile(command.executable, command.args, {
    encoding: 'utf8',
    timeout: AUTH_STATUS_TIMEOUT_MS,
    maxBuffer: 64 * 1024,
    windowsHide: true,
    windowsVerbatimArguments: command.windowsVerbatimArguments,
  }, (error, stdout) => {
    if (error) { resolve(null); return; }
    try {
      const parsed = object(JSON.parse(stdout));
      resolve(parsed ? accountSummary(parsed) : null);
    } catch {
      resolve(null);
    }
  });
  return promise;
}

async function claudeCodeStatus(): Promise<ClaudeCodeAgentStatus> {
  const installation = await inspectClaudeCodeInstallation();
  if (!installation.installed) return { installed: false, version: null, account: null };
  if (!installation.supported || !installation.path) {
    return { installed: true, version: installation.version, account: null, error: unsupportedMessage() };
  }
  const account = await readAuthStatus(installation.path);
  if (!account) {
    return {
      installed: true,
      version: installation.version,
      account: null,
      error: 'Could not read Claude Code sign-in status.',
    };
  }
  return { installed: true, version: installation.version, account };
}

function claudeCodeModels(): ClaudeCodeAgentModelsResponse {
  return { models: CURATED_MODELS };
}

function parseClaudeCodeTurnRequest(body: Record<string, unknown>): ClaudeCodeTurnRequest {
  return {
    requestId: shortString(body.requestId, 'requestId', 128),
    system: typeof body.system === 'string' ? body.system.slice(0, 1024 * 1024) : '',
    prompt: shortString(body.prompt, 'prompt', 2 * 1024 * 1024),
    projectId: shortString(body.projectId, 'projectId', 256),
    ...(typeof body.model === 'string' && body.model ? { model: body.model } : {}),
    ...(typeof body.sessionId === 'string' && body.sessionId ? { sessionId: body.sessionId } : {}),
  };
}

function ndjsonWriter(res: ServerResponse): (event: ClaudeCodeTurnStreamEvent) => void {
  let terminal = false;
  return (event) => {
    if (terminal) return;
    if (event.type === 'done' || event.type === 'error') terminal = true;
    if (!res.destroyed && !res.writableEnded) res.write(`${JSON.stringify(event)}\n`);
  };
}

function selfMcpUrl(req: IncomingMessage): string {
  const host = req.headers.host;
  if (!host || /[/\\@?#,\s]/.test(host)) throw new HttpError(400, 'invalid host header');
  const protocol = req.socket instanceof TLSSocket ? 'https' : 'http';
  return `${protocol}://${host}/api/external-mcp/mcp`;
}

/**
 * The Vite dev/embedded HTTP server this plugin is mounted on, captured so
 * in-process callers (no incoming request to read a Host header from) can
 * still reach this instance's own /api/external-mcp/mcp over loopback HTTP.
 */
let boundHttpServer: import('vite').ViteDevServer['httpServer'] = null;

function resolveSelfMcpUrl(): string {
  const address = boundHttpServer?.address();
  if (!address || typeof address === 'string') return 'http://127.0.0.1:5199/api/external-mcp/mcp';
  const isIPv6 = address.family === 'IPv6';
  const host = isIPv6
    ? `[${address.address === '::' ? '::1' : address.address}]`
    : (address.address === '0.0.0.0' ? '127.0.0.1' : address.address);
  return `http://${host}:${address.port}/api/external-mcp/mcp`;
}

async function streamTurn(req: IncomingMessage, res: ServerResponse, body: Record<string, unknown>): Promise<void> {
  const request = parseClaudeCodeTurnRequest(body);
  const installation = await inspectClaudeCodeInstallation();
  if (!installation.path || !installation.supported) throw new HttpError(503, unavailableMessage(installation));
  const mcpUrl = selfMcpUrl(req);
  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/x-ndjson');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  const emit = ndjsonWriter(res);
  const controller = new AbortController();
  let finished = false;
  const disconnect = () => { if (!finished) controller.abort(new Error('HTTP client disconnected.')); };
  req.once('aborted', disconnect);
  res.once('close', disconnect);
  if (req.aborted || res.destroyed) disconnect();
  try {
    await runClaudeCodeTurn(installation.path, request, mcpUrl, externalMcpToken(), emit, controller.signal);
  } catch {
    emit({ type: 'error', message: 'Claude Code could not run this turn.' });
    emit({ type: 'done' });
  } finally {
    finished = true;
    req.off('aborted', disconnect);
    res.off('close', disconnect);
    if (!res.destroyed && !res.writableEnded) res.end();
  }
}

function routePath(req: IncomingMessage): string {
  const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
  return pathname.startsWith('/api/claude-code') ? pathname.slice('/api/claude-code'.length) || '/' : pathname;
}

async function handleClaudeCodeRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const path = routePath(req);
  if (path === '/status' && req.method === 'GET') return sendJson(res, 200, await claudeCodeStatus());
  if (path === '/models' && req.method === 'GET') return sendJson(res, 200, claudeCodeModels());
  if (path === '/turn' && req.method === 'POST') return streamTurn(req, res, await readJson(req));
  const known = ['/status', '/models', '/turn'];
  if (known.includes(path)) throw new HttpError(405, 'method not allowed');
  throw new HttpError(404, 'not found');
}

function handleFailure(res: ServerResponse, error: unknown): void {
  if (res.headersSent) {
    if (!res.writableEnded && !res.destroyed) res.end();
    return;
  }
  if (error instanceof HttpError) sendJson(res, error.status, { error: error.message });
  else sendJson(res, 500, { error: 'Claude Code request failed.' });
}

export function claudeCodeAgentPlugin(): Plugin {
  return {
    name: 'openchatcut-claude-code-agent',
    configureServer(server) {
      boundHttpServer = server.httpServer ?? null;
      server.middlewares.use('/api/claude-code', (req, res) => {
        void handleClaudeCodeRequest(req, res).catch((error) => handleFailure(res, error));
      });
    },
  };
}

/**
 * Internal server-side entry for the Agent run executor: runs one Claude
 * Code turn directly, without an HTTP round trip for the caller — the
 * subprocess itself still talks to /api/external-mcp/mcp over loopback HTTP,
 * since that's Claude Code CLI's only tool-calling mechanism (MCP).
 */
export async function runServerClaudeCodeTurn(
  request: ClaudeCodeTurnRequest,
  emit: (event: ClaudeCodeTurnStreamEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  const installation = await inspectClaudeCodeInstallation();
  if (!installation.path || !installation.supported) throw new HttpError(503, unavailableMessage(installation));
  await runClaudeCodeTurn(installation.path, request, resolveSelfMcpUrl(), externalMcpToken(), emit, signal);
}
