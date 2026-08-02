import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin } from 'vite';
import type {
  CodexAccountSummary,
  CodexAgentModel,
  CodexAgentModelsResponse,
  CodexAgentStatus,
  CodexLoginMode,
  CodexLoginStartResponse,
  CodexToolResultRequest,
  CodexTurnRequest,
  CodexTurnStreamEvent,
} from '../../shared/codex-agent.ts';
import { getKey } from '../keystore.ts';
import {
  CodexAppServerClient,
  CodexProcessError,
  CodexRpcError,
  CodexTimeoutError,
} from '../codex/app-server.ts';
import {
  inspectCodexInstallation,
  MINIMUM_CODEX_VERSION,
  type CodexInstallation,
} from '../codex/installation.ts';
import { codexTurnManager } from '../codex/turn-manager.ts';

const JSON_BODY_LIMIT = 4 * 1024 * 1024;
const TOOL_RESULT_BODY_LIMIT = 32 * 1024 * 1024;
const MODEL_LIST_TIMEOUT_MS = 6_000;
const ACCOUNT_READ_TIMEOUT_MS = 8_000;
const OFFICIAL_LOGIN_HOSTS = ['openai.com', 'chatgpt.com'] as const;

class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

let activeClient: CodexAppServerClient | null = null;

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
  return `OpenAI Codex ${MINIMUM_CODEX_VERSION} or newer is required. Update Codex and try again.`;
}

function unavailableMessage(installation: CodexInstallation): string {
  if (!installation.installed) return 'OpenAI Codex CLI is not installed.';
  if (!installation.supported) return unsupportedMessage();
  return 'Codex app-server is unavailable.';
}

async function requireClient(): Promise<{ installation: CodexInstallation; client: CodexAppServerClient }> {
  const installation = await inspectCodexInstallation();
  if (!installation.path || !installation.supported) {
    throw new HttpError(503, unavailableMessage(installation));
  }
  if (activeClient?.executablePath !== installation.path) {
    activeClient?.stop();
    activeClient = new CodexAppServerClient(installation.path);
  }
  if (!activeClient) throw new HttpError(503, unavailableMessage(installation));
  return { installation, client: activeClient };
}

function accountSummary(value: unknown): CodexAccountSummary | null {
  const account = object(value);
  if (account?.type === 'apiKey') return { type: 'apiKey', email: null, planType: null };
  if (account?.type !== 'chatgpt') return null;
  return {
    type: 'chatgpt',
    email: typeof account.email === 'string' ? account.email : null,
    planType: typeof account.planType === 'string' ? account.planType : null,
  };
}

async function codexStatus(): Promise<CodexAgentStatus> {
  const installation = await inspectCodexInstallation();
  if (!installation.installed) {
    activeClient?.stop();
    activeClient = null;
    return { installed: false, version: null, account: null, loginPending: false };
  }
  if (!installation.supported || !installation.path) {
    activeClient?.stop();
    activeClient = null;
    return {
      installed: true,
      version: installation.version,
      account: null,
      loginPending: false,
      error: unsupportedMessage(),
    };
  }
  try {
    const { client } = await requireClient();
    const response = object(await client.request(
      'account/read',
      { refreshToken: false },
      { timeoutMs: ACCOUNT_READ_TIMEOUT_MS, restartOnTimeout: true },
    ));
    return {
      installed: true,
      version: installation.version,
      account: accountSummary(response?.account),
      loginPending: client.loginPending,
    };
  } catch {
    return {
      installed: true,
      version: installation.version,
      account: null,
      loginPending: activeClient?.loginPending ?? false,
      error: 'Codex app-server is unavailable. Restart OpenChatCut and try again.',
    };
  }
}

function reasoningEffort(value: unknown): string | null {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value) ? value : null;
}

function mapReasoningEfforts(value: unknown): CodexAgentModel['supportedReasoningEfforts'] {
  if (!Array.isArray(value)) return [];
  const efforts: Array<CodexAgentModel['supportedReasoningEfforts'][number]> = [];
  const seen = new Set<string>();
  for (const candidate of value) {
    const effort = object(candidate);
    const name = reasoningEffort(effort?.reasoningEffort);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    const description = typeof effort?.description === 'string' && effort.description.length <= 512
      ? effort.description.trim()
      : '';
    efforts.push({ reasoningEffort: name, description });
  }
  return efforts;
}

export function mapCodexModels(value: unknown): CodexAgentModel[] {
  const data = object(value)?.data;
  if (!Array.isArray(data)) throw new Error('invalid model response');
  const models: CodexAgentModel[] = [];
  const seen = new Set<string>();
  for (const candidate of data) {
    const model = object(candidate);
    const rawId = typeof model?.id === 'string' ? model.id : typeof model?.model === 'string' ? model.model : '';
    if (!rawId || rawId.length > 256 || seen.has(rawId) || model?.hidden === true) continue;
    seen.add(rawId);
    const displayName = typeof model?.displayName === 'string' && model.displayName.length <= 512
      ? model.displayName.trim()
      : '';
    const supportedReasoningEfforts = mapReasoningEfforts(model?.supportedReasoningEfforts);
    const defaultReasoningEffort = reasoningEffort(model?.defaultReasoningEffort);
    models.push({
      id: rawId,
      label: displayName || rawId,
      isDefault: model?.isDefault === true,
      defaultReasoningEffort,
      supportedReasoningEfforts,
    });
  }
  return models;
}

async function codexModels(): Promise<CodexAgentModelsResponse> {
  try {
    const { client } = await requireClient();
    const response = await client.request(
      'model/list',
      { limit: 100, includeHidden: false },
      { timeoutMs: MODEL_LIST_TIMEOUT_MS, restartOnTimeout: true },
    );
    return { models: mapCodexModels(response) };
  } catch (error) {
    const message = error instanceof CodexTimeoutError
      ? 'Codex model discovery timed out. Try again after Codex finishes starting.'
      : error instanceof HttpError
        ? error.message
        : 'Unable to discover Codex models. Try again.';
    return { models: [], error: message };
  }
}

function loginMode(value: unknown): CodexLoginMode {
  if (value === 'chatgpt' || value === 'chatgptDeviceCode') return value;
  throw new HttpError(400, 'mode must be chatgpt or chatgptDeviceCode');
}

function officialLoginUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 8_192) return null;
  try {
    const url = new URL(value);
    const official = OFFICIAL_LOGIN_HOSTS.some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`));
    if (url.protocol !== 'https:' || url.username || url.password || url.port || !official) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function loginResponse(value: unknown, mode: CodexLoginMode): CodexLoginStartResponse {
  const response = object(value);
  const loginId = typeof response?.loginId === 'string' && response.loginId.length <= 256
    ? response.loginId
    : null;
  if (!loginId || response?.type !== mode) throw new HttpError(503, 'Codex returned an invalid sign-in response.');
  if (mode === 'chatgpt') {
    const authUrl = officialLoginUrl(response.authUrl);
    if (!authUrl) throw new HttpError(503, 'Codex returned an invalid sign-in URL.');
    return { type: 'chatgpt', loginId, authUrl };
  }
  const verificationUrl = officialLoginUrl(response.verificationUrl);
  const userCode = typeof response.userCode === 'string' && /^[A-Za-z0-9-]{4,128}$/.test(response.userCode)
    ? response.userCode
    : null;
  if (!verificationUrl || !userCode) throw new HttpError(503, 'Codex returned invalid device sign-in metadata.');
  return { type: 'chatgptDeviceCode', loginId, verificationUrl, userCode };
}

async function startLogin(body: Record<string, unknown>): Promise<CodexLoginStartResponse> {
  const mode = loginMode(body.mode);
  const { client } = await requireClient();
  const value = await client.startLogin(mode);
  try {
    return loginResponse(value, mode);
  } catch (error) {
    const loginId = object(value)?.loginId;
    if (typeof loginId === 'string') void client.cancelLogin(loginId).catch(() => {});
    throw error;
  }
}

function shortString(value: unknown, name: string, limit: number): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > limit) {
    throw new HttpError(400, `${name} is invalid`);
  }
  return value;
}

function validTool(value: unknown): value is CodexTurnRequest['tools'][number] {
  const tool = object(value);
  return Boolean(
    tool
    && typeof tool.name === 'string'
    && /^[A-Za-z0-9_-]{1,128}$/.test(tool.name)
    && (tool.description === undefined || (typeof tool.description === 'string' && tool.description.length <= 16_384))
    && object(tool.inputSchema),
  );
}

export function parseCodexTurnRequest(body: Record<string, unknown>): CodexTurnRequest {
  if (!Array.isArray(body.tools) || body.tools.length > 512 || !body.tools.every(validTool)) {
    throw new HttpError(400, 'tools are invalid');
  }
  const names = body.tools.map((tool) => tool.name);
  if (new Set(names).size !== names.length) throw new HttpError(400, 'tool names must be unique');
  if (body.askOnly !== undefined && typeof body.askOnly !== 'boolean') {
    throw new HttpError(400, 'askOnly must be a boolean');
  }
  const requestedModel = body.model === undefined ? '' : shortString(body.model, 'model', 256).trim();
  const savedModel = getKey('CODEX_MODEL').trim().slice(0, 256);
  const hasRequestedEffort = body.reasoningEffort !== undefined;
  const requestedEffort = body.reasoningEffort === null || body.reasoningEffort === undefined
    ? ''
    : shortString(body.reasoningEffort, 'reasoningEffort', 64).trim();
  if (requestedEffort && !reasoningEffort(requestedEffort)) {
    throw new HttpError(400, 'reasoningEffort is invalid');
  }
  const savedEffort = reasoningEffort(getKey('CODEX_REASONING_EFFORT').trim()) ?? '';
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

function toolResultRequest(body: Record<string, unknown>): CodexToolResultRequest {
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

function ndjsonWriter(res: ServerResponse): (event: CodexTurnStreamEvent) => void {
  let terminal = false;
  return (event) => {
    if (terminal) return;
    if (event.type === 'done' || event.type === 'error') terminal = true;
    if (!res.destroyed && !res.writableEnded) res.write(`${JSON.stringify(event)}\n`);
  };
}

async function streamTurn(req: IncomingMessage, res: ServerResponse, body: Record<string, unknown>): Promise<void> {
  const request = parseCodexTurnRequest(body);
  if (codexTurnManager.hasRequest(request.requestId)) throw new HttpError(409, 'requestId is already active');
  const { client } = await requireClient();
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
    await codexTurnManager.run(client, request, emit, controller.signal);
  } catch {
    emit({ type: 'error', message: 'Codex could not run this turn.' });
  } finally {
    finished = true;
    req.off('aborted', disconnect);
    res.off('close', disconnect);
    if (!res.destroyed && !res.writableEnded) res.end();
  }
}

function routePath(req: IncomingMessage): string {
  const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
  return pathname.startsWith('/api/codex') ? pathname.slice('/api/codex'.length) || '/' : pathname;
}

async function handleCodexRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const path = routePath(req);
  if (path === '/status' && req.method === 'GET') return sendJson(res, 200, await codexStatus());
  if (path === '/models' && req.method === 'GET') return sendJson(res, 200, await codexModels());
  if (path === '/login/start' && req.method === 'POST') return sendJson(res, 200, await startLogin(await readJson(req)));
  if (path === '/login/cancel' && req.method === 'POST') {
    const body = await readJson(req);
    const { client } = await requireClient();
    if (body.loginId === undefined) await client.cancelPendingLogins();
    else await client.cancelLogin(shortString(body.loginId, 'loginId', 256));
    return sendJson(res, 200, { ok: true });
  }
  if (path === '/logout' && req.method === 'POST') {
    await readJson(req);
    const { client } = await requireClient();
    await client.logout();
    return sendJson(res, 200, { ok: true });
  }
  if (path === '/turn' && req.method === 'POST') return streamTurn(req, res, await readJson(req));
  if (path === '/tool-result' && req.method === 'POST') {
    const outcome = codexTurnManager.settleToolResult(toolResultRequest(await readJson(req, TOOL_RESULT_BODY_LIMIT)));
    if (outcome === 'unknown-request') throw new HttpError(404, 'unknown or completed requestId');
    if (outcome === 'unknown-call') throw new HttpError(404, 'unknown or completed callId');
    return sendJson(res, 200, { ok: true });
  }
  const known = ['/status', '/models', '/login/start', '/login/cancel', '/logout', '/turn', '/tool-result'];
  if (known.includes(path)) throw new HttpError(405, 'method not allowed');
  throw new HttpError(404, 'not found');
}

function handleFailure(res: ServerResponse, error: unknown): void {
  if (res.headersSent) {
    if (!res.writableEnded && !res.destroyed) res.end();
    return;
  }
  if (error instanceof HttpError) sendJson(res, error.status, { error: error.message });
  else if (error instanceof CodexProcessError || error instanceof CodexRpcError || error instanceof CodexTimeoutError) {
    sendJson(res, 503, { error: 'Codex app-server is unavailable. Try again.' });
  } else sendJson(res, 500, { error: 'Codex request failed.' });
}

export function codexAgentPlugin(): Plugin {
  return {
    name: 'openchatcut-codex-agent',
    configureServer(server) {
      server.middlewares.use('/api/codex', (req, res) => {
        void handleCodexRequest(req, res).catch((error) => handleFailure(res, error));
      });
      server.httpServer?.once('close', () => {
        activeClient?.stop();
        activeClient = null;
      });
    },
  };
}
