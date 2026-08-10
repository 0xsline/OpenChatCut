import { randomUUID } from 'node:crypto';
import {
  agentSessionArtifactPrefix,
  agentSessionChatKey,
  agentSessionGenerationKey,
  agentSessionProposalKey,
  agentSessionRuntimeKey,
  LEGACY_AGENT_SESSION_GENERATION,
  parseAgentSessionGenerationRecord,
  requireAgentSessionProjectId,
  type AgentSessionGenerationRecord,
} from '../../shared/agent-session-generation.ts';
import { isProjectStoreRecord } from '../../shared/project-store-validation.ts';
import type { ProjectStoreMutationResponse } from '../../shared/project-store-transport.ts';
import { normalizeAgentRuntimeSidecar } from '../../src/persist/agentRuntimeCodec.ts';
import type { AgentRunStatus } from '../../src/persist/agentRuntimeTypes.ts';
import type { LockedProjectStore } from './project-store.ts';

export interface AgentSessionBlockedRun {
  runId: string;
  status: 'running' | 'waiting_approval' | 'awaiting_user';
  updatedAt: number;
  ownerInstanceId?: string;
  leaseExpiresAt?: number;
}

export class AgentSessionClearBlockedError extends Error {
  readonly code = 'agent_session_clear_blocked';
  readonly run: AgentSessionBlockedRun;

  constructor(run: AgentSessionBlockedRun) {
    super(`agent_session_clear_blocked: runId=${run.runId}; status=${run.status}; updatedAt=${run.updatedAt}`);
    this.name = 'AgentSessionClearBlockedError';
    this.run = run;
  }
}

const ACTIVE_RUN_STATUS: Record<string, true> = {
  running: true,
  waiting_approval: true,
  awaiting_user: true,
};

function activeRunStatus(status: AgentRunStatus): AgentSessionBlockedRun['status'] | undefined {
  if (status === 'running' || status === 'waiting_approval' || status === 'awaiting_user') return status;
  return undefined;
}

type WithStoreLock = <T>(
  work: (store: LockedProjectStore) => Promise<T>,
) => Promise<T>;
function proposalRunId(value: unknown): string | undefined {
  if (!isProjectStoreRecord(value)
      || value.phase !== 'prepared'
      || !isProjectStoreRecord(value.proposal)) return undefined;
  return typeof value.proposal.agentRunId === 'string'
    ? value.proposal.agentRunId
    : undefined;
}

async function currentGeneration(
  store: LockedProjectStore,
  projectId: string,
): Promise<{ generation: string; clearedAt: number }> {
  const entry = await store.readEntry(agentSessionGenerationKey(projectId));
  if (!entry.found) return { generation: LEGACY_AGENT_SESSION_GENERATION, clearedAt: 0 };
  const record = parseAgentSessionGenerationRecord(entry.value);
  if (!record) throw new Error('Stored Agent session generation is invalid.');
  return record;
}

async function sessionState(
  store: LockedProjectStore,
  projectId: string,
  generation: string,
) {
  const [runtimeEntry, proposalEntry] = await Promise.all([
    store.readEntry(agentSessionRuntimeKey(projectId, generation)),
    store.readEntry(agentSessionProposalKey(projectId, generation)),
  ]);
  const sidecar = normalizeAgentRuntimeSidecar(projectId, runtimeEntry.value);
  const permittedRunId = proposalEntry.found ? proposalRunId(proposalEntry.value) : undefined;
  const blocked = sidecar.runs.find((run) =>
    ACTIVE_RUN_STATUS[run.status] === true && run.runId !== permittedRunId);
  if (blocked) {
    const status = activeRunStatus(blocked.status);
    if (!status) return sidecar;
    throw new AgentSessionClearBlockedError({
      runId: blocked.runId,
      status,
      updatedAt: blocked.updatedAt,
      ...(blocked.ownerInstanceId ? { ownerInstanceId: blocked.ownerInstanceId } : {}),
      ...(blocked.leaseExpiresAt ? { leaseExpiresAt: blocked.leaseExpiresAt } : {}),
    });
  }
  return sidecar;
}

export async function assertAgentSessionMigrationSafe(
  store: LockedProjectStore,
  base: Readonly<Record<string, unknown>>,
  incoming: Readonly<Record<string, unknown>>,
): Promise<void> {
  for (const key of Object.keys(incoming)) {
    if (!key.startsWith('agent-session-generation:') || Object.hasOwn(base, key)) continue;
    const projectId = key.slice('agent-session-generation:'.length);
    requireAgentSessionProjectId(projectId);
    const runtime = await store.readEntry(agentSessionRuntimeKey(
      projectId,
      LEGACY_AGENT_SESSION_GENERATION,
    ));
    const sidecar = normalizeAgentRuntimeSidecar(projectId, runtime.value);
    if (sidecar.runs.some((run) => ACTIVE_RUN_STATUS[run.status] === true)) {
      throw new Error('Agent session migration cannot replace an active legacy run.');
    }
  }
}

function storedSessionKeys(
  projectId: string,
  generation: string,
  artifactIds: readonly string[],
): string[] {
  const legacy = generation === LEGACY_AGENT_SESSION_GENERATION;
  const keys = legacy
    ? [`chat:${projectId}`, `proposal:${projectId}`, `agent-runtime:${projectId}`]
    : [
      `agent-session-chat:${projectId}:${generation}`,
      `agent-session-proposal:${projectId}:${generation}`,
      `agent-session-runtime:${projectId}:${generation}`,
    ];
  return keys.concat(artifactIds.map((artifactId) => legacy
    ? `agent-artifact:${projectId}:${artifactId}`
    : `agent-session-artifact:${projectId}:${generation}:${artifactId}`));
}

function scopedValue(value: unknown, generation: string): unknown {
  return isProjectStoreRecord(value) ? { ...value, sessionGeneration: generation } : value;
}

export function prepareAgentSessionMigrationEntries(
  base: Readonly<Record<string, unknown>>,
  incoming: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const prepared = { ...incoming };
  for (const [markerKey, markerValue] of Object.entries(incoming)) {
    if (!markerKey.startsWith('agent-session-generation:')) continue;
    const projectId = markerKey.slice('agent-session-generation:'.length);
    const marker = parseAgentSessionGenerationRecord(markerValue);
    delete prepared[markerKey];
    if (!marker) continue;
    const oldGeneration = marker.generation;
    const oldArtifactPrefix = agentSessionArtifactPrefix(projectId, oldGeneration);
    const sessionKeys = [
      agentSessionChatKey(projectId, oldGeneration),
      agentSessionProposalKey(projectId, oldGeneration),
      agentSessionRuntimeKey(projectId, oldGeneration),
    ];
    const artifactKeys = Object.keys(prepared).filter((key) => key.startsWith(oldArtifactPrefix));
    if (Object.hasOwn(base, markerKey)) {
      for (const key of [...sessionKeys, ...artifactKeys]) delete prepared[key];
      continue;
    }
    const generation = randomUUID();
    const targetKeys = [
      agentSessionChatKey(projectId, generation),
      agentSessionProposalKey(projectId, generation),
      agentSessionRuntimeKey(projectId, generation),
    ];
    sessionKeys.forEach((key, index) => {
      if (!Object.hasOwn(prepared, key)) return;
      const value = prepared[key];
      delete prepared[key];
      prepared[targetKeys[index]!] = scopedValue(value, generation);
    });
    for (const key of artifactKeys) {
      const target = `${agentSessionArtifactPrefix(projectId, generation)}${key.slice(oldArtifactPrefix.length)}`;
      prepared[target] = prepared[key];
      delete prepared[key];
    }
    prepared[markerKey] = { version: 1, generation, clearedAt: Date.now() };
  }
  return prepared;
}

export function createAgentSessionStoreOperation(withStoreLock: WithStoreLock) {
  return async (projectId: string): Promise<ProjectStoreMutationResponse> => {
    requireAgentSessionProjectId(projectId);
    return withStoreLock(async (store) => {
      const current = await currentGeneration(store, projectId);
      const sidecar = await sessionState(store, projectId, current.generation);
      const next: AgentSessionGenerationRecord = {
        version: 1,
        generation: randomUUID(),
        clearedAt: Math.max(Date.now(), current.clearedAt + 1),
      };
      await store.writeEntry(agentSessionGenerationKey(projectId), next);
      await Promise.allSettled(storedSessionKeys(
        projectId,
        current.generation,
        sidecar.artifacts.map((artifact) => artifact.artifactId),
      ).map((key) => store.removeEntry(key)));
      return { accepted: true, found: true, value: next };
    });
  };
}
