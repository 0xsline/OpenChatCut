import assert from 'node:assert/strict';
import {
  agentSessionGenerationKey,
  agentSessionProposalKey,
  agentSessionRuntimeKey,
  parseAgentSessionGenerationRecord,
} from '../../shared/agent-session-generation.ts';
import type { AgentRuntimeSidecar } from '../../src/persist/agentRuntimeTypes.ts';
import {
  AgentSessionClearBlockedError,
  assertAgentSessionMigrationSafe,
  createAgentSessionStoreOperation,
} from './project-store-agent-session.ts';
import type { LockedProjectStore } from './project-store.ts';
const projectId = 'atomic-clear-project';
const entries = new Map<string, unknown>();
const removed: string[] = [];
const store: LockedProjectStore = {
  readEntry: async (key) => entries.has(key)
    ? { found: true, value: entries.get(key) }
    : { found: false },
  writeEntry: async (key, value) => { entries.set(key, value); },
  writeAgentRuntimeExact: async (key, value) => { entries.set(key, value); },
  writeEntryExact: async (key, value) => { entries.set(key, value); },
  removeEntry: async (key) => { removed.push(key); entries.delete(key); },
};
let lockTail = Promise.resolve();
const rotate = createAgentSessionStoreOperation(<T>(work: (locked: LockedProjectStore) => Promise<T>) => {
  const result = lockTail.then(() => work(store));
  lockTail = result.then(() => undefined, () => undefined);
  return result;
});

function runtime(run?: { runId: string; status: 'running' | 'waiting_approval' }): AgentRuntimeSidecar {
  const now = Date.now();
  return {
    version: 1,
    revision: 1,
    projectId,
    durability: 'local-sidecar',
    updatedAt: now,
    runs: run ? [{
      version: 1,
      runId: run.runId,
      projectId,
      status: run.status,
      askOnly: false,
      userInputPreview: 'clear context',
      userInputDigest: 'a'.repeat(64),
      createdAt: now,
      updatedAt: now,
      artifactIds: [],
      checkpointIds: [],
      proposalIds: [],
      events: [],
    }] : [],
    approvals: [],
    checkpoints: [],
    artifacts: [],
  };
}

const legacyArtifactId = 'clearartifact01';
entries.set(`chat:${projectId}`, { messages: [{ role: 'user', text: 'secret' }] });
entries.set(agentSessionRuntimeKey(projectId, 'legacy'), {
  ...runtime(),
  artifacts: [{
    artifactId: legacyArtifactId,
    projectId,
    runId: 'completed-run',
    kind: 'tool-result',
    bodySha256: 'b'.repeat(64),
    originalBytes: 6,
    originalChars: 6,
    createdAt: Date.now(),
    redacted: false,
    binaryOmitted: false,
  }],
});
entries.set(`agent-artifact:${projectId}:${legacyArtifactId}`, { body: 'secret' });
const first = await rotate(projectId);
const firstRecord = parseAgentSessionGenerationRecord(first.value);
assert.ok(firstRecord && firstRecord.generation !== 'legacy');
assert.equal(entries.has(`chat:${projectId}`), false, 'rotation reclaims the old chat under the same lock');
assert.equal(entries.has(`agent-runtime:${projectId}`), false, 'rotation reclaims the old runtime');
assert.equal(
  entries.has(`agent-artifact:${projectId}:${legacyArtifactId}`),
  false,
  'rotation reclaims indexed artifacts',
);

entries.set(agentSessionRuntimeKey(projectId, firstRecord.generation), runtime({
  runId: 'unrelated-run',
  status: 'running',
}));
await assert.rejects(
  () => rotate(projectId),
  (error: unknown) => error instanceof AgentSessionClearBlockedError
    && error.code === 'agent_session_clear_blocked'
    && error.run.runId === 'unrelated-run'
    && error.run.status === 'running',
  'an unrelated active run exposes structured clear-block details',
);
assert.equal(
  parseAgentSessionGenerationRecord(entries.get(agentSessionGenerationKey(projectId)))?.generation,
  firstRecord.generation,
  'a rejected clear cannot advance the marker',
);
entries.set(agentSessionProposalKey(projectId, firstRecord.generation), {
  version: 1,
  phase: 'applying',
  proposal: { id: 'applying-proposal', agentRunId: 'unrelated-run' },
});
await assert.rejects(
  () => rotate(projectId),
  (error: unknown) => error instanceof AgentSessionClearBlockedError
    && error.run.runId === 'unrelated-run'
    && error.run.status === 'running',
  'an applying proposal cannot authorize clearing an active mutation',
);

const proposalRunId = 'proposal-run';
entries.set(agentSessionRuntimeKey(projectId, firstRecord.generation), runtime({
  runId: proposalRunId,
  status: 'waiting_approval',
}));
entries.set(agentSessionProposalKey(projectId, firstRecord.generation), {
  version: 1,
  phase: 'prepared',
  proposal: { id: 'proposal-1', agentRunId: proposalRunId },
});
const proposalClear = await rotate(projectId);
const proposalRecord = parseAgentSessionGenerationRecord(proposalClear.value);
assert.ok(proposalRecord, 'the durable current proposal run is permitted without client state');

const [concurrentA, concurrentB] = await Promise.all([rotate(projectId), rotate(projectId)]);
const recordA = parseAgentSessionGenerationRecord(concurrentA.value);
const recordB = parseAgentSessionGenerationRecord(concurrentB.value);
assert.ok(recordA && recordB && recordA.generation !== recordB.generation);
assert.ok(recordB.clearedAt > recordA.clearedAt, 'server lock assigns a monotonic clear epoch');
assert.deepEqual(entries.get(agentSessionGenerationKey(projectId)), recordB);
assert.ok(removed.length >= 5);

entries.set(agentSessionRuntimeKey(projectId, 'legacy'), runtime({
  runId: 'legacy-active-run',
  status: 'running',
}));
await assert.rejects(
  () => assertAgentSessionMigrationSafe(store, {}, {
    [agentSessionGenerationKey(projectId)]: {
      version: 1,
      generation: 'browser-generation',
      clearedAt: Date.now(),
    },
  }),
  /active legacy run/,
  'first-open browser migration cannot bypass the active-run clear guard',
);
entries.delete(agentSessionRuntimeKey(projectId, 'legacy'));

console.log('project-store-agent-session.verify: atomic generation rotation and active-run guard OK');
