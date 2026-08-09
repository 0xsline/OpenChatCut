import type { AgentRunLeaseState } from '../../shared/project-store-transport';
import {
  kvCompareAndSwapAgentRuntime,
  kvDel,
  kvGet,
  kvKeys,
  kvSet,
  resetSharedKvMemory,
} from './sharedKv';
import {
  releaseAgentRunLeaseAuthority,
  updateAgentRunLeaseAuthority,
} from './agentRuntimeLease';
import {
  isValidAgentApproval as isValidApproval,
  isValidAgentArtifactIndex as isValidArtifactIndex,
  isValidAgentArtifactRecord as isValidArtifactRecord,
  isValidAgentCheckpoint as isValidCheckpoint,
  isValidAgentRun as isValidRun,
  normalizeAgentRuntimeSidecar as normalizeSidecar,
} from './agentRuntimeCodec';
import {
  applyAgentRuntimeRetention,
  MAX_AGENT_RUNS, MAX_APPROVALS, MAX_CHECKPOINTS, MAX_EVENTS_PER_RUN,
} from './agentRuntimeRetention';
export { MAX_AGENT_RUNS, MAX_APPROVALS, MAX_CHECKPOINTS, MAX_EVENTS_PER_RUN };

export const AGENT_RUNTIME_VERSION = 1 as const;
export const MAX_ARTIFACT_BYTES = 8 * 1024 * 1024;
export const MAX_PROJECT_ARTIFACTS = 256;
export const MAX_PROJECT_ARTIFACT_BYTES = 64 * 1024 * 1024;

export type AgentRunStatus =
  | 'running' | 'waiting_approval' | 'awaiting_user'
  | 'completed' | 'failed' | 'aborted' | 'interrupted';
export type AgentToolOutcomeKind =
  | 'success' | 'validation_failed' | 'denied' | 'aborted_before_side_effect'
  | 'stale' | 'retryable_failure' | 'outcome_unknown' | 'terminal_failure';
export interface AgentToolOutcome {
  readonly kind: AgentToolOutcomeKind;
  readonly code?: string;
  readonly operationId?: string;
  readonly artifactId?: string;
  readonly summary?: string;
}
export type AgentRunEventType =
  | 'configured' | 'context_projected' | 'context_usage' | 'checkpoint_created'
  | 'tool_requested' | 'tool_started' | 'tool_outcome'
  | 'approval_requested' | 'approval_decided'
  | 'proposal_created' | 'proposal_applied' | 'proposal_rejected'
  | 'proposal_stale' | 'proposal_reproposed' | 'final';
export interface AgentRunEvent {
  readonly eventId: string;
  readonly projectId: string;
  readonly runId: string;
  readonly sequence: number;
  readonly type: AgentRunEventType;
  readonly createdAt: number;
  readonly toolCallId?: string;
  readonly toolName?: string;
  readonly operationId?: string;
  readonly argsDigest?: string;
  readonly resultDigest?: string;
  readonly approvalId?: string;
  readonly checkpointId?: string;
  readonly proposalId?: string;
  readonly outcome?: AgentToolOutcome;
  readonly summary?: string;
  readonly context?: AgentRunContext;
}
export interface AgentRunContext {
  readonly requestShapeHash: string;
  readonly systemTokens?: number;
  readonly toolSchemaChars?: number;
  readonly historyTokens?: number;
  readonly activeToolCount?: number;
  readonly toolSchemaCount?: number;
  readonly checkpointId?: string;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly reasoningTokens?: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
  readonly noCacheTokens?: number;
}
export interface AgentRunRecord {
  readonly version: 1;
  readonly runId: string;
  readonly projectId: string;
  readonly status: AgentRunStatus;
  readonly askOnly: boolean;
  readonly userInputPreview: string;
  readonly userInputDigest: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly ownerInstanceId?: string;
  readonly leaseToken?: string;
  readonly leaseExpiresAt?: number;
  readonly modelId?: string;
  readonly backend?: string;
  readonly externalSessionId?: string;
  readonly context?: AgentRunContext;
  readonly artifactIds: readonly string[];
  readonly checkpointIds: readonly string[];
  readonly proposalIds: readonly string[];
  readonly events: readonly AgentRunEvent[];
  readonly finalSummary?: string;
}
export type AgentApprovalStatus = 'pending' | 'allowed' | 'denied' | 'expired' | 'cancelled';
export interface AgentApprovalRecord {
  readonly version: 1;
  readonly approvalId: string;
  readonly projectId: string;
  readonly runId: string;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly argsDigest: string;
  readonly operationId?: string;
  readonly status: AgentApprovalStatus;
  readonly createdAt: number;
  readonly decidedAt?: number;
  readonly summary?: string;
}
export interface AgentCheckpointRecord {
  readonly version: 1;
  readonly checkpointId: string;
  readonly projectId: string;
  readonly runId: string;
  readonly summary: string;
  readonly summaryDigest?: string;
  readonly sourceMessageCount: number;
  readonly sourceDigest: string;
  readonly sourceArtifactId: string;
  readonly createdAt: number;
}
export type AgentArtifactKind = 'tool-result' | 'checkpoint-source';
export interface AgentArtifactRecord {
  readonly version: 1;
  readonly artifactId: string;
  readonly projectId: string;
  readonly runId: string;
  readonly kind: AgentArtifactKind;
  readonly bodySha256: string;
  readonly originalBytes: number;
  readonly originalChars: number;
  readonly createdAt: number;
  readonly redacted: boolean;
  readonly binaryOmitted: boolean;
  readonly body: string;
  readonly toolCallId?: string;
  readonly toolName?: string;
}
export type AgentArtifactIndexEntry = Omit<AgentArtifactRecord, 'body' | 'version'>;
export interface AgentRuntimeSidecar {
  readonly version: 1;
  readonly revision: number;
  readonly projectId: string;
  /** Local fallback format; a reachable project store is the canonical CAS authority. */
  readonly durability: 'local-sidecar';
  readonly updatedAt: number;
  readonly lastWriterId?: string;
  readonly runs: readonly AgentRunRecord[];
  readonly approvals: readonly AgentApprovalRecord[];
  readonly checkpoints: readonly AgentCheckpointRecord[];
  readonly artifacts: readonly AgentArtifactIndexEntry[];
}
export interface AgentRuntimeSnapshot { readonly sidecar: AgentRuntimeSidecar; readonly artifacts: readonly AgentArtifactRecord[]; }
const PROJECT_ID = /^[A-Za-z0-9_-]{1,160}$/;
const ARTIFACT_ID = /^[A-Za-z0-9_-]{1,20}$/;
const queues = new Map<string, Promise<void>>();
const listeners = new Map<string, Set<() => void>>();
const runtimeKey = (projectId: string) => `agent-runtime:${projectId}`;
export const agentArtifactKey = (projectId: string, artifactId: string): string =>
  `agent-artifact:${projectId}:${artifactId}`;
const terminal = (status: AgentRunStatus) =>
  !['running', 'waiting_approval', 'awaiting_user'].includes(status);

function requireProjectId(projectId: string): void {
  if (!PROJECT_ID.test(projectId)) throw new Error('Invalid agent runtime project id.');
}
async function isValidRuntimeSnapshot(snapshot: AgentRuntimeSnapshot): Promise<boolean> {
  const { sidecar, artifacts } = snapshot;
  if (sidecar.version !== 1 || !sidecar.projectId || artifacts.length !== sidecar.artifacts.length
    || artifacts.length > MAX_PROJECT_ARTIFACTS || sidecar.runs.some((run) => !isValidRun(run, sidecar.projectId))
    || sidecar.approvals.some((row) => !isValidApproval(row, sidecar.projectId))
    || sidecar.checkpoints.some((row) => !isValidCheckpoint(row, sidecar.projectId))
    || sidecar.artifacts.some((row) => !isValidArtifactIndex(row, sidecar.projectId))) return false;
  const pending = sidecar.approvals.filter((row) => row.status === 'pending');
  const pendingKeys = new Set(pending.map((row) =>
    [row.runId, row.toolName, row.argsDigest, row.operationId ?? ''].join('\u0000')));
  if (pending.length > MAX_APPROVALS || pendingKeys.size !== pending.length) return false;
  const index = new Map(sidecar.artifacts.map((row) => [row.artifactId, row])); let bytes = 0;
  for (const artifact of artifacts) {
    if (!isValidArtifactRecord(artifact, sidecar.projectId, artifact.artifactId)
      || index.get(artifact.artifactId)?.bodySha256 !== artifact.bodySha256
      || index.get(artifact.artifactId)?.originalBytes !== artifact.originalBytes
      || artifact.originalBytes > MAX_ARTIFACT_BYTES
      || new TextEncoder().encode(artifact.body).byteLength !== artifact.originalBytes
      || await sha256Text(artifact.body) !== artifact.bodySha256) return false;
    bytes += artifact.originalBytes;
  }
  return index.size === artifacts.length && bytes <= MAX_PROJECT_ARTIFACT_BYTES;
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
  const key = runtimeKey(projectId);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const raw = await kvGet<unknown>(key);
    const previous = normalizeSidecar(projectId, raw);
    const [changed, result] = change(previous);
    const next = applyAgentRuntimeRetention({
      ...changed, revision: previous.revision + 1, updatedAt: Date.now(), lastWriterId: crypto.randomUUID(),
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
  }
  throw new Error('Concurrent agent runtime update could not be serialized.');
}
async function mutate<T>(projectId: string, change: (current: AgentRuntimeSidecar) => [AgentRuntimeSidecar, T]): Promise<T> {
  requireProjectId(projectId);
  return enqueue(projectId, () => withProjectLock(projectId, async () => {
    const { result, previous, next } = await mutateOnce(projectId, change);
    const retained = new Set(next.artifacts.map((item) => item.artifactId));
    await Promise.all(previous.artifacts.filter((item) => !retained.has(item.artifactId))
      .map((item) => kvDel(agentArtifactKey(projectId, item.artifactId))));
    notify(projectId);
    return result;
  }));
}

export async function loadAgentRuntimeSidecar(projectId: string): Promise<AgentRuntimeSidecar> {
  requireProjectId(projectId);
  return normalizeSidecar(projectId, await kvGet(runtimeKey(projectId)));
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
  const result = await updateAgentRunLeaseAuthority({
    projectId, runId, ownerInstanceId, leaseToken, leaseExpiresAt, claim, now,
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
  const result = await releaseAgentRunLeaseAuthority(
    projectId,
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
  const key = agentArtifactKey(record.projectId, record.artifactId);
  if (await kvGet(key) !== undefined) return false;
  await kvSet(key, record);
  try {
    const admitted = await mutate(record.projectId, (current) => {
      if (!current.runs.some((run) => run.runId === record.runId)) return [current, false];
      const bytes = current.artifacts.reduce((sum, item) => sum + item.originalBytes, 0);
      if (current.artifacts.length >= MAX_PROJECT_ARTIFACTS
          || bytes + record.originalBytes > MAX_PROJECT_ARTIFACT_BYTES) return [current, false];
      const { body: _body, version: _version, ...index } = record;
      const runs = current.runs.map((run) => run.runId === record.runId
        ? { ...run, artifactIds: [...new Set([...run.artifactIds, record.artifactId])] } : run);
      return [{ ...current, runs, artifacts: [...current.artifacts, index] }, true];
    });
    if (!admitted) await kvDel(key);
    return admitted;
  } catch (error) {
    await kvDel(key);
    throw error;
  }
}
export async function loadAgentArtifact(projectId: string, artifactId: string): Promise<AgentArtifactRecord | null> {
  requireProjectId(projectId);
  if (!ARTIFACT_ID.test(artifactId)) return null;
  const value = await kvGet<unknown>(agentArtifactKey(projectId, artifactId));
  if (!isValidArtifactRecord(value, projectId, artifactId)) return null;
  if (new TextEncoder().encode(value.body).byteLength !== value.originalBytes
      || await sha256Text(value.body) !== value.bodySha256) return null;
  return value;
}
export async function publishAgentRuntimeSnapshot(snapshot: AgentRuntimeSnapshot): Promise<void> {
  const projectId = snapshot.sidecar.projectId; requireProjectId(projectId);
  if (!await isValidRuntimeSnapshot(snapshot)) throw new Error('Invalid Agent runtime import snapshot.');
  await enqueue(projectId, () => withProjectLock(projectId, async () => {
    if (await kvGet(runtimeKey(projectId)) !== undefined) throw new Error('Agent runtime already exists for imported project.');
    const written: string[] = [];
    try {
      for (const artifact of snapshot.artifacts) {
        const key = agentArtifactKey(projectId, artifact.artifactId);
        if (await kvGet(key) !== undefined) throw new Error('Agent artifact already exists for imported project.');
        await kvSet(key, artifact); written.push(key);
      }
      await kvSet(runtimeKey(projectId), snapshot.sidecar);
      const verified = normalizeSidecar(projectId, await kvGet(runtimeKey(projectId)));
      if (verified.revision !== snapshot.sidecar.revision || verified.artifacts.length !== snapshot.artifacts.length) throw new Error('Agent runtime import verification failed.');
      for (const row of snapshot.artifacts) if (!await loadAgentArtifact(projectId, row.artifactId)) throw new Error('Agent artifact import verification failed.');
      notify(projectId);
    } catch (error) {
      await kvDel(runtimeKey(projectId)); await Promise.all(written.map((key) => kvDel(key))); throw error;
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
export async function purgeAgentRuntime(projectId: string): Promise<void> {
  requireProjectId(projectId);
  await enqueue(projectId, () => withProjectLock(projectId, async () => {
    const prefix = agentArtifactKey(projectId, '');
    const artifactKeys = (await kvKeys()).filter((key) => key.startsWith(prefix));
    await Promise.all(artifactKeys.map((key) => kvDel(key)));
    await kvDel(runtimeKey(projectId));
    notify(projectId);
  }));
}
export function resetAgentRuntimeStoreMemory(): void {
  queues.clear(); listeners.clear(); resetSharedKvMemory();
}
export async function sha256Text(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
