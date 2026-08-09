import assert from 'node:assert/strict';
import {
  isProjectStoreKey,
  isProjectStoreRequest,
  projectIdFromProjectStoreKey,
} from '../../shared/project-store-validation';
import { mergeProjectEntries } from './project-store-entries';

const left = {
  projects: [{ id: 'a', name: 'Chrome 工程', updatedAt: 10 }],
  'project:a': { marker: 'left' },
  'versions:a': [{ id: 'v1', createdAt: 1 }],
  'skills:custom': [{ id: 's1', createdAt: 1 }],
};
const right = {
  projects: [
    { id: 'b', name: 'Brave 工程', updatedAt: 20 },
    { id: 'a', name: '更新后的工程', updatedAt: 30 },
  ],
  'project:a': { marker: 'newer' },
  'project:b': { marker: 'right' },
  'versions:a': [{ id: 'v2', createdAt: 2 }],
  'skills:custom': [{ id: 's2', createdAt: 2 }],
};

const merged = mergeProjectEntries(left, right);
assert.deepEqual((merged.projects as Array<{ id: string }>).map((project) => project.id), ['a', 'b']);
assert.deepEqual(merged['project:a'], { marker: 'newer' });
assert.deepEqual(merged['project:b'], { marker: 'right' });
assert.deepEqual((merged['versions:a'] as Array<{ id: string }>).map((version) => version.id), ['v1', 'v2']);
assert.deepEqual((merged['skills:custom'] as Array<{ id: string }>).map((skill) => skill.id), ['s1', 's2']);

const older = mergeProjectEntries(merged, {
  projects: [{ id: 'a', name: '旧工程', updatedAt: 5 }],
  'project:a': { marker: 'older' },
});
assert.deepEqual(older['project:a'], { marker: 'newer' });
assert.equal((older.projects as Array<{ name: string }>)[0].name, '更新后的工程');

const afterPermanentDelete = mergeProjectEntries(merged, {
  projects: [{ id: 'a', name: '另一个浏览器里的旧副本', updatedAt: 40 }],
  'project:a': { marker: 'stale-browser' },
  'chat:a': { messages: ['stale'] },
  'versions:a': [{ id: 'v3', createdAt: 3 }],
}, new Set(['a']));
assert.deepEqual(
  (afterPermanentDelete.projects as Array<{ id: string }>).map((project) => project.id),
  ['b'],
  '永久删除标记必须阻止另一个浏览器的旧工程复活',
);
assert.ok(!('project:a' in afterPermanentDelete));
assert.ok(!('chat:a' in afterPermanentDelete));
assert.ok(!('versions:a' in afterPermanentDelete));

const projectId = 'p'.repeat(160);
const artifactId = 'a'.repeat(20);
const artifactKey = `agent-artifact:${projectId}:${artifactId}`;
assert.equal(isProjectStoreKey(`agent-runtime:${projectId}`), true);
assert.equal(isProjectStoreKey(artifactKey), true, 'maximum legal agent artifact key is accepted');
assert.equal(projectIdFromProjectStoreKey(artifactKey), projectId, 'artifact id is never parsed as project id');
assert.equal(isProjectStoreKey(`agent-artifact:${projectId}:${artifactId}x`), false);
assert.equal(isProjectStoreKey(`agent-artifact:${projectId}:bad.id`), false);
assert.equal(isProjectStoreKey(`agent-runtime:${projectId}x`), false);
assert.equal(isProjectStoreKey('proposal:legacy:compatible'), true, 'existing key formats stay compatible');
for (const prefix of ['external-proposal', 'offline-edit-session', 'project-edit-ownership', 'review']) {
  assert.equal(isProjectStoreKey(`${prefix}:${projectId}`), true);
  assert.equal(isProjectStoreKey(`${prefix}:${projectId}:ambiguous`), false);
}
assert.equal(isProjectStoreRequest({ operation: 'purge-project', projectId }), true);
assert.equal(isProjectStoreRequest({ operation: 'purge-project', projectId, extra: true }), false);
assert.equal(isProjectStoreRequest({ operation: 'purge-project', projectId: `${projectId}:other` }), false);

const runtimeSidecar = (owner: string, revision: number, updatedAt: number, marker: string) => ({
  version: 1,
  revision,
  projectId: owner,
  durability: 'local-sidecar',
  updatedAt,
  runs: [{ projectId: owner, runId: marker, updatedAt }],
  approvals: [],
  checkpoints: [],
  artifacts: [],
});
const artifactRecord = (owner: string, id: string, body: string, digestChar: string) => ({
  version: 1,
  artifactId: id,
  projectId: owner,
  runId: 'run_1',
  kind: 'tool-result',
  bodySha256: digestChar.repeat(64),
  originalBytes: body.length,
  originalChars: body.length,
  createdAt: 1,
  redacted: false,
  binaryOmitted: false,
  body,
});

const runtimeRun = (
  owner: string,
  runId: string,
  eventId: string,
  artifactId: string,
  checkpointId: string,
  updatedAt: number,
) => ({
  runId,
  projectId: owner,
  status: 'completed',
  updatedAt,
  events: [{ eventId, projectId: owner, runId, sequence: updatedAt, createdAt: updatedAt }],
  artifactIds: [artifactId],
  checkpointIds: [checkpointId],
  proposalIds: [],
});
const structuralRuntime = (
  owner: string,
  revision: number,
  updatedAt: number,
  run: ReturnType<typeof runtimeRun>,
) => ({
  version: 1,
  revision,
  projectId: owner,
  durability: 'local-sidecar',
  updatedAt,
  runs: [run],
  approvals: [{
    approvalId: `approval_${run.runId}`,
    projectId: owner,
    runId: run.runId,
    status: 'allowed',
    createdAt: updatedAt,
  }],
  checkpoints: [{
    checkpointId: run.checkpointIds[0],
    projectId: owner,
    runId: run.runId,
    sourceArtifactId: run.artifactIds[0],
    createdAt: updatedAt,
  }],
  artifacts: [{
    artifactId: run.artifactIds[0],
    projectId: owner,
    runId: run.runId,
    originalBytes: 4,
    createdAt: updatedAt,
  }],
});
const serverRuntime = runtimeSidecar('a', 4, 40, 'server');
const serverArtifact = artifactRecord('a', 'collision', 'server', 'a');

const sidecarMerge = mergeProjectEntries({
  projects: [{ id: 'a', updatedAt: 1 }],
  'agent-runtime:a': serverRuntime,
  'agent-artifact:a:collision': serverArtifact,
  'chat:a': { messages: ['server'] },
  'proposal:a': { value: 'server' },
}, {
  projects: [{ id: 'a', updatedAt: 2 }],
  'agent-runtime:a': runtimeSidecar('a', 3, 100, 'stale'),
  'agent-artifact:a:collision': artifactRecord('a', 'collision', 'incoming', 'b'),
  'chat:a': { messages: ['incoming'] },
  'proposal:a': { value: 'incoming' },
});
assert.deepEqual(sidecarMerge['agent-runtime:a'], serverRuntime);
assert.deepEqual(
  sidecarMerge['agent-artifact:a:collision'],
  serverArtifact,
  'immutable artifact collisions preserve the server record',
);
assert.deepEqual(sidecarMerge['chat:a'], { messages: ['incoming'] });
assert.deepEqual(sidecarMerge['proposal:a'], { value: 'incoming' });

const newerRuntime = mergeProjectEntries(sidecarMerge, {
  'agent-runtime:a': runtimeSidecar('a', 5, 1, 'newer-revision'),
});
assert.equal((newerRuntime['agent-runtime:a'] as { revision: number }).revision, 5);
const newerTimestamp = mergeProjectEntries(newerRuntime, {
  'agent-runtime:a': runtimeSidecar('a', 5, 2, 'newer-time'),
});
assert.deepEqual(newerTimestamp['agent-runtime:a'], runtimeSidecar('a', 5, 2, 'newer-time'));
assert.deepEqual(
  mergeProjectEntries(newerTimestamp, {
    'agent-runtime:a': runtimeSidecar('a', 5, 2, 'tie-loses'),
  })['agent-runtime:a'],
  newerTimestamp['agent-runtime:a'],
  'runtime ties preserve the existing server value',
);

const leftConcurrent = structuralRuntime(
  'a', 6, 60, runtimeRun('a', 'shared_run', 'event_left', 'artifact_left', 'checkpoint_left', 60),
);
const rightConcurrent = structuralRuntime(
  'a', 6, 60, runtimeRun('a', 'shared_run', 'event_right', 'artifact_right', 'checkpoint_right', 61),
);
leftConcurrent.runs.push({
  ...runtimeRun('a', 'left_only_run', 'left_only_event', 'unused_left', 'unused_left_checkpoint', 59),
  artifactIds: [],
  checkpointIds: [],
});
rightConcurrent.runs.push({
  ...runtimeRun('a', 'right_only_run', 'right_only_event', 'unused_right', 'unused_right_checkpoint', 62),
  artifactIds: [],
  checkpointIds: [],
});
const structurallyMerged = mergeProjectEntries(
  { 'agent-runtime:a': leftConcurrent },
  { 'agent-runtime:a': rightConcurrent },
)['agent-runtime:a'] as {
  runs: Array<{ runId: string; events: Array<{ eventId: string }>; artifactIds: string[]; checkpointIds: string[] }>;
  approvals: Array<{ approvalId: string }>;
  checkpoints: Array<{ checkpointId: string }>;
  artifacts: Array<{ artifactId: string }>;
};
const sharedRun = structurallyMerged.runs.find((run) => run.runId === 'shared_run');
assert.deepEqual(
  new Set(structurallyMerged.runs.map((run) => run.runId)),
  new Set(['shared_run', 'left_only_run', 'right_only_run']),
  'concurrent browser writers preserve distinct runs',
);
assert.deepEqual(sharedRun?.events.map((event) => event.eventId), ['event_left', 'event_right']);
assert.deepEqual(new Set(sharedRun?.artifactIds), new Set(['artifact_left', 'artifact_right']));
assert.deepEqual(new Set(sharedRun?.checkpointIds), new Set(['checkpoint_left', 'checkpoint_right']));
assert.equal(structurallyMerged.approvals.length, 1, 'same stable approval id is deduplicated');
assert.deepEqual(
  new Set(structurallyMerged.checkpoints.map((row) => row.checkpointId)),
  new Set(['checkpoint_left', 'checkpoint_right']),
);
const leasedBaseRun = {
  ...runtimeRun('a', 'leased-run', 'base-event', 'base-artifact', 'base-checkpoint', 70),
  status: 'running',
  ownerInstanceId: 'owner-a',
  leaseToken: 'lease-a',
  leaseExpiresAt: Date.now() + 60_000,
};
const staleTerminalRun = {
  ...runtimeRun('a', 'leased-run', 'stale-event', 'stale-artifact', 'stale-checkpoint', 80),
  status: 'failed',
  ownerInstanceId: 'owner-b',
  leaseToken: 'lease-b',
};
const leasedMerge = mergeProjectEntries(
  { 'agent-runtime:a': structuralRuntime('a', 7, 70, leasedBaseRun) },
  { 'agent-runtime:a': structuralRuntime('a', 7, 80, staleTerminalRun) },
)['agent-runtime:a'] as { runs: Array<{ status: string; events: unknown[] }> };
assert.equal(leasedMerge.runs[0]?.status, 'running', 'a stale owner cannot terminalize a leased run');
assert.equal(leasedMerge.runs[0]?.events.length, 2, 'lease fencing retains append-only event union');
const terminalBase = { ...leasedBaseRun, status: 'completed' };
const terminalSwitch = { ...leasedBaseRun, status: 'failed', updatedAt: 90 };
const terminalMerge = mergeProjectEntries(
  { 'agent-runtime:a': structuralRuntime('a', 8, 80, terminalBase) },
  { 'agent-runtime:a': structuralRuntime('a', 8, 90, terminalSwitch) },
)['agent-runtime:a'] as { runs: Array<{ status: string }> };
assert.equal(terminalMerge.runs[0]?.status, 'completed', 'terminal run state is absorbing');
assert.deepEqual(
  new Set(structurallyMerged.artifacts.map((row) => row.artifactId)),
  new Set(['artifact_left', 'artifact_right']),
  'concurrent writers preserve both reachable artifact indexes',
);

const distinctRuns = Array.from({ length: 40 }, (_, index) => runtimeRun(
  'a', `run_${index}`, `event_${index}`, `artifact_${index}`, `checkpoint_${index}`, index + 1,
));
const boundedLeft = { ...structuralRuntime('a', 7, 70, distinctRuns[0]!), runs: distinctRuns.slice(0, 20),
  approvals: [], checkpoints: [], artifacts: [] };
const boundedRight = { ...structuralRuntime('a', 7, 70, distinctRuns[20]!), runs: distinctRuns.slice(20),
  approvals: [], checkpoints: [], artifacts: [] };
const boundedMerge = mergeProjectEntries(
  { 'agent-runtime:a': boundedLeft },
  { 'agent-runtime:a': boundedRight },
)['agent-runtime:a'] as { runs: unknown[] };
assert.equal(boundedMerge.runs.length, 30, 'structural sidecar merge enforces retained run bounds');

const validReplacement = runtimeSidecar('a', 1, 1, 'valid-replacement');

const corruptServerRuntime = { version: 1, projectId: 'a', revision: 'corrupt', updatedAt: 99 };
assert.deepEqual(
  mergeProjectEntries(
    { 'agent-runtime:a': corruptServerRuntime },
    { 'agent-runtime:a': validReplacement },
  )['agent-runtime:a'],
  corruptServerRuntime,
  'a corrupt existing runtime is preserved for quarantine instead of being silently replaced',
);
const futureRuntime = {
  version: 2,
  projectId: 'a',
  opaqueFutureState: { mustSurvive: true },
};
assert.deepEqual(
  mergeProjectEntries(
    { 'agent-runtime:a': futureRuntime },
    { 'agent-runtime:a': validReplacement },
  )['agent-runtime:a'],
  futureRuntime,
  'an old client cannot downgrade an existing future runtime sidecar',
);
assert.deepEqual(
  mergeProjectEntries(
    { 'agent-runtime:a': validReplacement },
    { 'agent-runtime:a': futureRuntime },
  )['agent-runtime:a'],
  futureRuntime,
  'a future runtime sidecar is preserved unchanged when first imported',
);
const serverOwnership = {
  version: 1,
  projectId: 'a',
  ownerKind: 'offline',
  ownerId: 'server-owner',
  epoch: 7,
  baseRevision: 'server-revision',
  leaseExpiresAt: 999,
  updatedAt: 10,
};
assert.deepEqual(
  mergeProjectEntries(
    { 'project-edit-ownership:a': serverOwnership },
    { 'project-edit-ownership:a': { ...serverOwnership, epoch: 99, ownerId: 'browser-cache' } },
  )['project-edit-ownership:a'],
  serverOwnership,
  'browser bootstrap data cannot overwrite the server-owned project fence',
);
assert.equal(
  'project-edit-ownership:a' in mergeProjectEntries({}, {
    'project-edit-ownership:a': serverOwnership,
  }),
  false,
  'browser bootstrap data cannot create a server ownership fence',
);
const corruptIncoming = mergeProjectEntries({ 'project:a': { marker: 'safe' } }, {
  'agent-runtime:a': { revision: Number.NaN, updatedAt: 999 },
  'agent-artifact:a:bad': { body: 'missing integrity metadata' },
});
assert.deepEqual(corruptIncoming['project:a'], { marker: 'safe' });
assert.ok(!('agent-runtime:a' in corruptIncoming));
assert.ok(!('agent-artifact:a:bad' in corruptIncoming));

const deletedSidecars = mergeProjectEntries({}, {
  projects: [{ id: projectId, updatedAt: 1 }],
  [`project:${projectId}`]: { marker: 'stale' },
  [`agent-runtime:${projectId}`]: runtimeSidecar(projectId, 1, 1, 'stale'),
  [artifactKey]: artifactRecord(projectId, artifactId, 'stale', 'c'),
  [`external-proposal:${projectId}`]: { status: 'prepared' },
  [`offline-edit-session:${projectId}`]: { status: 'prepared' },
  [`review:${projectId}`]: { status: 'pending' },
}, new Set([projectId]));
assert.deepEqual(deletedSidecars.projects, [], 'deleted-project bootstrap cannot restore project metadata');
for (const key of [
  `agent-runtime:${projectId}`,
  artifactKey,
  `external-proposal:${projectId}`,
  `offline-edit-session:${projectId}`,
  `review:${projectId}`,
]) assert.ok(!(key in deletedSidecars), `${key} cannot survive its project tombstone`);
