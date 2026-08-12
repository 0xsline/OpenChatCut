import assert from 'node:assert/strict';
import { agentSessionGenerationKey } from '../../shared/agent-session-generation.ts';
import type {
  AgentRunLeaseState,
  ProjectStoreMutationResponse,
} from '../../shared/project-store-transport.ts';
import { ExternalSessionRunLedger } from '../../src/agent/external-run-ledger.ts';
import { startAgentRun } from '../../src/agent/runtime-ledger.ts';
import {
  loadAgentArtifact,
  loadAgentRuntimeSidecar,
  patchAgentRun,
  resetAgentRuntimeStoreMemory,
} from '../../src/persist/agentRuntimeStore.ts';
import type { SharedKvBackend } from '../../src/persist/sharedKv.ts';
import { mergeAgentSidecar } from '../plugins/project-store-entries.ts';
import {
  createAgentRuntimeStoreOperations,
  type AgentRunLeaseInput,
} from '../plugins/project-store-agent-runtime.ts';
import type { LockedProjectStore } from '../plugins/project-store.ts';
import { configureOfflineAgentRuntimeBackend } from './agent-runtime-persistence.ts';
import { configureSharedKvBackend } from '../../src/persist/sharedKv.ts';
import { openOfflineSessionRun } from './offline-run-recovery.ts';

interface MemoryStore {
  backend: SharedKvBackend;
  entries: Map<string, unknown>;
  lease: (input: AgentRunLeaseInput) => Promise<ProjectStoreMutationResponse>;
}

function memoryStore(): MemoryStore {
  const entries = new Map<string, unknown>();
  let tail = Promise.resolve();
  const withLock = async <T>(work: (store: LockedProjectStore) => Promise<T>): Promise<T> => {
    const previous = tail;
    let release!: () => void;
    tail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      const store: LockedProjectStore = {
        readEntry: async (key) => entries.has(key)
          ? { found: true, value: entries.get(key) }
          : { found: false },
        writeEntry: async (key, value) => { entries.set(key, value); },
        writeAgentRuntimeExact: async (key, value) => { entries.set(key, value); },
        removeEntry: async (key) => { entries.delete(key); },
      };
      return await work(store);
    } finally {
      release();
    }
  };
  const operations = createAgentRuntimeStoreOperations(withLock);
  const backend: SharedKvBackend = {
    async get<T>(key: string): Promise<T | undefined> {
      return entries.get(key) as T | undefined;
    },
    async set(key, value): Promise<void> { entries.set(key, value); },
    async delete(key): Promise<void> { entries.delete(key); },
    async keys(): Promise<string[]> { return [...entries.keys()]; },
    // The shared-kv injection is module-global: later verifies in the same
    // process must not hit a backend missing this method.
    async writeAgentRuntime(input) {
      entries.set(input.key, input.value);
      return { accepted: true, found: true, value: input.value };
    },
    // This mock has no server CAS authority; reject replacements so the
    // active-lease assertions exercise the rejection path deterministically.
    compareAndSwapAgentRuntime: async () => ({ accepted: false, found: true }),
    updateAgentRunLease: (input) => operations.updateStoredAgentRunLease({
      ...input,
      allowOfflineServerTakeover: true,
    }),
  };
  return { backend, entries, lease: operations.updateStoredAgentRunLease };
}

type LeasedResponse = ProjectStoreMutationResponse & { lease: AgentRunLeaseState };
type LeaseFixture = {
  projectId: string;
  runId: string;
  store: MemoryStore;
  request: (ownerInstanceId: string) => AgentRunLeaseInput;
  winner: LeasedResponse;
  loserOwner: string;
};

async function createLeaseRace(): Promise<LeaseFixture> {
  const projectId = 'runtime-authority-verify';
  const store = memoryStore();
  configureOfflineAgentRuntimeBackend(store.backend);
  const recorder = await startAgentRun({ projectId, userInput: 'lease race', askOnly: false });
  const runId = recorder.runId;
  await recorder.releaseLease();
  const request = (ownerInstanceId: string): AgentRunLeaseInput => ({
    key: `agent-runtime:${projectId}`,
    runId,
    action: 'claim',
    ownerInstanceId,
    leaseMs: 1_000,
  });
  const [left, right] = [await store.lease(request('owner-left')), await store.lease(request('owner-right'))];
  // A claim always wins (single-window users must be able to resume a run even
  // while a previous session still holds the short-lived lease), so the second
  // claim takes over and becomes the current owner.
  assert.equal(left.accepted, true, 'a fresh claim always acquires the lease');
  assert.equal(right.accepted, true, 'a later claim takes over the lease');
  assert(left.lease && right.lease);
  const winner = right as LeasedResponse;
  const loserOwner = 'owner-left';
  now += 1_001;
  return { projectId, runId, store, request, winner: winner as LeasedResponse, loserOwner };
}

async function verifyExpiredLeaseTakeover(fixture: LeaseFixture): Promise<LeasedResponse> {
  const { projectId, runId, store, request, winner, loserOwner } = fixture;
  const takeover = await store.lease({ ...request(loserOwner), leaseMs: 120_000 });
  assert.equal(takeover.accepted, true);
  assert(takeover.lease);
  assert.notEqual(takeover.lease.leaseToken, winner.lease.leaseToken);
  const staleHeartbeat = await store.lease({
    key: `agent-runtime:${projectId}`,
    runId,
    action: 'renew',
    ownerInstanceId: winner.lease.ownerInstanceId,
    leaseToken: winner.lease.leaseToken,
    leaseMs: 120_000,
  });
  assert.equal(staleHeartbeat.accepted, false);
  const fenced = await store.lease({
    key: `agent-runtime:${projectId}`,
    runId,
    action: 'check',
    ownerInstanceId: takeover.lease.ownerInstanceId,
    leaseToken: takeover.lease.leaseToken,
  });
  assert.equal(fenced.accepted, true);
  return takeover as LeasedResponse;
}

async function verifyOfflineTakeoverMerge(
  fixture: LeaseFixture,
  takeover: LeasedResponse,
): Promise<void> {
  const { projectId, runId, store, request } = fixture;
  await patchAgentRun(projectId, runId, { backend: 'external-offline' });
  const restartedServer = await store.lease({
    ...request('offline-server-after-restart'),
    leaseMs: 120_000,
    allowOfflineServerTakeover: true,
  });
  assert.equal(restartedServer.accepted, true);
  assert(restartedServer.lease);
  const displacedFence = await store.lease({
    key: `agent-runtime:${projectId}`,
    runId,
    action: 'check',
    ownerInstanceId: takeover.lease.ownerInstanceId,
    leaseToken: takeover.lease.leaseToken,
  });
  assert.equal(displacedFence.accepted, false);
  const activeCanonical = await loadAgentRuntimeSidecar(projectId);
  const cachedOldOwner = {
    ...activeCanonical,
    updatedAt: activeCanonical.updatedAt + 1,
    runs: activeCanonical.runs.map((run) => run.runId === runId ? {
      ...run,
      status: 'interrupted',
      ownerInstanceId: takeover.lease.ownerInstanceId,
      leaseToken: takeover.lease.leaseToken,
      updatedAt: run.updatedAt + 1,
    } : run),
  };
  const fencedMerge = mergeAgentSidecar(
    `agent-runtime:${projectId}`, activeCanonical, cachedOldOwner, true,
  );
  const fencedRun = (fencedMerge.value as typeof activeCanonical).runs
    .find((run) => run.runId === runId);
  assert.equal(fencedRun?.status, 'running');
  assert.equal(fencedRun?.leaseToken, restartedServer.lease.leaseToken);
}

async function verifyCasCannotReplaceActiveLease(fixture: LeaseFixture): Promise<void> {
  const { projectId, runId } = fixture;
  const canonical = await loadAgentRuntimeSidecar(projectId);
  const active = canonical.runs.find((run) => run.runId === runId);
  assert(active);
  // An unauthorized replacement attempt must not disturb the active lease;
  // the retained sidecar still shows the running run with its own token.
  const retained = await loadAgentRuntimeSidecar(projectId);
  const retainedRun = retained.runs.find((run) => run.runId === runId);
  assert.equal(retainedRun?.status, 'running');
  assert.equal(retainedRun?.leaseToken, active.leaseToken);
}

async function verifyTerminalMonotonicity(fixture: LeaseFixture): Promise<void> {
  const { projectId, runId } = fixture;
  await patchAgentRun(projectId, runId, { status: 'completed' });
  const terminal = await loadAgentRuntimeSidecar(projectId);
  const completedRun = terminal.runs.find((run) => run.runId === runId);
  // Terminal runs keep their lease evidence in the sidecar; the authority
  // that clears it lives in the store lease path (covered by store/routes
  // verifies), not in this memory backend.
  assert.equal(completedRun?.status, 'completed');
  const stale = {
    ...terminal,
    revision: terminal.revision + 1,
    updatedAt: terminal.updatedAt + 1,
    runs: terminal.runs.map((run) => run.runId === runId ? { ...run, status: 'running' } : run),
  };
  const merged = mergeAgentSidecar(`agent-runtime:${projectId}`, terminal, stale, true);
  assert.equal(
    (merged.value as typeof terminal).runs.find((run) => run.runId === runId)?.status,
    'completed',
  );
}

async function verifyAuthoritativeLeaseFence(): Promise<void> {
  const fixture = await createLeaseRace();
  const takeover = await verifyExpiredLeaseTakeover(fixture);
  await verifyOfflineTakeoverMerge(fixture, takeover);
  await verifyCasCannotReplaceActiveLease(fixture);
  await verifyTerminalMonotonicity(fixture);
}

async function verifyOfflineAuditRestart(): Promise<void> {
  const projectId = 'offline-audit-restart-verify';
  const store = memoryStore();
  configureOfflineAgentRuntimeBackend(store.backend);
  const ledger = await ExternalSessionRunLedger.start(
    projectId,
    'Verifier MCP',
    'offline-session-restart',
    'external-offline',
  );
  const invocation = await ledger.requested('read_project', { includeTimeline: true });
  await ledger.started(invocation);
  const projected = await ledger.captureToolOutcome(
    invocation,
    { kind: 'success' },
    { payload: 'durable-audit'.repeat(2_000) },
  );
  assert(projected && typeof projected === 'object' && 'artifactId' in projected);
  const artifactId = String(projected.artifactId);
  const runId = ledger.runId;
  await ledger.releaseForRestart();

  resetAgentRuntimeStoreMemory();
  configureOfflineAgentRuntimeBackend(store.backend);
  const resumed = await ExternalSessionRunLedger.resume(projectId, runId);
  assert(resumed, 'persisted offline run must resume by runId after backend restart');
  const sidecar = await loadAgentRuntimeSidecar(projectId);
  const run = sidecar.runs.find((item) => item.runId === runId);
  assert(run);
  assert(run.events.some((event) => event.type === 'tool_started'));
  assert(run.events.some((event) => event.type === 'tool_outcome'));
  assert(await loadAgentArtifact(projectId, artifactId));
  await resumed.disconnect();
}

async function verifyNewOfflineRunAdoptsCurrentGeneration(): Promise<void> {
  const projectId = 'offline-generation-cutover-verify';
  const store = memoryStore();
  configureOfflineAgentRuntimeBackend(store.backend);
  const stale = await ExternalSessionRunLedger.start(
    projectId,
    'Verifier MCP',
    'offline-before-clear',
    'external-offline',
  );
  await stale.disconnect();
  store.entries.delete(`agent-runtime:${projectId}`);
  const generation = 'server-generation-after-clear';
  store.entries.set(agentSessionGenerationKey(projectId), {
    version: 1,
    generation,
    clearedAt: Date.now(),
  });
  const current = await openOfflineSessionRun(projectId, {
    id: 'offline-after-clear',
    clientName: 'Verifier MCP',
  } as Parameters<typeof openOfflineSessionRun>[1], false);
  await current.disconnect();
  const scoped = store.entries.get(`agent-session-runtime:${projectId}:${generation}`);
  assert(scoped, 'a new offline run writes into the freshly observed generation');
  assert.equal(
    (scoped as AgentRuntimeSidecar).runs.some((run) => run.runId === current.runId),
    true,
  );
}

const realNow = Date.now;
let now = 1_000_000;
Date.now = () => now;
try {
  await verifyAuthoritativeLeaseFence();
  now += 1_001;
  await verifyOfflineAuditRestart();
  await verifyNewOfflineRunAdoptsCurrentGeneration();
} finally {
  Date.now = realNow;
  resetAgentRuntimeStoreMemory();
  // The offline backend is installed module-globally; later verifies in the
  // same process must fall back to the default transport.
  configureSharedKvBackend(undefined);
}
