import { randomUUID } from 'node:crypto';
import type {
  AgentRunLeaseAction,
  AgentRunLeaseState,
  ProjectStoreMutationResponse,
} from '../../shared/project-store-transport.ts';
import {
  classifyAgentRuntimeStoreValue,
  isProjectStoreRecord,
} from '../../shared/project-store-validation.ts';
import { normalizeAgentRuntimeSidecar } from '../../src/persist/agentRuntimeCodec.ts';
import type {
  LockedProjectStore,
  StoredEntryValue,
} from './project-store.ts';

export interface AgentRuntimeCasInput {
  key: string;
  expectedRevision: number | null;
  value: unknown;
}

export interface AgentRunLeaseInput {
  key: string;
  runId: string;
  action: AgentRunLeaseAction;
  ownerInstanceId: string;
  leaseToken?: string;
  leaseMs?: number;
  allowOfflineServerTakeover?: boolean;
}

type WithStoreLock = <T>(
  work: (store: LockedProjectStore) => Promise<T>,
) => Promise<T>;

const ACTIVE_RUN_STATUS: Record<string, true> = {
  running: true,
  waiting_approval: true,
  awaiting_user: true,
};
const TERMINAL_RUN_STATUS: Record<string, true> = {
  completed: true,
  failed: true,
  aborted: true,
  interrupted: true,
};

function preservesTerminalStatuses(
  current: Record<string, unknown> | null,
  incoming: Record<string, unknown>,
): boolean {
  if (!current || !Array.isArray(current.runs) || !Array.isArray(incoming.runs)) return true;
  for (const run of current.runs) {
    if (!isProjectStoreRecord(run) || TERMINAL_RUN_STATUS[String(run.status)] !== true) continue;
    const next = incoming.runs.find((item) =>
      isProjectStoreRecord(item) && item.runId === run.runId);
    if (isProjectStoreRecord(next) && next.status !== run.status) return false;
  }
  return true;
}
function withoutLeaseFields(run: Record<string, unknown>): Record<string, unknown> {
  return {
    ...run,
    ownerInstanceId: undefined,
    leaseToken: undefined,
    leaseExpiresAt: undefined,
  };
}

function managedActiveRun(
  current: Record<string, unknown> | undefined,
  incoming: Record<string, unknown>,
  now: number,
): Record<string, unknown> | null {
  if (!current || ACTIVE_RUN_STATUS[String(current.status)] !== true) {
    return withoutLeaseFields(incoming);
  }
  const owner = typeof current.ownerInstanceId === 'string' ? current.ownerInstanceId : '';
  const token = typeof current.leaseToken === 'string' ? current.leaseToken : '';
  const expiresAt = typeof current.leaseExpiresAt === 'number' ? current.leaseExpiresAt : 0;
  if (!owner || expiresAt <= now) return withoutLeaseFields(incoming);
  const exactOwner = incoming.ownerInstanceId === owner;
  const exactToken = token ? incoming.leaseToken === token : !incoming.leaseToken;
  if (!exactOwner || !exactToken) return null;
  if (TERMINAL_RUN_STATUS[String(incoming.status)] === true) return withoutLeaseFields(incoming);
  return {
    ...incoming,
    ownerInstanceId: owner,
    leaseToken: token || undefined,
    leaseExpiresAt: expiresAt,
  };
}

function serverManagedRuntimeValue(
  current: Record<string, unknown> | null,
  incoming: Record<string, unknown>,
  now: number,
): Record<string, unknown> | null {
  const currentRuns = Array.isArray(current?.runs) ? current.runs : [];
  const incomingRuns = Array.isArray(incoming.runs) ? incoming.runs : [];
  const currentById = new Map<string, Record<string, unknown>>();
  for (const run of currentRuns) {
    if (isProjectStoreRecord(run) && typeof run.runId === 'string') currentById.set(run.runId, run);
  }
  const incomingIds = new Set(incomingRuns.flatMap((run) =>
    isProjectStoreRecord(run) && typeof run.runId === 'string' ? [run.runId] : []));
  const omittedActive = currentRuns.some((run) => isProjectStoreRecord(run)
    && ACTIVE_RUN_STATUS[String(run.status)] === true && !incomingIds.has(String(run.runId)));
  if (omittedActive) return null;
  const runs: Record<string, unknown>[] = [];
  for (const run of incomingRuns) {
    if (!isProjectStoreRecord(run) || typeof run.runId !== 'string') return null;
    const managed = managedActiveRun(currentById.get(run.runId), run, now);
    if (!managed) return null;
    runs.push(managed);
  }
  return { ...incoming, runs };
}


function mutationResponse(
  entry: StoredEntryValue,
  accepted: boolean,
  lease?: AgentRunLeaseState,
): ProjectStoreMutationResponse {
  return {
    accepted,
    found: entry.found,
    ...(entry.found ? { value: entry.value } : {}),
    ...(lease ? { lease } : {}),
  };
}

function supportedRuntimeEntry(key: string, entry: StoredEntryValue): Record<string, unknown> | null {
  const compatibility = classifyAgentRuntimeStoreValue(key, entry.found ? entry.value : undefined);
  if (compatibility.kind === 'absent') return null;
  if (compatibility.kind === 'supported') {
    normalizeAgentRuntimeSidecar(String(compatibility.value.projectId), compatibility.value);
    return compatibility.value;
  }
  if (compatibility.kind === 'future') {
    throw new Error(`agent runtime version ${compatibility.version} is not supported`);
  }
  throw new Error('agent runtime entry is corrupt');
}

async function compareAndSwap(
  withStoreLock: WithStoreLock,
  input: AgentRuntimeCasInput,
): Promise<ProjectStoreMutationResponse> {
  return withStoreLock(async (store) => {
    const current = await store.readEntry(input.key);
    const runtime = supportedRuntimeEntry(input.key, current);
    const revision = runtime ? Number(runtime.revision) : null;
    // Single-writer world: the agent runtime sidecar is only ever written by
    // this server process (executor events, settle endpoint, artifact store),
    // serialized by withStoreLock. The expectedRevision CAS check is gone;
    // the revision increment and terminal-status guards below still protect
    // data integrity inside the lock.
    const incoming = classifyAgentRuntimeStoreValue(input.key, input.value);
    if (incoming.kind !== 'supported') throw new Error('invalid agent runtime CAS value');
    normalizeAgentRuntimeSidecar(String(incoming.value.projectId), incoming.value);
    if (incoming.value.revision !== (revision ?? 0) + 1) {
      // Reject (not throw) so the client retry loop re-reads and converges;
      // a throw here would hard-fail a transient contest between the server
      // executor and browser-originated external-session writes.
      return mutationResponse(current, false);
    }
    if (!preservesTerminalStatuses(runtime, incoming.value)) {
      return mutationResponse(current, false);
    }
    const managed = serverManagedRuntimeValue(runtime, incoming.value, Date.now());
    if (!managed) return mutationResponse(current, false);
    await store.writeAgentRuntimeExact(input.key, managed);
    return mutationResponse(await store.readEntry(input.key), true);
  });
}

function acceptedLease(
  run: Record<string, unknown>,
  input: AgentRunLeaseInput,
  now: number,
): AgentRunLeaseState | null {
  if (ACTIVE_RUN_STATUS[String(run.status)] !== true) return null;
  const owner = typeof run.ownerInstanceId === 'string' ? run.ownerInstanceId : '';
  const token = typeof run.leaseToken === 'string' ? run.leaseToken : '';
  const expiresAt = typeof run.leaseExpiresAt === 'number' ? run.leaseExpiresAt : 0;
  const exact = owner === input.ownerInstanceId && !!input.leaseToken && token === input.leaseToken;
  if (input.action === 'check') {
    return exact && expiresAt > now
      ? { ownerInstanceId: owner, leaseToken: token, leaseExpiresAt: expiresAt }
      : null;
  }
  if (input.action === 'renew') {
    if (!exact || expiresAt <= now) return null;
    return { ownerInstanceId: owner, leaseToken: token, leaseExpiresAt: now + input.leaseMs! };
  }
  if (input.action === 'release') {
    return exact ? { ownerInstanceId: owner, leaseToken: token, leaseExpiresAt: expiresAt } : null;
  }
  // A claim always wins: single-window users must be able to resume an agent run
  // immediately even if a previous session still holds the (2-minute) lease.
  return {
    ownerInstanceId: input.ownerInstanceId,
    leaseToken: exact ? token : randomUUID(),
    leaseExpiresAt: now + input.leaseMs!,
  };
}

async function updateLease(
  withStoreLock: WithStoreLock,
  input: AgentRunLeaseInput,
): Promise<ProjectStoreMutationResponse> {
  if ((input.action === 'claim' || input.action === 'renew') && input.leaseMs === undefined) {
    throw new Error('agent run lease duration is required');
  }
  return withStoreLock(async (store) => {
    const current = await store.readEntry(input.key);
    const runtime = supportedRuntimeEntry(input.key, current);
    const runs = Array.isArray(runtime?.runs) ? runtime.runs : [];
    const run = runs.find((item) => isProjectStoreRecord(item) && item.runId === input.runId);
    if (!runtime || !isProjectStoreRecord(run)) return mutationResponse(current, false);
    const now = Date.now();
    const lease = acceptedLease(run, input, now);
    if (!lease) return mutationResponse(current, false);
    if (input.action === 'check') return mutationResponse(current, true, lease);
    const updatedRun = input.action === 'release'
      ? { ...run, ownerInstanceId: undefined, leaseToken: undefined, leaseExpiresAt: undefined, updatedAt: now }
      : { ...run, ...lease, updatedAt: now };
    const next = {
      ...runtime,
      revision: Number(runtime.revision) + 1,
      updatedAt: now,
      lastWriterId: randomUUID(),
      runs: runs.map((item) => item === run ? updatedRun : item),
    };
    await store.writeAgentRuntimeExact(input.key, next);
    const canonical = await store.readEntry(input.key);
    return mutationResponse(canonical, true, input.action === 'release' ? undefined : lease);
  });
}

export function createAgentRuntimeStoreOperations(withStoreLock: WithStoreLock): {
  compareAndSwapAgentRuntime: (input: AgentRuntimeCasInput) => Promise<ProjectStoreMutationResponse>;
  updateStoredAgentRunLease: (input: AgentRunLeaseInput) => Promise<ProjectStoreMutationResponse>;
} {
  return {
    compareAndSwapAgentRuntime: (input) => compareAndSwap(withStoreLock, input),
    updateStoredAgentRunLease: (input) => updateLease(withStoreLock, input),
  };
}
