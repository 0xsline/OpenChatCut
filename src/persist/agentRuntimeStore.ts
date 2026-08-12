import type { AgentRunLeaseState } from '../../shared/project-store-transport';
import {
  kvCompareAndSwapAgentRuntime,
  kvDel,
  kvGet,
  kvGetLocalFirst,
  kvKeys,
  kvSet,
  resetSharedKvMemory,
} from './sharedKv';
import {
  agentSessionWriteGeneration,
  currentAgentSessionGeneration,
  rotateAgentSessionGeneration,
  scopeAgentRuntimeSidecar,
  resetAgentSessionGenerationMemory,
} from './agentSessionGeneration';
import { projectStoreRemoteAvailable } from './projectStoreTransport';
import {
  releaseAgentRunLeaseAuthority,
  updateAgentRunLeaseAuthority,
} from './agentRuntimeLease';
import {
  isValidAgentArtifactRecord as isValidArtifactRecord,
  normalizeAgentRuntimeSidecar as normalizeSidecar,
} from './agentRuntimeCodec';
import { isValidAgentRuntimeSnapshot } from './agentRuntimeSnapshotValidation';
import {
  applyAgentRuntimeRetention,
  MAX_AGENT_RUNS, MAX_APPROVALS, MAX_CHECKPOINTS, MAX_EVENTS_PER_RUN,
} from './agentRuntimeRetention';
import {
  MAX_ARTIFACT_BYTES,
  MAX_PROJECT_ARTIFACT_BYTES,
  MAX_PROJECT_ARTIFACTS,
  type AgentApprovalRecord,
  type AgentArtifactRecord,
  type AgentCheckpointRecord,
  type AgentRunEvent,
  type AgentRunRecord,
  type AgentRunStatus,
  type AgentRuntimeSidecar,
  type AgentRuntimeSnapshot,
} from './agentRuntimeTypes';
export * from './agentRuntimeTypes';
export { MAX_AGENT_RUNS, MAX_APPROVALS, MAX_CHECKPOINTS, MAX_EVENTS_PER_RUN };

const PROJECT_ID = /^[A-Za-z0-9_-]{1,160}$/;
const ARTIFACT_ID = /^[A-Za-z0-9_-]{1,20}$/;
const queues = new Map<string, Promise<void>>();
const listeners = new Map<string, Set<() => void>>();
const runtimeKey = (projectId: string, generation = 'legacy') => generation === 'legacy'
  ? `agent-runtime:${projectId}`
  : `agent-session-runtime:${projectId}:${generation}`;
export const agentRuntimeKey = runtimeKey;
export const agentArtifactKey = (
  projectId: string,
  artifactId: string,
  generation = 'legacy',
): string => generation === 'legacy'
  ? `agent-artifact:${projectId}:${artifactId}`
  : `agent-session-artifact:${projectId}:${generation}:${artifactId}`;
const artifactPrefix = (projectId: string, generation: string): string =>
  agentArtifactKey(projectId, '', generation);
const terminal = (status: AgentRunStatus) =>
  !['running', 'waiting_approval', 'awaiting_user'].includes(status);

function requireProjectId(projectId: string): void {
  if (!PROJECT_ID.test(projectId)) throw new Error('Invalid agent runtime project id.');
}
function enqueue<T>(projectId: string, work: () => Promise<T>): Promise<T> {
  const previous = queues.get(projectId) ?? Promise.resolve();
  const run = previous.catch(() => undefined).then(work);
  const settled = run.then(() => undefined, () => undefined);
  queues.set(projectId, settled);
  void settled.finally(() => { if (queues.get(projectId) === settled) queues.delete(projectId); });
  return run;
}
function withProjectLock<T>(projectId: string, work: () => Promise<T>): Promise<T> {
  const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
  return locks ? locks.request(`openchatcut:${runtimeKey(projectId)}`, { mode: 'exclusive' }, work) : work();
}
function notify(projectId: string): void {
  for (const listener of listeners.get(projectId) ?? []) listener();
}
async function mutateOnce<T>(projectId: string, change: (current: AgentRuntimeSidecar) => [AgentRuntimeSidecar, T]): Promise<{ result: T; previous: AgentRuntimeSidecar; next: AgentRuntimeSidecar }> {
  const sessionGeneration = await agentSessionWriteGeneration(projectId);
  const key = runtimeKey(projectId, sessionGeneration);
  // Browser and server both write the agent runtime sidecar in serverRun mode,
  // so a single install can transiently contest the CAS. Retry with a short
  // backoff instead of failing hard after 4 immediate attempts.
  const MUTATE_CAS_ATTEMPTS = 20;
  for (let attempt = 0; attempt < MUTATE_CAS_ATTEMPTS; attempt += 1) {
    const raw = await kvGet<unknown>(key);
    const previous = scopeAgentRuntimeSidecar(
      normalizeSidecar(projectId, raw),
      sessionGeneration,
    );
    const [changed, result] = change(previous);
    const next = applyAgentRuntimeRetention({
      ...changed, sessionGeneration,
      revision: previous.revision + 1, updatedAt: Date.now(), lastWriterId: crypto.randomUUID(),
    });
    const canonical = await kvCompareAndSwapAgentRuntime({
      operation: 'agent-runtime-cas',
      key,
      expectedRevision: raw === undefined ? null : previous.revision,
      value: next,
    });
    if (canonical.accepted) {
      return { result, previous, next: normalizeSidecar(projectId, canonical.value) };
    }
    if (attempt < MUTATE_CAS_ATTEMPTS - 1) {
      await new Promise((resolve) => setTimeout(resolve, 20 + attempt * 15));
    }
  }
  throw new Error('Concurrent agent runtime update could not be serialized.');
}
async function mutate<T>(projectId: string, change: (current: AgentRuntimeSidecar) => [AgentRuntimeSidecar, T]): Promise<T> {
  requireProjectId(projectId);
  return enqueue(projectId, () => withProjectLock(projectId, async () => {
    const { result, previous, next } = await mutateOnce(projectId, change);
    const retained = new Set(next.artifacts.map((item) => item.artifactId));
    const sessionGeneration = next.sessionGeneration ?? 'legacy';
    await Promise.all(previous.artifacts.filter((item) => !retained.has(item.artifactId))
      .map((item) => kvDel(agentArtifactKey(projectId, item.artifactId, sessionGeneration))));
    notify(projectId);
    return result;
  }));
}

export async function loadAgentRuntimeSidecar(projectId: string): Promise<AgentRuntimeSidecar> {
  requireProjectId(projectId);
  const generation = await currentAgentSessionGeneration(projectId);
  const raw = await kvGetLocalFirst<unknown>(runtimeKey(projectId, generation));
  return scopeAgentRuntimeSidecar(normalizeSidecar(projectId, raw), generation);
}
export function subscribeAgentRuntime(projectId: string, listener: () => void): () => void {
  requireProjectId(projectId);
  const current = listeners.get(projectId) ?? new Set<() => void>();
  current.add(listener);
  listeners.set(projectId, current);
  return () => { current.delete(listener); if (!current.size) listeners.delete(projectId); };
}
export function createAgentRun(run: AgentRunRecord): Promise<AgentRunRecord> {
  return mutate(run.projectId, (current) => [{ ...current, runs: [run, ...current.runs.filter((item) => item.runId !== run.runId)] }, run]);
}
export function patchAgentRun(projectId: string, runId: string, patch: Partial<Omit<AgentRunRecord, 'version' | 'projectId' | 'runId' | 'events'>>): Promise<void> {
  const releasesOwnership = Object.hasOwn(patch, 'ownerInstanceId') && patch.ownerInstanceId === undefined;
  const safePatch = releasesOwnership
    ? { ...patch, ownerInstanceId: undefined, leaseToken: undefined, leaseExpiresAt: undefined }
    : patch;
  return mutate(projectId, (current) => [{
    ...current,
    runs: current.runs.map((run) => run.runId !== runId || terminal(run.status)
      ? run
      : { ...run, ...safePatch, updatedAt: Date.now() }),
  }, undefined]);
}
export async function updateAgentRunLease(
  projectId: string,
  runId: string,
  ownerInstanceId: string,
  leaseToken: string | undefined,
  leaseExpiresAt: number,
  claim: boolean,
  now = Date.now(),
): Promise<AgentRunLeaseState | null> {
  requireProjectId(projectId);
  const generation = await agentSessionWriteGeneration(projectId);
  const result = await updateAgentRunLeaseAuthority({
    projectId, runtimeKey: runtimeKey(projectId, generation),
    runId, ownerInstanceId, leaseToken, leaseExpiresAt, claim, now,
  }, (change) => mutate(projectId, change));
  if (result.authoritative) notify(projectId);
  return result.lease;
}
export function appendAgentRunEvent(projectId: string, runId: string, event: Omit<AgentRunEvent, 'eventId' | 'projectId' | 'runId' | 'sequence' | 'createdAt'>): Promise<AgentRunEvent> {
  const eventId = crypto.randomUUID();
  return mutate(projectId, (current) => {
    const run = current.runs.find((item) => item.runId === runId);
    if (!run) throw new Error(`Agent run not found: ${runId}`);
    const next: AgentRunEvent = { ...event, eventId, projectId, runId, sequence: (run.events.at(-1)?.sequence ?? 0) + 1, createdAt: Date.now() };
    const runs = current.runs.map((item) => item.runId === runId
      ? { ...item, updatedAt: next.createdAt, events: [...item.events, next] } : item);
    return [{ ...current, runs }, next];
  });
}
export function upsertAgentApproval(record: AgentApprovalRecord): Promise<void> {
  return mutate(record.projectId, (current) => {
    const existing = current.approvals.find((item) => item.approvalId === record.approvalId);
    if (record.status === 'pending' && !existing) {
      const duplicate = current.approvals.some((item) => item.status === 'pending'
        && item.runId === record.runId && item.toolName === record.toolName
        && item.argsDigest === record.argsDigest && item.operationId === record.operationId);
      if (duplicate) throw new Error('A matching Agent approval is already pending.');
      if (current.approvals.filter((item) => item.status === 'pending').length >= MAX_APPROVALS) {
        throw new Error('Pending Agent approval limit reached.');
      }
    }
    return [{ ...current,
      approvals: [record, ...current.approvals.filter((item) => item.approvalId !== record.approvalId)] },
    undefined];
  });
}
export function addAgentCheckpoint(record: AgentCheckpointRecord): Promise<void> {
  return mutate(record.projectId, (current) => [{
    ...current,
    checkpoints: [record, ...current.checkpoints.filter((item) => item.checkpointId !== record.checkpointId)],
    runs: current.runs.map((run) => run.runId === record.runId
      ? { ...run, checkpointIds: [...new Set([...run.checkpointIds, record.checkpointId])] } : run),
  }, undefined]);
}
export async function releaseAgentRunLease(
  projectId: string,
  runId: string,
  ownerInstanceId: string,
  leaseToken: string,
): Promise<boolean> {
  requireProjectId(projectId);
  const generation = await agentSessionWriteGeneration(projectId);
  const result = await releaseAgentRunLeaseAuthority(
    runtimeKey(projectId, generation),
    runId,
    ownerInstanceId,
    leaseToken,
    (change) => mutate(projectId, change),
  );
  if (result.authoritative) notify(projectId);
  return result.accepted;
}
export async function storeAgentArtifact(record: AgentArtifactRecord): Promise<boolean> {
  requireProjectId(record.projectId);
  if (!ARTIFACT_ID.test(record.artifactId) || record.originalBytes > MAX_ARTIFACT_BYTES
      || !isValidArtifactRecord(record, record.projectId, record.artifactId)
      || new TextEncoder().encode(record.body).byteLength !== record.originalBytes
      || await sha256Text(record.body) !== record.bodySha256) return false;
  return enqueue(record.projectId, () => withProjectLock(record.projectId, async () => {
    const generation = await agentSessionWriteGeneration(record.projectId);
    const key = agentArtifactKey(record.projectId, record.artifactId, generation);
    if (await kvGet(key) !== undefined) return false;
    await kvSet(key, record);
    try {
      const mutation = await mutateOnce(record.projectId, (current) => {
        if (!current.runs.some((run) => run.runId === record.runId)) return [current, false];
        const bytes = current.artifacts.reduce((sum, item) => sum + item.originalBytes, 0);
        if (current.artifacts.length >= MAX_PROJECT_ARTIFACTS
            || bytes + record.originalBytes > MAX_PROJECT_ARTIFACT_BYTES) return [current, false];
        const { body: _body, version: _version, ...index } = record;
        const runs = current.runs.map((run) => run.runId === record.runId
          ? { ...run, artifactIds: [...new Set([...run.artifactIds, record.artifactId])] } : run);
        return [{ ...current, runs, artifacts: [...current.artifacts, index] }, true];
      });
      if (!mutation.result) await kvDel(key);
      const retained = new Set(mutation.next.artifacts.map((item) => item.artifactId));
      await Promise.all(mutation.previous.artifacts
        .filter((item) => !retained.has(item.artifactId))
        .map((item) => kvDel(agentArtifactKey(record.projectId, item.artifactId, generation))));
      notify(record.projectId);
      return mutation.result;
    } catch (error) {
      await kvDel(key);
      throw error;
    }
  }));
}
export async function deleteAgentArtifacts(
  projectId: string,
  artifactIds: readonly string[],
): Promise<void> {
  const removing = new Set(artifactIds.filter((artifactId) => ARTIFACT_ID.test(artifactId)));
  if (!removing.size) return;
  await mutate(projectId, (current) => [{
    ...current,
    runs: current.runs.map((run) => ({
      ...run,
      artifactIds: run.artifactIds.filter((artifactId) => !removing.has(artifactId)),
    })),
    artifacts: current.artifacts.filter((artifact) => !removing.has(artifact.artifactId)),
  }, undefined]);
}

export async function loadAgentArtifact(projectId: string, artifactId: string): Promise<AgentArtifactRecord | null> {
  requireProjectId(projectId);
  if (!ARTIFACT_ID.test(artifactId)) return null;
  const sidecar = await loadAgentRuntimeSidecar(projectId);
  if (!sidecar.artifacts.some((artifact) => artifact.artifactId === artifactId)) return null;
  const generation = sidecar.sessionGeneration ?? 'legacy';
  const value = await kvGet<unknown>(agentArtifactKey(projectId, artifactId, generation));
  if (!isValidArtifactRecord(value, projectId, artifactId)) return null;
  if (new TextEncoder().encode(value.body).byteLength !== value.originalBytes
      || await sha256Text(value.body) !== value.bodySha256) return null;
  return value;
}
export async function publishAgentRuntimeSnapshot(snapshot: AgentRuntimeSnapshot): Promise<void> {
  const projectId = snapshot.sidecar.projectId; requireProjectId(projectId);
  const sessionGeneration = await agentSessionWriteGeneration(projectId);
  const imported: AgentRuntimeSnapshot = {
    ...snapshot,
    sidecar: {
      ...snapshot.sidecar,
      sessionGeneration,
    },
  };
  if (!await isValidAgentRuntimeSnapshot(imported)) {
    throw new Error('Invalid Agent runtime import snapshot.');
  }
  await enqueue(projectId, () => withProjectLock(projectId, async () => {
    const key = runtimeKey(projectId, sessionGeneration);
    if (await kvGet(key) !== undefined) throw new Error('Agent runtime already exists for imported project.');
    const written: string[] = [];
    try {
      for (const artifact of imported.artifacts) {
        const artifactKey = agentArtifactKey(projectId, artifact.artifactId, sessionGeneration);
        if (await kvGet(artifactKey) !== undefined) throw new Error('Agent artifact already exists for imported project.');
        await kvSet(artifactKey, artifact); written.push(artifactKey);
      }
      await kvSet(key, imported.sidecar);
      const verified = normalizeSidecar(projectId, await kvGet(key));
      if (verified.revision !== imported.sidecar.revision || verified.artifacts.length !== imported.artifacts.length) throw new Error('Agent runtime import verification failed.');
      for (const row of imported.artifacts) if (!await loadAgentArtifact(projectId, row.artifactId)) throw new Error('Agent artifact import verification failed.');
      notify(projectId);
    } catch (error) {
      await kvDel(key); await Promise.all(written.map((artifactKey) => kvDel(artifactKey))); throw error;
    }
  }));
}
export function recoverInterruptedAgentRuns(projectId: string, now = Date.now(),
  preservedRunIds: ReadonlySet<string> = new Set(),
  cancelApprovalRunIds: ReadonlySet<string> = new Set(),
  ownerInstanceId?: string,
  leaseToken?: string): Promise<AgentRuntimeSidecar> {
  return mutate(projectId, (current) => {
    const recoverable = (run: AgentRunRecord) =>
      !run.ownerInstanceId || !run.leaseExpiresAt || run.leaseExpiresAt <= now;
    const recovered = new Set(current.runs.filter((run) => !terminal(run.status)
      && !preservedRunIds.has(run.runId) && recoverable(run)).map((run) => run.runId));
    const cancelled = new Set(current.runs.filter((run) => cancelApprovalRunIds.has(run.runId)
      && (recoverable(run) || (run.ownerInstanceId === ownerInstanceId
        && (!run.leaseToken || run.leaseToken === leaseToken)))).map((run) => run.runId));
    const runs = current.runs.map((run) => recovered.has(run.runId)
      ? {
        ...run, status: 'interrupted' as const, updatedAt: now,
        ownerInstanceId: undefined, leaseToken: undefined, leaseExpiresAt: undefined,
      }
      : cancelled.has(run.runId) && run.status === 'waiting_approval'
        ? { ...run, status: 'running' as const, updatedAt: now } : run);
    const approvals = current.approvals.map((item) =>
      item.status === 'pending' && (recovered.has(item.runId) || cancelled.has(item.runId))
        ? { ...item, status: 'cancelled' as const, decidedAt: now,
          summary: item.summary ?? 'Interrupted before approval could be resumed.' }
        : item);
    const next = { ...current, runs, approvals };
    return [next, applyAgentRuntimeRetention(next)];
  });
}
export function clearAgentSessionContext(
  projectId: string,
  allowedActiveRunIds: ReadonlySet<string> = new Set(),
): Promise<void> {
  requireProjectId(projectId);
  return enqueue(projectId, () => withProjectLock(projectId, async () => {
    const generation = await currentAgentSessionGeneration(projectId);
    if (!projectStoreRemoteAvailable()) {
      const current = await loadAgentRuntimeSidecar(projectId);
      const blocked = current.runs.find((run) =>
        !terminal(run.status) && !allowedActiveRunIds.has(run.runId));
      if (blocked) {
        throw Object.assign(new Error(
          `Agent session cannot be cleared while another run is active: ${blocked.runId}`,
        ), {
          code: 'agent_session_clear_blocked',
          run: {
            runId: blocked.runId,
            status: blocked.status,
            updatedAt: blocked.updatedAt,
            ...(blocked.ownerInstanceId ? { ownerInstanceId: blocked.ownerInstanceId } : {}),
            ...(blocked.leaseExpiresAt ? { leaseExpiresAt: blocked.leaseExpiresAt } : {}),
          },
        });
      }
    }
    const prefix = artifactPrefix(projectId, generation);
    const artifactKeys = (await kvKeys()).filter((key) => key.startsWith(prefix));
    const sessionKeys = generation === 'legacy'
      ? [`chat:${projectId}`, `proposal:${projectId}`, runtimeKey(projectId)]
      : [
        `agent-session-chat:${projectId}:${generation}`,
        `agent-session-proposal:${projectId}:${generation}`,
        runtimeKey(projectId, generation),
      ];
    await rotateAgentSessionGeneration(projectId);
    notify(projectId);
    await Promise.allSettled([...sessionKeys, ...artifactKeys].map((key) => kvDel(key)));
  }));
}

export async function purgeAgentRuntime(projectId: string): Promise<void> {
  requireProjectId(projectId);
  await enqueue(projectId, () => withProjectLock(projectId, async () => {
    const keys = await kvKeys();
    const artifactPrefixes = [
      agentArtifactKey(projectId, ''),
      `agent-session-artifact:${projectId}:`,
    ];
    const runtimeKeys = [
      runtimeKey(projectId),
      ...keys.filter((key) => key.startsWith(`agent-session-runtime:${projectId}:`)),
    ];
    const artifactKeys = keys.filter((key) => artifactPrefixes.some((prefix) => key.startsWith(prefix)));
    await Promise.all([...artifactKeys, ...runtimeKeys].map((key) => kvDel(key)));
    notify(projectId);
  }));
}
export function resetAgentRuntimeStoreMemory(): void {
  queues.clear(); listeners.clear(); resetSharedKvMemory();
  resetAgentSessionGenerationMemory();
}
export async function sha256Text(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
