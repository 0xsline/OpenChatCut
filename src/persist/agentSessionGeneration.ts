import {
  agentSessionGenerationKey,
  LEGACY_AGENT_SESSION_GENERATION,
  parseAgentSessionGenerationRecord,
  requireAgentSessionProjectId,
  type AgentSessionGenerationRecord,
} from '../../shared/agent-session-generation';
import type { ProjectStoreMutationResponse } from '../../shared/project-store-transport';
import type { AgentRuntimeSidecar } from './agentRuntimeTypes';
import {
  projectStoreRemoteAvailable,
  projectStoreWriteCredential,
  requestProjectStore,
} from './projectStoreTransport';
import {
  kvAdoptAuthoritativeValue,
  kvForgetCachedAgentSessionEntries,
  kvGetFresh,
  kvSet,
} from './sharedKv';

const localWriteGenerations = new Map<string, string>();
const lastReadGenerations = new Map<string, string>();

function parseGeneration(value: unknown): AgentSessionGenerationRecord {
  if (value === undefined) {
    return { version: 1, generation: LEGACY_AGENT_SESSION_GENERATION, clearedAt: 0 };
  }
  const record = parseAgentSessionGenerationRecord(value);
  if (record) return record;
  throw new Error('Stored Agent session generation is invalid.');
}

export function agentSessionGenerationMatches(
  stored: string | undefined,
  current: string,
): boolean {
  return (stored ?? LEGACY_AGENT_SESSION_GENERATION) === current;
}

export function scopeAgentRuntimeSidecar(
  sidecar: AgentRuntimeSidecar,
  generation: string,
): AgentRuntimeSidecar {
  if (agentSessionGenerationMatches(sidecar.sessionGeneration, generation)) return sidecar;
  return {
    ...sidecar,
    sessionGeneration: generation,
    runs: [],
    approvals: [],
    checkpoints: [],
    artifacts: [],
  };
}

export async function currentAgentSessionGeneration(projectId: string): Promise<string> {
  requireAgentSessionProjectId(projectId);
  const record = parseGeneration(
    await kvGetFresh<unknown>(agentSessionGenerationKey(projectId)),
  );
  const previous = lastReadGenerations.get(projectId);
  if (previous && previous !== record.generation) {
    kvForgetCachedAgentSessionEntries(projectId);
  }
  lastReadGenerations.set(projectId, record.generation);
  if (!localWriteGenerations.has(projectId)) {
    localWriteGenerations.set(projectId, record.generation);
  }
  return record.generation;
}

export async function agentSessionWriteGeneration(projectId: string): Promise<string> {
  requireAgentSessionProjectId(projectId);
  const cached = localWriteGenerations.get(projectId);
  if (cached) return cached;
  return currentAgentSessionGeneration(projectId);
}

export function adoptAgentSessionWriteGeneration(projectId: string, generation: string): void {
  requireAgentSessionProjectId(projectId);
  localWriteGenerations.set(projectId, generation);
}

function validRotationResponse(value: unknown): value is ProjectStoreMutationResponse {
  return !!value && typeof value === 'object'
    && Reflect.get(value, 'accepted') === true
    && Reflect.get(value, 'found') === true
    && Reflect.has(value, 'value');
}

export async function rotateAgentSessionGeneration(projectId: string): Promise<string> {
  requireAgentSessionProjectId(projectId);
  let record: AgentSessionGenerationRecord;
  if (projectStoreRemoteAvailable()) {
    if (!projectStoreWriteCredential()) {
      throw new Error('共享工程库为只读模式（未连接编辑器会话），Agent 上下文未清理');
    }
    const response = await requestProjectStore({
      operation: 'agent-session-rotate',
      projectId,
    });
    if (!validRotationResponse(response)) {
      throw new Error('Invalid Agent session rotation response.');
    }
    record = parseGeneration(response.value);
    await kvAdoptAuthoritativeValue(agentSessionGenerationKey(projectId), record);
  } else {
    record = { version: 1, generation: crypto.randomUUID(), clearedAt: Date.now() };
    await kvSet(agentSessionGenerationKey(projectId), record);
  }
  kvForgetCachedAgentSessionEntries(projectId);
  lastReadGenerations.set(projectId, record.generation);
  localWriteGenerations.set(projectId, record.generation);
  return record.generation;
}

export function resetAgentSessionGenerationMemory(): void {
  localWriteGenerations.clear();
  lastReadGenerations.clear();
}