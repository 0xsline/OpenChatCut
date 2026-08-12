import { randomUUID } from 'node:crypto';
import type {
  AgentContextCheckpoint,
  AgentContextUsage,
} from '../../src/agent/context-compaction';
import {
  createAgentRun,
  type AgentRunContext,
} from '../../src/persist/agentRuntimeStore';
import {
  adoptAgentSessionWriteGeneration,
  currentAgentSessionGeneration,
} from '../../src/persist/agentSessionGeneration';
import {
  cancelRun as cancelRunInternal,
  mirrorTool as mirrorToolInternal,
  pushRunEvent as pushRunEventInternal,
  setRunStatus as setRunStatusInternal,
  updateRuntimeContext,
  waitForRunEvents as waitForRunEventsInternal,
  wakeSubscribers,
  type StoreEventDependencies,
} from './store-events';
import {
  persistServerCheckpoint as persistServerCheckpointInternal,
  recordServerContextUsage as recordServerContextUsageInternal,
  type StoreMetricsDependencies,
} from './store-metrics';
import {
  recoverServerRun as recoverServerRunInternal,
  recoverServerRuns as recoverServerRunsInternal,
  type StoreRecoveryDependencies,
} from './store-recovery';
import {
  claimToolRequest as claimToolRequestInternal,
  rejectPendingTools,
  settleToolResult as settleToolResultInternal,
  waitForToolResult as waitForToolResultInternal,
  type StoreToolDependencies,
} from './store-tools';
import {
  MAX_ACTIVE_SERVER_RUNS,
  MAX_SERVER_EVENT_BYTES,
  MAX_SERVER_RUN_BYTES,
  MAX_SERVER_RUN_EVENTS,
  MAX_SERVER_TOOL_REQUESTS,
  RunStoreLimitError,
  type ServerRun,
  type ServerRunEvent,
  type ServerRunStatus,
  type ServerToolRequest,
  type ToolClaimOutcome,
  type ToolResultOutcome,
} from './store-types';
import {
  createServerRunCapability,
  digestToolArgs,
  digestValue,
  isServerRunCapability,
  serverRunCapabilityVerifier,
  verifyServerRunCapability,
} from './store-values';
export {
  MAX_ACTIVE_SERVER_RUNS,
  MAX_SERVER_EVENT_BYTES,
  MAX_SERVER_RUN_BYTES,
  MAX_SERVER_RUN_EVENTS,
  MAX_SERVER_TOOL_REQUESTS,
  RunStoreLimitError,
  createServerRunCapability,
  digestToolArgs,
  verifyServerRunCapability,
};
export type {
  ServerRun,
  ServerRunEvent,
  ServerRunStatus,
  ServerToolRequest,
  ToolClaimOutcome,
  ToolResultOutcome,
};
const runs = new Map<string, ServerRun>();
const persistence = new Map<string, Promise<void>>();
const projectPersistence = new Map<string, Promise<void>>();
const recovery = new Map<string, Promise<ServerRun | undefined>>();
const TERMINAL_STATUS: Readonly<Partial<Record<ServerRunStatus, true>>> = {
  completed: true,
  failed: true,
  'awaiting-user': true,
  cancelled: true,
};
export function isRunTerminal(run: ServerRun): boolean {
  return TERMINAL_STATUS[run.status] === true;
}
function persistenceFailure(run: ServerRun, error: unknown): Error {
  const failure = error instanceof Error ? error : new Error(String(error));
  run.persistenceError = failure.message;
  run.error ??= failure.message;
  run.status = 'failed';
  run.abort?.abort(failure);
  void rejectPendingTools(run, failure.message);
  wakeSubscribers(run);
  return failure;
}
function mirror(run: ServerRun, work: () => Promise<void>): Promise<void> {
  if (run.persistenceError) return Promise.reject(new Error(run.persistenceError));
  const previous = projectPersistence.get(run.projectId) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(async () => {
    adoptAgentSessionWriteGeneration(run.projectId, run.sessionGeneration);
    await work();
  }).catch((error: unknown) => {
    throw persistenceFailure(run, error);
  });
  const settled = next.then(() => undefined, () => undefined);
  projectPersistence.set(run.projectId, settled);
  persistence.set(run.id, next);
  void settled.finally(() => {
    if (projectPersistence.get(run.projectId) === settled) {
      projectPersistence.delete(run.projectId);
    }
    if (persistence.get(run.id) === next) persistence.delete(run.id);
  });
  return next;
}

function evictRun(run: ServerRun, message: string): void {
  run.status = 'failed';
  run.abort?.abort(new Error(message));
  void rejectPendingTools(run, message);
  wakeSubscribers(run);
  if (runs.get(run.id) === run) runs.delete(run.id);
}

export async function prepareRunAdmission(projectId: string): Promise<string> {
  const sessionGeneration = await currentAgentSessionGeneration(projectId);
  adoptAgentSessionWriteGeneration(projectId, sessionGeneration);
  for (const run of runs.values()) {
    if (run.projectId === projectId && run.sessionGeneration !== sessionGeneration) {
      evictRun(run, 'Agent session generation changed.');
    }
  }
  pruneRuns();
  return sessionGeneration;
}

export interface CreateServerRunInput {
  readonly id?: string;
  readonly projectId: string;
  readonly sessionGeneration: string;
  readonly backend?: string;
  readonly provider: string;
  readonly model: string;
  readonly askOnly?: boolean;
  readonly references?: readonly unknown[];
  readonly externalSessionId?: string;
  readonly context?: unknown;
  readonly requestShapeHash?: string;
  readonly userInputDigest?: string;
}

export interface CreatedServerRun {
  readonly run: ServerRun;
  readonly capability: string;
}

function createRuntimeContext(
  input: CreateServerRunInput,
  capabilityVerifier: string,
  digest: string,
): AgentRunContext {
  return {
    requestShapeHash: digest,
    modelId: input.model,
    activeToolCount: 0,
    serverRunCapabilityVerifier: capabilityVerifier,
    transportStatus: 'queued',
    transportError: null,
  };
}

function createRunRecord(
  input: CreateServerRunInput,
  id: string,
  createdAt: number,
  digest: string,
  capabilityVerifier: string,
): ServerRun {
  const runtimeContext = createRuntimeContext(input, capabilityVerifier, digest);
  return {
    id,
    projectId: input.projectId,
    sessionGeneration: input.sessionGeneration,
    capabilityVerifier,
    requestShapeHash: digest,
    backend: input.backend ?? 'api',
    provider: input.provider,
    model: input.model,
    askOnly: input.askOnly === true,
    references: input.references ? [...input.references] : [],
    ...(input.externalSessionId ? { externalSessionId: input.externalSessionId } : {}),
    ...(input.context !== undefined ? { context: input.context } : {}),
    status: 'queued',
    createdAt,
    events: [],
    error: null,
    retainedEventBytes: 0,
    replayStart: 1,
    subscriberCount: 0,
    waiters: new Set(),
    eventCursor: 0,
    pendingEventBytes: 0,
    pendingEventCount: 0,
    runtimeContext,
    toolRequests: new Map(),
    metrics: {
      requests: 0,
      inputTokens: 0,
      freshInputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
    },
  };
}

function persistCreatedRun(run: ServerRun, userInputDigest: string): void {
  runs.set(run.id, run);
  void mirror(run, async () => {
    await createAgentRun({
      version: 1,
      runId: run.id,
      projectId: run.projectId,
      status: 'running',
      askOnly: run.askOnly,
      userInputPreview: `server:${run.provider}/${run.model}`,
      userInputDigest,
      createdAt: run.createdAt,
      updatedAt: run.createdAt,
      modelId: run.model,
      backend: run.backend,
      provider: run.provider,
      ...(run.externalSessionId ? { externalSessionId: run.externalSessionId } : {}),
      context: run.runtimeContext,
      artifactIds: [],
      checkpointIds: [],
      proposalIds: [],
      events: [],
    });
  });
}

function createRunWithVerifier(
  input: CreateServerRunInput,
  capabilityVerifier: string,
): ServerRun {
  if ([...runs.values()].filter((run) => !isRunTerminal(run)).length >= MAX_ACTIVE_SERVER_RUNS) {
    throw new RunStoreLimitError(`Active Agent run limit reached (${MAX_ACTIVE_SERVER_RUNS}).`);
  }
  const id = input.id?.trim() || randomUUID();
  if (runs.has(id)) throw new Error(`Agent run already exists: ${id}`);
  const createdAt = Date.now();
  const digest = input.requestShapeHash ?? digestValue({
    id,
    projectId: input.projectId,
    provider: input.provider,
    model: input.model,
    askOnly: input.askOnly === true,
    references: input.references ?? [],
  });
  const run = createRunRecord(input, id, createdAt, digest, capabilityVerifier);
  persistCreatedRun(run, input.userInputDigest ?? digest);
  return run;
}

export function createRun(input: CreateServerRunInput): ServerRun {
  return createRunWithVerifier(input, createServerRunCapability().verifier);
}

export function createRunWithCapability(input: CreateServerRunInput): CreatedServerRun {
  const authority = createServerRunCapability();
  return {
    run: createRunWithVerifier(input, authority.verifier),
    capability: authority.capability,
  };
}
export function createRunWithPresentedCapability(
  input: CreateServerRunInput,
  capability: string,
): CreatedServerRun {
  if (!input.id?.trim()) throw new Error('Client-presented Agent run id is required.');
  if (!isServerRunCapability(capability)) throw new Error('Invalid Agent run capability.');
  return {
    run: createRunWithVerifier(input, serverRunCapabilityVerifier(capability)),
    capability,
  };
}
export function getRun(id: string): ServerRun | undefined { return runs.get(id); }
export function replayWindow(run: ServerRun): { firstEventId: number; lastEventId: number } {
  return {
    firstEventId: run.replayStart,
    lastEventId: run.events.at(-1)?.id ?? 0,
  };
}
export function pushRunEvent(run: ServerRun, type: string, data: unknown): void {
  pushRunEventInternal(STORE_EVENT_DEPENDENCIES, run, type, data);
}

export async function setRunStatus(
  run: ServerRun,
  status: ServerRunStatus,
): Promise<void> {
  await setRunStatusInternal(STORE_EVENT_DEPENDENCIES, run, status);
}

export function waitForRunEvents(
  run: ServerRun,
  afterId: number,
  signal?: AbortSignal,
): Promise<void> {
  return waitForRunEventsInternal(STORE_EVENT_DEPENDENCIES, run, afterId, signal);
}

export async function cancelRun(run: ServerRun): Promise<void> {
  await cancelRunInternal(STORE_EVENT_DEPENDENCIES, run);
}
export function waitForToolResult(
  run: ServerRun,
  toolCallId: string,
  toolName: string,
  argsDigest: string,
  timeoutMs?: number,
): Promise<unknown> {
  return waitForToolResultInternal(
    STORE_TOOL_DEPENDENCIES,
    run,
    toolCallId,
    toolName,
    argsDigest,
    timeoutMs,
  );
}

export async function flushRunPersistence(run: ServerRun): Promise<void> {
  while (persistence.has(run.id)) {
    await persistence.get(run.id);
  }
  if (run.persistenceError) throw new Error(run.persistenceError);
}

const STORE_EVENT_DEPENDENCIES: StoreEventDependencies = {
  mirror,
  flushRunPersistence,
  isRunTerminal,
  pruneRuns,
};

function mirrorTool(
  run: ServerRun,
  request: ServerToolRequest,
  status: 'pending' | 'allowed' | 'denied' | 'cancelled',
): Promise<void> {
  return mirrorToolInternal(STORE_EVENT_DEPENDENCIES, run, request, status);
}

const STORE_TOOL_DEPENDENCIES: StoreToolDependencies = {
  isRunTerminal,
  mirrorTool,
  pushRunEvent,
};
const STORE_METRICS_DEPENDENCIES: StoreMetricsDependencies = {
  mirror,
  pushRunEvent,
  updateRuntimeContext,
};

const STORE_RECOVERY_DEPENDENCIES: StoreRecoveryDependencies = {
  runs,
  recovery,
  evictRun,
  pruneRuns,
};

export function recordServerContextUsage(
  run: ServerRun,
  usage: AgentContextUsage,
  activeToolCount: number,
): void {
  recordServerContextUsageInternal(
    STORE_METRICS_DEPENDENCIES,
    run,
    usage,
    activeToolCount,
  );
}

export async function persistServerCheckpoint(
  run: ServerRun,
  checkpoint: AgentContextCheckpoint,
): Promise<void> {
  await persistServerCheckpointInternal(STORE_METRICS_DEPENDENCIES, run, checkpoint);
}

export function claimToolRequest(
  run: ServerRun,
  input: { toolCallId: string; argsDigest: string; claimId: string },
): ToolClaimOutcome {
  return claimToolRequestInternal(STORE_TOOL_DEPENDENCIES, run, input);
}

export function settleToolResult(
  run: ServerRun,
  input: {
    toolCallId: string;
    argsDigest: string;
    claimId?: string;
    result?: unknown;
    error?: string;
  },
): ToolResultOutcome {
  return settleToolResultInternal(STORE_TOOL_DEPENDENCIES, run, input);
}

export function deliverToolResult(
  run: ServerRun,
  toolCallId: string,
  result: unknown,
  argsDigest?: string,
): boolean {
  const request = run.toolRequests.get(toolCallId);
  return settleToolResult(run, {
    toolCallId,
    argsDigest: argsDigest ?? request?.argsDigest ?? '',
    ...(request?.claimId ? { claimId: request.claimId } : {}),
    result,
  }) === 'accepted';
}

export function failToolResult(
  run: ServerRun,
  toolCallId: string,
  message: string,
  argsDigest?: string,
): boolean {
  const request = run.toolRequests.get(toolCallId);
  return settleToolResult(run, {
    toolCallId,
    argsDigest: argsDigest ?? request?.argsDigest ?? '',
    ...(request?.claimId ? { claimId: request.claimId } : {}),
    error: message,
  }) === 'accepted';
}

export async function recoverServerRun(
  projectId: string,
  runId: string,
): Promise<ServerRun | undefined> {
  return recoverServerRunInternal(STORE_RECOVERY_DEPENDENCIES, projectId, runId);
}

export async function recoverServerRuns(projectId: string): Promise<ServerRun[]> {
  return recoverServerRunsInternal(STORE_RECOVERY_DEPENDENCIES, projectId);
}
export async function flushServerRunPersistence(run?: ServerRun): Promise<void> {
  if (run) {
    await flushRunPersistence(run);
    return;
  }
  while (persistence.size > 0) {
    await Promise.all([...persistence.values()]);
  }
  const failed = [...runs.values()].find((item) => item.persistenceError);
  if (failed?.persistenceError) throw new Error(failed.persistenceError);
}
export function resetServerRunStoreForTest(): void {
  for (const run of runs.values()) {
    run.abort?.abort();
    void rejectPendingTools(run, 'Server run store reset.');
    run.status = 'failed';
    wakeSubscribers(run);
  }
  runs.clear();
  persistence.clear();
  projectPersistence.clear();
  recovery.clear();
}
export function pruneRuns(
  retentionMs = 30 * 60 * 1_000,
  maxTerminalRuns = MAX_ACTIVE_SERVER_RUNS,
): void {
  const cutoff = Date.now() - retentionMs;
  for (const [id, run] of runs) {
    if (isRunTerminal(run) && run.subscriberCount === 0 && run.createdAt < cutoff) {
      runs.delete(id);
    }
  }
  const excess = [...runs.values()]
    .reverse()
    .filter((run) => isRunTerminal(run) && run.subscriberCount === 0)
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(maxTerminalRuns);
  for (const run of excess) runs.delete(run.id);
}
