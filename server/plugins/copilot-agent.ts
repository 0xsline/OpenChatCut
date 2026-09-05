import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin } from 'vite';
import type {
  CopilotAgentModelsResponse,
  CopilotAgentStatus,
  CopilotToolResultRequest,
  CopilotTurnRequest,
  CopilotTurnStreamEvent,
} from '../../shared/copilot-agent.ts';
import { getKey } from '../keystore.ts';
import {
  CopilotProcessError,
  listCopilotModels,
  readCopilotAuth,
  stopCopilotClient,
} from '../copilot/client.ts';
import {
  inspectCopilotInstallation,
  MINIMUM_COPILOT_VERSION,
  type CopilotInstallation,
} from '../copilot/installation.ts';
import { hasCopilotRequest, runCopilotTurn, settleToolResult } from '../copilot/turn-manager.ts';

const JSON_BODY_LIMIT = 4 * 1024 * 1024;
const TOOL_RESULT_BODY_LIMIT = 32 * 1024 * 1024;

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

function unsupportedMessage(): string {
  return `GitHub Copilot CLI ${MINIMUM_COPILOT_VERSION} or newer is required. Run \`copilot update\` and try again.`;
}

function unavailableMessage(installation: CopilotInstallation): string {
  if (!installation.installed) {
    return 'GitHub Copilot CLI is not installed. Install it with `npm i -g @github/copilot`.';
  }
  if (!installation.supported) return unsupportedMessage();
  return 'Copilot CLI is unavailable.';
}

async function requireInstallation(): Promise<CopilotInstallation> {
  const installation = await inspectCopilotInstallation();
  if (!installation.path || !installation.supported) {
    throw new HttpError(503, unavailableMessage(installation));
  }
  return installation;
}

async function copilotStatus(): Promise<CopilotAgentStatus> {
  const installation = await inspectCopilotInstallation();
  if (!installation.installed) {
    return {
      installed: false,
      version: null,
      path: null,
      supported: false,
      authenticated: false,
      account: null,
    };
  }
  if (!installation.supported) {
    return {
      installed: true,
      version: installation.version,
      path: installation.path,
      supported: false,
      authenticated: false,
      account: null,
      error: unsupportedMessage(),
    };
  }
  try {
    const auth = await readCopilotAuth();
    return {
      installed: true,
      version: installation.version,
      path: installation.path,
      supported: true,
      authenticated: auth.authenticated,
      account: auth.authenticated
        ? { login: auth.login, authType: auth.authType, host: auth.host }
        : null,
      ...(auth.authenticated ? {} : { error: 'Not signed in. Run `copilot login` in a terminal.' }),
    };
  } catch (error) {
    return {
      installed: true,
      version: installation.version,
      path: installation.path,
      supported: true,
      authenticated: false,
      account: null,
      error: error instanceof CopilotProcessError
        ? error.message
        : 'Copilot CLI is unavailable. Restart OpenChatCut and try again.',
    };
  }
}

async function copilotModels(): Promise<CopilotAgentModelsResponse> {
  try {
    await requireInstallation();
    return { models: await listCopilotModels() };
  } catch (error) {
    return {
      models: [],
      error: error instanceof HttpError || error instanceof CopilotProcessError
        ? error.message
        : 'Unable to discover Copilot models. Try again.',
    };
  }
}

function shortString(value: unknown, name: string, limit: number): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > limit) {
    throw new HttpError(400, `${name} is invalid`);
  }
  return value;
}

function reasoningEffort(value: unknown): string | null {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value) ? value : null;
}

function validTool(value: unknown): value is CopilotTurnRequest['tools'][number] {
  const tool = object(value);
  return Boolean(
    tool
    && typeof tool.name === 'string'
    && /^[A-Za-z0-9_-]{1,128}$/.test(tool.name)
    && (tool.description === undefined || (typeof tool.description === 'string' && tool.description.length <= 16_384))
    && object(tool.inputSchema),
  );
}

export function parseCopilotTurnRequest(body: Record<string, unknown>): CopilotTurnRequest {
  if (!Array.isArray(body.tools) || body.tools.length > 512 || !body.tools.every(validTool)) {
    throw new HttpError(400, 'tools are invalid');
  }
  const names = body.tools.map((tool) => tool.name);
  if (new Set(names).size !== names.length) throw new HttpError(400, 'tool names must be unique');
  if (body.askOnly !== undefined && typeof body.askOnly !== 'boolean') {
    throw new HttpError(400, 'askOnly must be a boolean');
  }
  const requestedModel = body.model === undefined ? '' : shortString(body.model, 'model', 256).trim();
  const savedModel = getKey('COPILOT_MODEL').trim().slice(0, 256);
  const hasRequestedEffort = body.reasoningEffort !== undefined;
  const requestedEffort = body.reasoningEffort === null || body.reasoningEffort === undefined
    ? ''
    : shortString(body.reasoningEffort, 'reasoningEffort', 64).trim();
  if (requestedEffort && !reasoningEffort(requestedEffort)) {
    throw new HttpError(400, 'reasoningEffort is invalid');
  }
  const savedEffort = reasoningEffort(getKey('COPILOT_REASONING_EFFORT').trim()) ?? '';
  const resolvedEffort = hasRequestedEffort ? requestedEffort : savedEffort;
  return {
    requestId: shortString(body.requestId, 'requestId', 128),
    system: shortString(body.system, 'system', 1024 * 1024),
    prompt: shortString(body.prompt, 'prompt', 2 * 1024 * 1024),
    projectId: shortString(body.projectId, 'projectId', 256),
    ...(requestedModel || savedModel ? { model: requestedModel || savedModel } : {}),
    ...(resolvedEffort ? { reasoningEffort: resolvedEffort } : {}),
    askOnly: body.askOnly === true,
    tools: body.tools,
  };
}

function toolResultRequest(body: Record<string, unknown>): CopilotToolResultRequest {
  if (typeof body.success !== 'boolean' || !('result' in body)) {
    throw new HttpError(400, 'tool result is invalid');
  }
  return {
    requestId: shortString(body.requestId, 'requestId', 128),
    callId: shortString(body.callId, 'callId', 256),
    success: body.success,
    result: body.result,
  };
}

function ndjsonWriter(res: ServerResponse): (event: CopilotTurnStreamEvent) => void {
  let terminal = false;
  return (event) => {
    if (terminal) return;
    if (event.type === 'done' || event.type === 'error') terminal = true;
    if (!res.destroyed && !res.writableEnded) res.write(`${JSON.stringify(event)}\n`);
  };
}

async function streamTurn(req: IncomingMessage, res: ServerResponse, body: Record<string, unknown>): Promise<void> {
  const request = parseCopilotTurnRequest(body);
  if (hasCopilotRequest(request.requestId)) throw new HttpError(409, 'requestId is already active');
  await requireInstallation();
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
    await runCopilotTurn(request, emit, controller.signal);
  } catch {
    emit({ type: 'error', message: 'Copilot could not run this turn.' });
  } finally {
    finished = true;
    req.off('aborted', disconnect);
    res.off('close', disconnect);
    if (!res.destroyed && !res.writableEnded) res.end();
  }
}

function routePath(req: IncomingMessage): string {
  const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
  return pathname.startsWith('/api/copilot') ? pathname.slice('/api/copilot'.length) || '/' : pathname;
}

async function handleCopilotRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const path = routePath(req);
  if (path === '/status' && req.method === 'GET') return sendJson(res, 200, await copilotStatus());
  if (path === '/models' && req.method === 'GET') return sendJson(res, 200, await copilotModels());
  if (path === '/turn' && req.method === 'POST') return streamTurn(req, res, await readJson(req));
  if (path === '/tool-result' && req.method === 'POST') {
    const outcome = settleToolResult(toolResultRequest(await readJson(req, TOOL_RESULT_BODY_LIMIT)));
    if (outcome === 'unknown-request') throw new HttpError(404, 'unknown or completed requestId');
    if (outcome === 'unknown-call') throw new HttpError(404, 'unknown or completed callId');
    return sendJson(res, 200, { ok: true });
  }
  const known = ['/status', '/models', '/turn', '/tool-result'];
  if (known.includes(path)) throw new HttpError(405, 'method not allowed');
  throw new HttpError(404, 'not found');
}

function handleFailure(res: ServerResponse, error: unknown): void {
  if (res.headersSent) {
    if (!res.writableEnded && !res.destroyed) res.end();
    return;
  }
  if (error instanceof HttpError) sendJson(res, error.status, { error: error.message });
  else if (error instanceof CopilotProcessError) sendJson(res, 503, { error: error.message });
  else sendJson(res, 500, { error: 'Copilot request failed.' });
}

export function copilotAgentPlugin(): Plugin {
  return {
    name: 'openchatcut-copilot-agent',
    configureServer(server) {
      server.middlewares.use('/api/copilot', (req, res) => {
        void handleCopilotRequest(req, res).catch((error) => handleFailure(res, error));
      });
      server.httpServer?.once('close', () => {
        void stopCopilotClient();
      });
    },
  };
}

/**
 * Internal server-side entry for the Agent run executor: runs one Copilot turn
 * through the same turn manager the HTTP bridge uses, without an HTTP round
 * trip. The executor feeds tool results back via `settleToolResult`.
 */
export async function runServerCopilotTurn(
  request: CopilotTurnRequest,
  emit: (event: CopilotTurnStreamEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  if (hasCopilotRequest(request.requestId)) throw new Error('requestId is already active');
  await requireInstallation();
  await runCopilotTurn(request, emit, signal);
}
