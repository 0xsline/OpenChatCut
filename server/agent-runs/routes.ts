import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin } from 'vite';
import {
  defaultModelForProvider,
  normalizeLlmProvider,
  normalizeOpenAiApiMode,
} from '../../shared/llm-providers';
import { resolveLlmProviderConfig } from '../llm-config';
import { getKey, type KeyName } from '../keystore';
import { activateOfflineAgentRuntimeBackend } from '../external-agent/agent-runtime-persistence';
import { executeRun, type ServerRunInput } from './executor';
import { resolveServerRunToolCatalog } from './tool-policy';
import {
  cancelRun,
  claimToolRequest,
  createRunWithPresentedCapability,
  flushRunPersistence,
  getRun,
  prepareRunAdmission,
  recoverServerRun,
  verifyServerRunCapability,
  replayWindow,
  settleToolResult,
  RunStoreLimitError,
  type ServerRun,
  type ToolClaimOutcome,
  type ToolResultOutcome,
} from './store';
import {
  settleServerRun,
  type ProposalRuntimeStatus,
  type ServerRunSettleStatus,
} from './store-settle';
import { digestValue } from './store-values';
import {
  readJson,
  requestHeader,
  requestOrigin,
  requireProjectId,
  validateCreateInput,
  type ValidatedCreateInput,
} from './request';
import { CursorProtocolError, resolveCursor, sseForRun } from './sse';
import { projectStoreHttpAuthorized, projectStoreReadAuthorized } from '../project-store-http-auth';
const MAX_TOOL_RESULT_BODY_BYTES = 1024 * 1024;
const SERVER_RUN_CAPABILITY_HEADER = 'x-openchatcut-run-capability';
const SERVER_RUN_ADMISSION_TIMEOUT_MS = 60_000;
interface DeferredRun {
  readonly input: ServerRunInput;
  readonly timeout: NodeJS.Timeout;
}
const deferredRuns = new Map<string, DeferredRun>();
const startedRuns = new Set<string>();

function deferRunExecution(run: ServerRun, input: ServerRunInput): void {
  const timeout = setTimeout(() => {
    if (!deferredRuns.delete(run.id)) return;
    void cancelRun(run);
  }, SERVER_RUN_ADMISSION_TIMEOUT_MS);
  deferredRuns.set(run.id, { input, timeout });
}

function startDeferredRun(run: ServerRun): 'started' | 'already_started' | 'unavailable' {
  const deferred = deferredRuns.get(run.id);
  if (!deferred) {
    return startedRuns.has(run.id) || run.status !== 'queued'
      ? 'already_started'
      : 'unavailable';
  }
  deferredRuns.delete(run.id);
  clearTimeout(deferred.timeout);
  startedRuns.add(run.id);
  void executeRun(run, deferred.input).finally(() => startedRuns.delete(run.id));
  return 'started';
}

function discardDeferredRun(runId: string): void {
  const deferred = deferredRuns.get(runId);
  if (deferred) clearTimeout(deferred.timeout);
  deferredRuns.delete(runId);
}


function sendJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.destroyed || res.writableEnded) return;
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

function outcomeStatus(outcome: ToolClaimOutcome | ToolResultOutcome): number {
  if (outcome === 'unknown-call') return 404;
  return outcome === 'mismatch' || outcome === 'unclaimed'
    || outcome === 'already-claimed' || outcome === 'run-settled'
    ? 409
    : 200;
}



async function boundRun(
  req: IncomingMessage,
  res: ServerResponse,
  projectId: string,
  runId: string,
): Promise<ServerRun | null> {
  const current = getRun(runId);
  if (
    current
    && !verifyServerRunCapability(
      current.capabilityVerifier,
      requestHeader(req, SERVER_RUN_CAPABILITY_HEADER),
    )
  ) {
    sendJson(res, 403, { error: 'invalid run capability' });
    return null;
  }
  if (current && current.projectId !== projectId) {
    sendJson(res, 409, { error: 'projectId does not match the run' });
    return null;
  }
  const run = await recoverServerRun(projectId, runId);
  if (!run) {
    sendJson(res, 404, { error: 'run not found' });
    return null;
  }
  if (!current && !verifyServerRunCapability(
    run.capabilityVerifier,
    requestHeader(req, SERVER_RUN_CAPABILITY_HEADER),
  )) {
    sendJson(res, 403, { error: 'invalid run capability' });
    return null;
  }
  return run;
}
function runRequestDigests(
  input: ValidatedCreateInput,
  execution: ServerRunInput,
  askOnly: boolean,
  sessionGeneration: string,
): { readonly userInputDigest: string; readonly requestShapeHash: string } {
  const userInputDigest = digestValue(input.messages);
  return {
    userInputDigest,
    requestShapeHash: digestValue({
      projectId: input.projectId,
      sessionGeneration,
      userInputDigest,
      askOnly,
      references: input.references,
      externalSessionId: input.externalSessionId,
      context: input.context,
      provider: execution.provider,
      model: execution.model,
      openAiApiMode: execution.openAiApiMode,
      cacheMode: execution.cacheMode,
      maxOutputTokens: execution.maxOutputTokens,
      tools: execution.tools,
      instructions: execution.instructions,
    }),
  };
}
function sendCreatedRun(
  res: ServerResponse,
  run: ServerRun,
  capability: string,
  status: 200 | 201,
): void {
  sendJson(res, status, {
    id: run.id,
    sessionGeneration: run.sessionGeneration,
    projectId: run.projectId,
    capability,
    askOnly: run.askOnly,
    references: run.references,
    externalSessionId: run.externalSessionId ?? null,
    context: run.context ?? null,
  });
}

function ensureDeferredRunExecution(run: ServerRun, input: ServerRunInput): void {
  if (run.status !== 'queued' || deferredRuns.has(run.id) || startedRuns.has(run.id)) return;
  deferRunExecution(run, input);
}



async function handleCreate(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJson(req);
  const input = validateCreateInput(body);
  const askOnly = body.askOnly === true;
  const origin = requestOrigin(req);
  if (!origin) return sendJson(res, 400, { error: 'valid request host is required' });
  const provider = typeof body.provider === 'string' ? body.provider.trim() : '';
  const requestedModel = input.model;
  const backend = body.backend === 'codex' ? 'codex' : 'api';
  const readKey = (name: string): string => getKey(name as KeyName);
  const codexBackend = backend === 'codex';
  const config = codexBackend
    ? { provider: 'openai', model: '' }
    : resolveLlmProviderConfig(provider || getKey('LLM_PROVIDER'), readKey);
  const effectiveProvider = normalizeLlmProvider(config.provider);
  const effectiveModel = requestedModel || config.model || defaultModelForProvider(effectiveProvider);
  const openAiApiMode = normalizeOpenAiApiMode(body.openAiApiMode);
  const tools = resolveServerRunToolCatalog(input.tools, askOnly);
  const existing = getRun(input.runId)
    ?? await recoverServerRun(input.projectId, input.runId);
  const sessionGeneration = existing?.sessionGeneration
    ?? await prepareRunAdmission(input.projectId);
  const execution: ServerRunInput = {
    messages: input.messages,
    backend,
    provider: effectiveProvider,
    model: effectiveModel,
    openAiApiMode,
    cacheMode: input.cacheMode,
    maxOutputTokens: input.maxOutputTokens,
    origin,
    tools,
    instructions: input.instructions,
  };
  const digests = runRequestDigests(input, execution, askOnly, sessionGeneration);
  if (existing) {
    const matches = existing.projectId === input.projectId
      && verifyServerRunCapability(existing.capabilityVerifier, input.capability)
      && existing.requestShapeHash === digests.requestShapeHash;
    if (!matches) {
      sendJson(res, 409, { error: 'Agent run identity already exists with different input.' });
      return;
    }
    ensureDeferredRunExecution(existing, execution);
    sendCreatedRun(res, existing, input.capability, 200);
    return;
  }
  const { run, capability } = createRunWithPresentedCapability({
    id: input.runId,
    projectId: input.projectId,
    sessionGeneration,
    backend,
    provider: effectiveProvider,
    model: effectiveModel,
    askOnly,
    references: input.references,
    ...(input.externalSessionId ? { externalSessionId: input.externalSessionId } : {}),
    ...(input.context !== undefined ? { context: input.context } : {}),
    ...digests,
  }, input.capability);
  await flushRunPersistence(run);
  deferRunExecution(run, execution);
  sendCreatedRun(res, run, capability, 201);
}

async function handleStart(req: IncomingMessage, res: ServerResponse, runId: string): Promise<void> {
  const body = await readJson(req);
  const projectId = requireProjectId(body.projectId);
  const run = await boundRun(req, res, projectId, runId);
  if (!run) return;
  const outcome = startDeferredRun(run);
  if (outcome === 'unavailable') {
    return sendJson(res, 409, { error: 'agent run admission is no longer available' });
  }
  sendJson(res, outcome === 'started' ? 202 : 200, { ok: true, outcome });
}

async function handleEvents(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  runId: string,
): Promise<void> {
  const projectId = requireProjectId(url.searchParams.get('projectId'));
  const run = await boundRun(req, res, projectId, runId);
  if (!run) return;
  await flushRunPersistence(run);
  sseForRun(req, res, run, resolveCursor(req, url, run));
}

function toolBinding(body: Record<string, unknown>) {
  const toolCallId = typeof body.toolCallId === 'string' ? body.toolCallId.trim() : '';
  const argsDigest = typeof body.argsDigest === 'string' ? body.argsDigest.trim() : '';
  const claimId = typeof body.claimId === 'string' ? body.claimId.trim() : '';
  if (!toolCallId || !argsDigest || !claimId) {
    throw new Error('toolCallId, argsDigest, and claimId are required');
  }
  return { toolCallId, argsDigest, claimId };
}

async function handleToolClaim(req: IncomingMessage, res: ServerResponse, runId: string): Promise<void> {
  const body = await readJson(req);
  const projectId = requireProjectId(body.projectId);
  const run = await boundRun(req, res, projectId, runId);
  if (!run) return;
  const outcome = claimToolRequest(run, toolBinding(body));
  sendJson(res, outcomeStatus(outcome), {
    claimed: outcome === 'claimed' || outcome === 'duplicate',
    outcome,
  });
}

async function handleToolResult(req: IncomingMessage, res: ServerResponse, runId: string): Promise<void> {
  const body = await readJson(req, MAX_TOOL_RESULT_BODY_BYTES);
  const projectId = requireProjectId(body.projectId);
  const run = await boundRun(req, res, projectId, runId);
  if (!run) return;
  const binding = toolBinding(body);
  const hasResult = Object.hasOwn(body, 'result');
  const error = typeof body.error === 'string' ? body.error : undefined;
  const hasError = Object.hasOwn(body, 'error');
  if (hasResult === hasError || (hasError && error === undefined)) {
    throw new Error('provide exactly one of result or string error');
  }
  const outcome = settleToolResult(run, {
    ...binding,
    ...(error === undefined ? { result: body.result } : { error }),
  });
  sendJson(res, outcomeStatus(outcome), {
    ok: outcome === 'accepted' || outcome === 'duplicate',
    outcome,
  });
}

async function handleCancel(req: IncomingMessage, res: ServerResponse, runId: string): Promise<void> {
  const body = await readJson(req);
  const projectId = requireProjectId(body.projectId);
  const run = await boundRun(req, res, projectId, runId);
  if (!run) return;
  await cancelRun(run);
  discardDeferredRun(run.id);
  sendJson(res, 200, { ok: true, status: run.status });
}

async function handleSettle(req: IncomingMessage, res: ServerResponse, runId: string): Promise<void> {
  const body = await readJson(req);
  const projectId = requireProjectId(body.projectId);
  const status = typeof body.status === 'string' ? body.status : '';
  const SETTLE_STATUSES: Record<string, true> = {
    completed: true, failed: true, aborted: true, interrupted: true, waiting_approval: true,
  };
  if (!SETTLE_STATUSES[status]) {
    sendJson(res, 400, { error: 'invalid settle status' });
    return;
  }
  const proposalId = typeof body.proposalId === 'string' ? body.proposalId.trim() : undefined;
  const proposalRuntimeStatus = typeof body.proposalRuntimeStatus === 'string'
    ? body.proposalRuntimeStatus
    : undefined;
  const summary = typeof body.summary === 'string' ? body.summary : undefined;
  const outcome = await settleServerRun(projectId, runId, {
    status: status as ServerRunSettleStatus,
    ...(proposalId ? { proposalId } : {}),
    ...(proposalRuntimeStatus ? { proposalRuntimeStatus: proposalRuntimeStatus as ProposalRuntimeStatus } : {}),
    ...(summary !== undefined ? { summary } : {}),
  });
  sendJson(res, 200, { ok: outcome === 'ok', already: outcome === 'already', gone: outcome === 'gone' });
}

async function handleMetadata(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  runId: string,
): Promise<void> {
  const projectId = requireProjectId(url.searchParams.get('projectId'));
  const run = await boundRun(req, res, projectId, runId);
  if (!run) return;
  const window = replayWindow(run);
  sendJson(res, 200, {
    id: run.id,
    sessionGeneration: run.sessionGeneration,
    projectId: run.projectId,
    provider: run.provider,
    model: run.model,
    askOnly: run.askOnly,
    references: run.references,
    externalSessionId: run.externalSessionId ?? null,
    context: run.context ?? null,
    status: run.status,
    createdAt: run.createdAt,
    error: run.error,
    eventCount: run.events.length,
    firstEventId: window.firstEventId,
    lastEventId: window.lastEventId,
  });
}

async function routeAgentRunRequest(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  const pathname = url.pathname;
  if (req.method === 'POST' && pathname === '/') return handleCreate(req, res);
  const match = /^\/([0-9a-f-]{36})(?:\/(start|events|tool-claim|tool-result|cancel))?$/.exec(pathname);
  if (!match) return sendJson(res, 404, { error: 'not found' });
  const runId = match[1]!;
  const action = match[2];
  if (req.method === 'GET' && action === 'events') return handleEvents(req, res, url, runId);
  if (req.method === 'POST' && action === 'start') return handleStart(req, res, runId);
  if (req.method === 'POST' && action === 'tool-claim') return handleToolClaim(req, res, runId);
  if (req.method === 'POST' && action === 'tool-result') return handleToolResult(req, res, runId);
  if (req.method === 'POST' && action === 'cancel') return handleCancel(req, res, runId);
  if (req.method === 'POST' && action === 'settle') return handleSettle(req, res, runId);
  if (req.method === 'GET' && !action) return handleMetadata(req, res, url, runId);
  sendJson(res, 404, { error: 'not found' });
}

function sendRouteError(res: ServerResponse, error: unknown): void {
  if (error instanceof RunStoreLimitError) {
    res.setHeader('Retry-After', '1');
    sendJson(res, 429, { error: error.message, retryable: true });
    return;
  }
  if (error instanceof CursorProtocolError) {
    sendJson(res, error.status, { error: error.message, ...(error.details ?? {}) });
    return;
  }
  const message = error instanceof Error ? error.message : String(error);
  sendJson(res, message === 'request body too large' ? 413 : 400, { error: message });
}

function mountedUrl(req: IncomingMessage): URL {
  const mounted = req.url ?? '';
  const stripped = mounted.startsWith('/api/agent-runs')
    ? mounted.slice('/api/agent-runs'.length) || '/'
    : mounted;
  return new URL(stripped, 'http://localhost');
}

export interface AgentRunsPluginOptions {
  readonly activatePersistence?: () => void;
}

export function agentRunsPlugin(options: AgentRunsPluginOptions = {}): Plugin {
  return {
    name: 'openchatcut-agent-runs',
    configureServer(server) {
      (options.activatePersistence ?? activateOfflineAgentRuntimeBackend)();
      server.middlewares.use('/api/agent-runs', async (req, res) => {
        const readOnly = req.method === 'GET';
        const authorized = readOnly
          ? projectStoreReadAuthorized(req) || projectStoreHttpAuthorized(req)
          : projectStoreHttpAuthorized(req);
        if (!authorized) {
          sendJson(res, 403, { error: 'invalid agent run session' });
          return;
        }
        try {
          await routeAgentRunRequest(req, res, mountedUrl(req));
        } catch (error) {
          sendRouteError(res, error);
        }
      });
    },
  };
}
