import {
  appendAgentRunEvent,
  loadAgentRuntimeSidecar,
  patchAgentRun,
  upsertAgentApproval,
  type AgentApprovalRecord,
  type AgentRunContext,
  type AgentRunRecord,
} from '../../src/persist/agentRuntimeStore';
import {
  adoptAgentSessionWriteGeneration,
  currentAgentSessionGeneration,
} from '../../src/persist/agentSessionGeneration';
import type { ServerRun, ServerRunEvent, ServerRunStatus } from './store-types';
import { eventBytes, isServerRunCapabilityVerifier, runtimeEvent } from './store-values';

const RECOVERY_ERROR = 'Agent run interrupted because the server restarted before provider state could be resumed.';

export interface StoreRecoveryDependencies {
  runs: Map<string, ServerRun>;
  recovery: Map<string, Promise<ServerRun | undefined>>;
  evictRun: (run: ServerRun, message: string) => void;
  pruneRuns: () => void;
}

interface TerminalTransportEvidence {
  status: Extract<ServerRunStatus, 'completed' | 'failed' | 'cancelled'>;
  error: string | null;
}

interface TerminalTransportRepair {
  inferred: TerminalTransportEvidence | undefined;
  status: TerminalTransportEvidence['status'];
  error: string | null;
  context: AgentRunContext;
  nextId: number;
  at: number;
}

function serverEvents(record: AgentRunRecord): ServerRunEvent[] {
  return record.events.flatMap((event) => {
    try {
      const payload = JSON.parse(event.summary ?? '') as { serverEvent?: ServerRunEvent };
      return payload.serverEvent && Number.isSafeInteger(payload.serverEvent.id)
        ? [payload.serverEvent]
        : [];
    } catch {
      return [];
    }
  }).sort((a, b) => a.id - b.id);
}

const INTERRUPTED_TOOL_ERROR = 'The agent run was interrupted before this tool returned a result.';

/**
 * Recovered runs carry tool-request events whose results never arrived (the
 * server died mid-flight). Synthesize an in-memory tool-result closer for
 * each so inspectors and any future resume path see a complete pairing
 * instead of a dangling request. Synthetic events are not persisted: the
 * run is already terminal and the sidecar is authoritative for replays.
 */
function closeInterruptedToolRequests(events: ServerRunEvent[]): ServerRunEvent[] {
  const settled = new Set<string>();
  for (const event of events) {
    if (event.type !== 'tool-result') continue;
    const data = event.data as { toolCallId?: unknown } | null;
    if (typeof data?.toolCallId === 'string') settled.add(data.toolCallId);
  }
  const pending = events.filter((event) => {
    if (event.type !== 'tool-request') return false;
    const data = event.data as { toolCallId?: unknown } | null;
    return typeof data?.toolCallId === 'string' && !settled.has(data.toolCallId);
  });
  if (pending.length === 0) return events;
  let nextId = events.length > 0 ? events[events.length - 1]!.id + 1 : 1;
  const now = Date.now();
  const closers = pending.map((event) => {
    const data = event.data as { toolCallId: string; name?: unknown; argsDigest?: unknown };
    return {
      id: nextId++,
      type: 'tool-result',
      data: {
        toolCallId: data.toolCallId,
        ...(typeof data.name === 'string' ? { toolName: data.name } : {}),
        ...(typeof data.argsDigest === 'string' ? { argsDigest: data.argsDigest } : {}),
        error: INTERRUPTED_TOOL_ERROR,
      },
      at: now,
    };
  });
  // Closers belong before the terminal events, not after them: the done
  // event must stay the final entry of a recovered run.
  const terminalIndex = events.findIndex((event) => event.type === 'done'
    || event.type === 'finish');
  return terminalIndex < 0
    ? [...events, ...closers]
    : [...events.slice(0, terminalIndex), ...closers, ...events.slice(terminalIndex)];
}

function terminalTransportEvidence(
  events: readonly ServerRunEvent[],
  doneOnly: boolean,
): TerminalTransportEvidence | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if (
      (event.type !== 'done' && (doneOnly || event.type !== 'status'))
      || !event.data
      || typeof event.data !== 'object'
    ) {
      continue;
    }
    const status = Reflect.get(event.data, 'status');
    if (status !== 'completed' && status !== 'failed' && status !== 'cancelled') continue;
    const error = Reflect.get(event.data, 'error');
    return {
      status,
      error: typeof error === 'string' ? error : null,
    };
  }
  return undefined;
}

function restoredRun(
  projectId: string,
  sessionGeneration: string,
  record: AgentRunRecord,
  capabilityVerifier: string,
): ServerRun {
  const events = closeInterruptedToolRequests(serverEvents(record));
  const status = terminalTransportEvidence(events, true)?.status ?? 'failed';
  const runtimeContext: AgentRunContext = record.context ?? {
    requestShapeHash: record.userInputDigest,
    ...(record.modelId ? { modelId: record.modelId } : {}),
  };
  const transportError = typeof runtimeContext.transportError === 'string'
    ? runtimeContext.transportError
    : null;
  // Pre-backend records stored the provider name in `backend`; new records
  // store the execution backend ('api' | 'codex' | 'copilot') plus `provider`
  // separately.
  const storedBackend = record.backend;
  const hasNewBackend = storedBackend === 'api'
    || storedBackend === 'codex'
    || storedBackend === 'copilot';
  return {
    id: record.runId,
    projectId,
    sessionGeneration,
    capabilityVerifier,
    requestShapeHash: runtimeContext.requestShapeHash,
    backend: hasNewBackend ? storedBackend : 'api',
    provider: record.provider ?? (hasNewBackend ? 'unknown' : (storedBackend ?? 'unknown')),
    model: record.modelId ?? 'unknown',
    askOnly: record.askOnly,
    references: [],
    ...(record.externalSessionId ? { externalSessionId: record.externalSessionId } : {}),
    status,
    createdAt: record.createdAt,
    events,
    error: status === 'completed'
      ? null
      : transportError ?? (status === 'failed' ? RECOVERY_ERROR : null),
    retainedEventBytes: events.reduce((total, event) => total + eventBytes(event), 0),
    replayStart: events[0]?.id ?? 1,
    subscriberCount: 0,
    waiters: new Set(),
    eventCursor: events.at(-1)?.id ?? 0,
    pendingEventBytes: 0,
    pendingEventCount: 0,
    runtimeContext,
    toolRequests: new Map(),
  };
}

function terminalTransportRepair(
  record: AgentRunRecord,
  events: readonly ServerRunEvent[],
): TerminalTransportRepair {
  const inferred = terminalTransportEvidence(events, false);
  const status = inferred?.status ?? 'failed';
  const previousError = typeof record.context?.transportError === 'string'
    ? record.context.transportError
    : null;
  const error = status === 'completed'
    ? null
    : inferred?.error ?? previousError ?? (status === 'failed' ? RECOVERY_ERROR : null);
  const at = Date.now();
  const nextId = (events.at(-1)?.id ?? 0) + 1;
  const context: AgentRunContext = {
    ...(record.context ?? {
      requestShapeHash: record.userInputDigest,
      ...(record.modelId ? { modelId: record.modelId } : {}),
    }),
    transportStatus: status,
    transportError: error,
  };
  return {
    inferred,
    status,
    error,
    context,
    nextId,
    at,
  };
}

async function appendRecoveryEvent(
  projectId: string,
  sessionGeneration: string,
  runId: string,
  event: ServerRunEvent,
): Promise<void> {
  adoptAgentSessionWriteGeneration(projectId, sessionGeneration);
  await appendAgentRunEvent(projectId, runId, runtimeEvent(event));
}

async function persistTerminalTransportRepair(
  projectId: string,
  sessionGeneration: string,
  record: AgentRunRecord,
  repair: TerminalTransportRepair,
): Promise<void> {
  let nextId = repair.nextId;
  if (!repair.inferred) {
    await appendRecoveryEvent(projectId, sessionGeneration, record.runId, {
      id: nextId,
      type: 'status',
      data: { status: repair.status, error: repair.error, reason: 'server-restart' },
      at: repair.at,
    });
    nextId += 1;
  }
  adoptAgentSessionWriteGeneration(projectId, sessionGeneration);
  await patchAgentRun(projectId, record.runId, { context: repair.context });
  await appendRecoveryEvent(projectId, sessionGeneration, record.runId, {
    id: nextId,
    type: 'done',
    data: {
      status: repair.status,
      error: repair.error,
      reason: repair.inferred ? 'server-restart-terminal-recovery' : 'server-restart',
    },
    at: repair.at,
  });
}
async function cancelRecoveredApprovals(
  projectId: string,
  sessionGeneration: string,
  runId: string,
  approvals: readonly AgentApprovalRecord[],
): Promise<void> {
  const pending = approvals.filter(
    (approval) => approval.runId === runId && approval.status === 'pending',
  );
  if (!pending.length) return;
  adoptAgentSessionWriteGeneration(projectId, sessionGeneration);
  const decidedAt = Date.now();
  await Promise.all(pending.map((approval) => upsertAgentApproval({
    ...approval,
    status: 'cancelled',
    decidedAt,
  })));
}


async function ensureTerminalTransport(
  projectId: string,
  sessionGeneration: string,
  record: AgentRunRecord,
  approvals: readonly AgentApprovalRecord[],
): Promise<AgentRunRecord> {
  await cancelRecoveredApprovals(projectId, sessionGeneration, record.runId, approvals);
  const events = serverEvents(record);
  if (terminalTransportEvidence(events, true)) return record;
  const repair = terminalTransportRepair(record, events);
  await persistTerminalTransportRepair(projectId, sessionGeneration, record, repair);
  const sidecar = await loadAgentRuntimeSidecar(projectId);
  return sidecar.runs.find((item) => item.runId === record.runId) ?? {
    ...record,
    context: repair.context,
  };
}

async function recoverServerRunOnce(
  dependencies: StoreRecoveryDependencies,
  projectId: string,
  runId: string,
  sessionGeneration: string,
): Promise<ServerRun | undefined> {
  const active = dependencies.runs.get(runId);
  if (active) {
    if (active.projectId !== projectId) return undefined;
    if (active.sessionGeneration !== sessionGeneration) {
      dependencies.evictRun(active, 'Agent session generation changed.');
      return undefined;
    }
    return active;
  }
  adoptAgentSessionWriteGeneration(projectId, sessionGeneration);
  const sidecar = await loadAgentRuntimeSidecar(projectId);
  if (sidecar.sessionGeneration !== sessionGeneration) return undefined;
  let record = sidecar.runs.find((item) => item.runId === runId);
  if (await currentAgentSessionGeneration(projectId) !== sessionGeneration) return undefined;
  if (!record || !record.userInputPreview.startsWith('server:')) return undefined;
  const verifier = record.context?.serverRunCapabilityVerifier;
  if (!isServerRunCapabilityVerifier(verifier)) return undefined;
  record = await ensureTerminalTransport(
    projectId,
    sessionGeneration,
    record,
    sidecar.approvals,
  );
  if (await currentAgentSessionGeneration(projectId) !== sessionGeneration) return undefined;
  const run = restoredRun(projectId, sessionGeneration, record, verifier);
  dependencies.runs.set(run.id, run);
  dependencies.pruneRuns();
  return dependencies.runs.get(run.id);
}

export async function recoverServerRun(
  dependencies: StoreRecoveryDependencies,
  projectId: string,
  runId: string,
): Promise<ServerRun | undefined> {
  const sessionGeneration = await currentAgentSessionGeneration(projectId);
  adoptAgentSessionWriteGeneration(projectId, sessionGeneration);
  const active = dependencies.runs.get(runId);
  if (active) {
    if (active.projectId !== projectId) return undefined;
    if (active.sessionGeneration !== sessionGeneration) {
      dependencies.evictRun(active, 'Agent session generation changed.');
      return undefined;
    }
    return active;
  }
  const key = `${projectId}\u0000${sessionGeneration}\u0000${runId}`;
  const pending = dependencies.recovery.get(key)
    ?? recoverServerRunOnce(dependencies, projectId, runId, sessionGeneration);
  dependencies.recovery.set(key, pending);
  const cleanup = (): void => {
    if (dependencies.recovery.get(key) === pending) dependencies.recovery.delete(key);
  };
  void pending.then(cleanup, cleanup);
  return pending;
}

export async function recoverServerRuns(
  dependencies: StoreRecoveryDependencies,
  projectId: string,
): Promise<ServerRun[]> {
  const sessionGeneration = await currentAgentSessionGeneration(projectId);
  adoptAgentSessionWriteGeneration(projectId, sessionGeneration);
  const sidecar = await loadAgentRuntimeSidecar(projectId);
  if (sidecar.sessionGeneration !== sessionGeneration) return [];
  const restored = await Promise.all(sidecar.runs
    .filter((record) => record.userInputPreview.startsWith('server:'))
    .map((record) => recoverServerRun(dependencies, projectId, record.runId)));
  return restored.filter((run): run is ServerRun => run !== undefined);
}
