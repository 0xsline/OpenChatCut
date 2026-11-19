import { continueServerRun } from './run-continuation';
import { withRecoveryBaseline } from './run-recovery-metadata';
import { executeRun } from './executor';
import { createToolRouteHandlers } from './tool-routes';
import { supportsDurableRunRecovery } from './run-recovery-store';
import { cancelRunRecovery, runRecoveryKeyOf, readRunRecoveryProjection, sweepRunRecovery } from './run-recovery-runtime';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin } from 'vite';
import { activateOfflineAgentRuntimeBackend } from '../external-agent/agent-runtime-persistence';
import { resolveRunExecution, runRequestDigests } from './execution-input';
import {
  cancelRun,
  createRunWithPresentedCapability,
  flushRunPersistence,
  getRun,
  isRunTerminal,
  prepareRunAdmission,
  recoverServerRun,
  verifyServerRunCapability,
  replayWindow,
  RunStoreLimitError,
  type ServerRun,
} from './store';
import {
  settleServerRun,
  type ProposalRuntimeStatus,
  type ServerRunSettleStatus,
} from './store-settle';
import { deleteAgentArtifacts, loadAgentRuntimeSidecar, storeAgentArtifact } from '../../src/persist/agentRuntimeStore';
import { MAX_ARTIFACT_BYTES } from '../../src/persist/agentRuntimeTypes';
import { sha256Text } from '../../src/persist/agentRuntimeStore';
import {
  readJson,
  requestHeader,
  requestOrigin,
  requireProjectId,
  validateCreateInput,
} from './request';
import { CursorProtocolError, resolveCursor, sseForRun } from './sse';
import {
  deferRunExecution,
  discardDeferredRun,
  ensureDeferredRunExecution,
  startDeferredRun,
  startResumedRun,
  resumeStartRequest,
  hasDeferredRun,
} from './run-admission';
import { projectStoreHttpAuthorized, projectStoreReadAuthorized } from '../project-store-http-auth';
/**
 * Draft artifacts are contracted at MAX_ARTIFACT_BYTES (8 MiB) by the producer,
 * the snapshot validation, and the durable store. The request envelope embeds
 * that already-serialized JSON body as a string, so every quote and backslash
 * in it is escaped again — roughly 2x in the worst realistic case. Sizing the
 * transport below the artifact cap is what produced 413s on large drafts while
 * the client's own guard said the draft was fine.
 *
 * This bound only keeps an unbounded upload out of memory; storeAgentArtifact
 * recomputes the real size after parsing and still rejects anything over the
 * artifact cap with 409.
 */
export const MAX_DRAFT_BODY_BYTES = MAX_ARTIFACT_BYTES * 2 + 64 * 1024;
const SERVER_RUN_CAPABILITY_HEADER = 'x-openchatcut-run-capability';

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.destroyed || res.writableEnded) return;
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

function rejectCapability(res: ServerResponse, run: ServerRun): void {
  sendJson(res, 403, isRunTerminal(run)
    ? { error: 'run already finished' }
    : { error: 'invalid run capability' });
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
    rejectCapability(res, current);
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
    rejectCapability(res, run);
    return null;
  }
  return run;
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


async function handleCreate(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJson(req);
  const input = validateCreateInput(body);
  const askOnly = body.askOnly === true;
  const origin = requestOrigin(req);
  if (!origin) return sendJson(res, 400, { error: 'valid request host is required' });
  const execution = resolveRunExecution(body, input, origin, askOnly);
  const existing = getRun(input.runId)
    ?? await recoverServerRun(input.projectId, input.runId);
  const sessionGeneration = existing?.sessionGeneration
    ?? await prepareRunAdmission(input.projectId);
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
    backend: execution.backend,
    provider: execution.provider,
    model: execution.model,
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

async function handleStart(req: IncomingMessage, res: ServerResponse, runId: string, execute = executeRun): Promise<void> {
  const body = await readJson(req);
  const projectId = requireProjectId(body.projectId);
  const run = await boundRun(req, res, projectId, runId);
  if (!run) return;
  if (body.mode === 'continue') {
    return continueServerRun(run, body, requestOrigin(req) ?? 'http://127.0.0.1', res, sendJson, execute);
  }
  const resume = resumeStartRequest(body);
  if (resume.mode === 'resume') {
    const resumed = startResumedRun(run, resume, requestOrigin(req) ?? 'http://127.0.0.1', execute);
    if (!resumed.ok) {
      sendJson(res, resumed.status, {
        error: resumed.reason,
        recovery: { state: readRunRecoveryProjection(runRecoveryKeyOf(run), 0)?.state },
      });
      return;
    }
    const status = resumed.outcome === 'started' ? 202 : 200;
    sendJson(res, status, { ok: true, outcome: resumed.outcome, mode: 'resume' });
    return;
  }
  const projection = supportsDurableRunRecovery(run.backend) ? readRunRecoveryProjection(runRecoveryKeyOf(run), 0) : null;
  if (projection?.state === 'admitted' && !hasDeferredRun(run.id)) {
    const resumed = startResumedRun(run, { mode: 'resume', expectedRevision: projection.revision },
      requestOrigin(req) ?? 'http://127.0.0.1', execute);
    if (!resumed.ok) return sendJson(res, resumed.status, { error: resumed.reason });
    return sendJson(res, resumed.outcome === 'started' ? 202 : 200, { ok: true, outcome: resumed.outcome });
  }
  if (projection && projection.state !== 'admitted' && projection.state !== 'active') {
    return sendJson(res, 409, { error: 'use the recovery handshake to resume this task' });
  }
  const outcome = startDeferredRun(run, execute);
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

const { handleToolClaim, handleToolResult } = createToolRouteHandlers({ boundRun, sendJson });

async function handleCancel(req: IncomingMessage, res: ServerResponse, runId: string): Promise<void> {
  const body = await readJson(req);
  const projectId = requireProjectId(body.projectId);
  const run = await boundRun(req, res, projectId, runId);
  if (!run) return;
  await cancelRun(run);
  discardDeferredRun(run.id);
  if (supportsDurableRunRecovery(run.backend)) {
    cancelRunRecovery(run);
  }
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
  const PROPOSAL_RUNTIME_STATUSES: Record<string, true> = {
    created: true, applied: true, rejected: true, stale: true, reproposed: true,
  };
  if (proposalRuntimeStatus !== undefined && !PROPOSAL_RUNTIME_STATUSES[proposalRuntimeStatus]) {
    sendJson(res, 400, { error: 'invalid proposal runtime status' });
    return;
  }
  const summary = typeof body.summary === 'string' ? body.summary : undefined;
  // Settlement is idempotent and only writes terminal/proposal state, so it
  // deliberately does not require the run-capability handshake: a tab that
  // lost its stored capability (crash, second tab) must still be able to
  // settle, and the request-shape gate already fences this endpoint to
  // same-origin pages. A terminal settle discards any deferred admission
  // and stops an in-flight executor so no events land after the final
  // event; a waiting_approval settle must not cancel a live model stream.
  if (status !== 'waiting_approval') {
    discardDeferredRun(runId);
    const live = getRun(runId);
    // A completed settle that arrives while the model finished naturally
    // (no pending tool, finish event already emitted) must not flip the
    // run to cancelled: the server's own terminal write is in flight.
    const naturallyFinished = status === 'completed'
      && live !== undefined
      && live.projectId === projectId
      && live.events.some((event) => event.type === 'finish')
      && [...live.toolRequests.values()].every((request) => request.status !== 'pending');
    if (live
      && live.projectId === projectId
      && !naturallyFinished) {
      await cancelRun(live).catch(() => undefined);
      if (supportsDurableRunRecovery(live.backend)) cancelRunRecovery(live);
    }
  }
  const outcome = await settleServerRun(projectId, runId, {
    status: status as ServerRunSettleStatus,
    ...(proposalId ? { proposalId } : {}),
    ...(proposalRuntimeStatus ? { proposalRuntimeStatus: proposalRuntimeStatus as ProposalRuntimeStatus } : {}),
    ...(summary !== undefined ? { summary } : {}),
  });
  sendJson(res, 200, { ok: outcome === 'ok', already: outcome === 'already', gone: outcome === 'gone' });
}

async function handleDraftStore(req: IncomingMessage, res: ServerResponse, runId: string): Promise<void> {
  const body = await readJson(req, MAX_DRAFT_BODY_BYTES);
  const projectId = requireProjectId(body.projectId);
  const run = await boundRun(req, res, projectId, runId);
  if (!run) return;
  const artifact = body.artifact as Record<string, unknown> | undefined;
  if (!artifact || typeof artifact !== 'object') {
    sendJson(res, 400, { error: 'draft artifact is required' });
    return;
  }
  const rawBody = typeof artifact.body === 'string' ? artifact.body : '';
  const accepted = await storeAgentArtifact({
    version: 1,
    artifactId: typeof artifact.artifactId === 'string' ? artifact.artifactId : '',
    projectId,
    runId,
    kind: 'server-run-draft',
    // Recompute server-side: never trust client-claimed digests/sizes.
    bodySha256: await sha256Text(rawBody),
    originalBytes: new TextEncoder().encode(rawBody).byteLength,
    originalChars: rawBody.length,
    createdAt: Date.now(),
    redacted: artifact.redacted === true,
    binaryOmitted: artifact.binaryOmitted === true,
    body: rawBody,
    ...(typeof artifact.toolCallId === 'string' ? { toolCallId: artifact.toolCallId } : {}),
    ...(typeof artifact.toolName === 'string' ? { toolName: artifact.toolName } : {}),
  });
  if (!accepted) {
    sendJson(res, 409, { error: 'draft artifact was rejected (invalid, duplicate, or over the limit)' });
    return;
  }
  sendJson(res, 200, { ok: true });
}

async function handleDraftClear(req: IncomingMessage, res: ServerResponse, runId: string): Promise<void> {
  const body = await readJson(req);
  const projectId = requireProjectId(body.projectId);
  const run = await boundRun(req, res, projectId, runId);
  if (!run) return;
  const sidecar = await loadAgentRuntimeSidecar(projectId);
  const artifactIds = sidecar.artifacts
    .filter((artifact) => artifact.runId === runId && artifact.kind === 'server-run-draft')
    .map((artifact) => artifact.artifactId);
  await deleteAgentArtifacts(projectId, artifactIds);
  sendJson(res, 200, { ok: true });
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
  // The recovery block is additive: runs without a recovery row (Copilot
  // and historical API/subprocess runs) keep their existing metadata shape, and reading
  // this endpoint never acquires execution authority or starts a model.
  const recovery = supportsDurableRunRecovery(run.backend)
    ? withRecoveryBaseline(run, window, readRunRecoveryProjection(runRecoveryKeyOf(run), window.lastEventId))
    : null;
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
    ...(recovery ? { recovery } : {}),
  });
}

async function routeAgentRunRequest(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  execute = executeRun,
): Promise<void> {
  const pathname = url.pathname;
  if (req.method === 'POST' && pathname === '/') return handleCreate(req, res);
  const match = /^\/([0-9a-f-]{36})(?:\/(start|events|tool-claim|tool-result|cancel|settle|draft|draft\/clear))?$/.exec(pathname);
  if (!match) return sendJson(res, 404, { error: 'not found' });
  const runId = match[1]!;
  const action = match[2];
  if (req.method === 'GET' && action === 'events') return handleEvents(req, res, url, runId);
  if (req.method === 'POST' && action === 'start') return handleStart(req, res, runId, execute);
  if (req.method === 'POST' && action === 'tool-claim') return handleToolClaim(req, res, runId);
  if (req.method === 'POST' && action === 'tool-result') return handleToolResult(req, res, runId);
  if (req.method === 'POST' && action === 'cancel') return handleCancel(req, res, runId);
  if (req.method === 'POST' && action === 'settle') return handleSettle(req, res, runId);
  if (req.method === 'POST' && action === 'draft') return handleDraftStore(req, res, runId);
  if (req.method === 'POST' && action === 'draft/clear') return handleDraftClear(req, res, runId);
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
    const details = error.details && typeof error.details === 'object' && !Array.isArray(error.details)
      ? error.details : {};
    sendJson(res, error.status, Object.assign({ error: error.message }, details));
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
  readonly executeRun?: typeof executeRun;
}

export function agentRunsPlugin(options: AgentRunsPluginOptions = {}): Plugin {
  return {
    name: 'openchatcut-agent-runs',
    configureServer(server) {
      (options.activatePersistence ?? activateOfflineAgentRuntimeBackend)();
      // Startup retention sweep: finalized recovery rows expire, runs that still
      // wait for reconciliation are kept until the user decides.
      try {
        sweepRunRecovery();
      } catch (error) {
        server.config.logger.warn(
          `[agent-runs] Agent recovery retention sweep skipped: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
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
          await routeAgentRunRequest(req, res, mountedUrl(req), options.executeRun);
        } catch (error) {
          sendRouteError(res, error);
        }
      });
    },
  };
}
