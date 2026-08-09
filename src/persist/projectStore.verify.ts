import assert from 'node:assert/strict';
import type { ProjectDoc } from '../editor/types';
import { CURRENT_PROJECT_VERSION } from '../../shared/project-version';
import {
  createProject,
  deleteProject,
  hasProjectHistory,
  listProjects,
  loadChat,
  purgeProject,
  renameProject,
  resetProjectStoreMemory,
  saveChat,
  updateProjectMeta,
} from './projectStore';
import {
  ProjectIndexCoordinator,
  SaveCoordinator,
  type ProjectMeta,
} from './projectStoreCoordinators';
import { recoverFailedAutosave } from './autosaveRecovery';
import { kvKeys, kvSet } from './sharedKv';
import {
  MAX_AUTOMATIC_VERSIONS,
  listVersions,
  saveAutomaticVersion,
  saveVersion,
} from './versionStore';

const emptyDoc: ProjectDoc = {
  version: CURRENT_PROJECT_VERSION,
  assets: [],
  mediaFolders: [],
  timelines: [],
  activeTimelineId: '',
};

const versionDoc = (name: string): ProjectDoc => ({
  ...emptyDoc,
  activeTimelineId: 'timeline',
  timelines: [{
    id: 'timeline',
    name,
    order: 0,
    fps: 30,
    width: 1920,
    height: 1080,
    items: [],
    selectedId: null,
  }],
});

resetProjectStoreMemory();
assert.equal(await hasProjectHistory(), false, 'brand-new store has no project history');

const project = await createProject('仅有工程', emptyDoc);
assert.equal(await hasProjectHistory(), true, 'creating a project initializes the store');
await saveChat(project.id, {
  messages: [],
  llm: [],
  toolFailures: [{ name: 'edit_item', reason: 'item not found' }],
});
assert.deepEqual(
  (await loadChat(project.id))?.toolFailures,
  [{ name: 'edit_item', reason: 'item not found' }],
  'unresolved Agent tool failures survive chat reloads',
);
const projectOwnedKeys = [
  `agent-runtime:${project.id}`,
  `agent-artifact:${project.id}:result_01`,
  `agent-session-generation:${project.id}`,
  `agent-session-chat:${project.id}:generation_1`,
  `agent-session-proposal:${project.id}:generation_1`,
  `agent-session-runtime:${project.id}:generation_1`,
  `agent-session-artifact:${project.id}:generation_1:result_03`,
  `agent-artifact:${project.id}:result_02`,
  `external-proposal:${project.id}`,
  `offline-edit-session:${project.id}`,
  `project-edit-ownership:${project.id}`,
  `review:${project.id}`,
];
for (const key of projectOwnedKeys) await kvSet(key, { marker: key });
await kvSet('agent-artifact:another-project:keep', { marker: 'unrelated' });

const clearedScopes: string[] = [];
await purgeProject(project.id, { semanticCleanup: async (scopeId) => { clearedScopes.push(scopeId); } });
assert.deepEqual(clearedScopes, [project.id], 'permanent purge clears semantic vectors for the project scope');
assert.deepEqual(await listProjects(), [], 'the final project is permanently deleted');
assert.equal(await hasProjectHistory(), true, 'deleting the final project must not recreate the demo');
const keysAfterPurge = await kvKeys();
for (const key of projectOwnedKeys) {
  assert.ok(!keysAfterPurge.includes(key), `permanent purge removes ${key}`);
}
assert.ok(
  keysAfterPurge.includes('agent-artifact:another-project:keep'),
  'project purge does not remove another project sidecar',
);

const versionProjectId = 'automatic-version-retention-check';
const manualDoc = versionDoc('Manual');
await saveVersion(versionProjectId, 'Manual checkpoint', manualDoc);
assert.equal(
  await saveAutomaticVersion(versionProjectId, 'Duplicate automatic', manualDoc),
  null,
  'automatic snapshots deduplicate against the latest saved document',
);
for (let index = 1; index <= MAX_AUTOMATIC_VERSIONS + 5; index += 1) {
  await saveAutomaticVersion(versionProjectId, `Automatic ${index}`, versionDoc(`Edit ${index}`));
}
const versions = await listVersions(versionProjectId);
const automaticVersions = versions.filter((version) => version.automatic);
assert.equal(automaticVersions.length, MAX_AUTOMATIC_VERSIONS, 'automatic snapshot retention is bounded');
assert.equal(versions.filter((version) => !version.automatic).length, 1, 'manual snapshots survive automatic retention');
assert.equal(automaticVersions[0]?.doc.timelines[0]?.name, `Edit ${MAX_AUTOMATIC_VERSIONS + 5}`);
assert.equal(automaticVersions.at(-1)?.doc.timelines[0]?.name, 'Edit 6');
const concurrentProjectId = 'concurrent-version-mutation-check';
await Promise.all(Array.from({ length: 12 }, (_, index) =>
  saveVersion(concurrentProjectId, `Manual ${index}`, versionDoc(`Concurrent ${index}`))));
assert.equal(
  (await listVersions(concurrentProjectId)).length,
  12,
  'concurrent manual snapshots are serialized without lost updates',
);
const duplicateDoc = versionDoc('Concurrent automatic duplicate');
await Promise.all(Array.from({ length: 8 }, () =>
  saveAutomaticVersion(concurrentProjectId, 'Automatic duplicate', duplicateDoc)));
const concurrentVersions = await listVersions(concurrentProjectId);
assert.equal(concurrentVersions.length, 13, 'concurrent automatic snapshots deduplicate inside the mutation boundary');
assert.equal(
  concurrentVersions.filter((version) => version.automatic).length,
  1,
  'only one concurrent automatic snapshot is retained for an identical document',
);

// SaveCoordinator captures immutable snapshots, serializes a project's writes,
// and flushes through work that was enqueued while an older revision was active.
{
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const writes: string[] = [];
  let activeWriters = 0;
  let maxActiveWriters = 0;
  const coordinator = new SaveCoordinator(async (_projectId, snapshot) => {
    activeWriters += 1;
    maxActiveWriters = Math.max(maxActiveWriters, activeWriters);
    const name = snapshot.timelines[0]?.name ?? '';
    if (name === 'First') await firstGate;
    writes.push(name);
    activeWriters -= 1;
    return { saved: true, indexUpdated: true };
  });

  const first = versionDoc('First');
  const firstSave = coordinator.enqueue('serial-project', first);
  await Promise.resolve();
  first.timelines[0]!.name = 'mutated after enqueue';
  const secondSave = coordinator.enqueue('serial-project', versionDoc('Second'));
  releaseFirst();

  assert.equal((await firstSave).status, 'saved');
  assert.equal((await secondSave).status, 'saved');
  assert.deepEqual(writes, ['First', 'Second'], 'queued saves use immutable snapshots and revision order');
  assert.equal(maxActiveWriters, 1, 'one project never has concurrent persistence writers');
  assert.equal((await coordinator.flush('serial-project')).ok, true);
  assert.deepEqual(writes.at(-1), 'Second', 'an older completion cannot overwrite the newer revision');
}

// Editor autosave recovery is monotonic across enqueue attempts. If S1 fails
// after S2 has already been queued and saved, leaving must not enqueue S1 again.
{
  type PendingSave = { projectId: string; doc: ProjectDoc };
  let releaseS1!: () => void;
  const s1Gate = new Promise<void>((resolve) => { releaseS1 = resolve; });
  const writes: string[] = [];
  const coordinator = new SaveCoordinator(async (_projectId, snapshot) => {
    const name = snapshot.timelines[0]?.name ?? '';
    writes.push(name);
    if (name === 'S1') {
      await s1Gate;
      return { saved: false, indexUpdated: false };
    }
    return { saved: true, indexUpdated: true };
  });
  let unsaved: PendingSave | null = null;
  let latestEnqueuedAttempt = 0;
  const enqueuePending = () => {
    const pending = unsaved;
    if (pending === null) return null;
    unsaved = null;
    const attempt = ++latestEnqueuedAttempt;
    const saving = coordinator.enqueue(pending.projectId, pending.doc);
    void saving.then((result) => {
      if (result.status === 'failed') {
        unsaved = recoverFailedAutosave({
          currentUnsaved: unsaved,
          failedSnapshot: pending,
          failedAttempt: attempt,
          latestEnqueuedAttempt,
        });
      }
    });
    return saving;
  };

  unsaved = { projectId: 'autosave-project', doc: versionDoc('S1') };
  const s1Save = enqueuePending();
  assert.ok(s1Save);
  await Promise.resolve();
  unsaved = { projectId: 'autosave-project', doc: versionDoc('S2') };
  const s2Save = enqueuePending();
  assert.ok(s2Save);
  releaseS1();

  assert.equal((await s1Save).status, 'failed');
  assert.equal((await s2Save).status, 'saved');
  assert.equal(unsaved, null, 'an older S1 failure cannot revive its snapshot after S2 was enqueued');
  assert.equal(enqueuePending(), null, 'leaving after S2 succeeds must not enqueue stale S1');
  assert.deepEqual(writes, ['S1', 'S2']);
}

{
  const latestSnapshot = { projectId: 'retry-project', doc: versionDoc('Latest failed') };
  assert.equal(
    recoverFailedAutosave({
      currentUnsaved: null,
      failedSnapshot: latestSnapshot,
      failedAttempt: 3,
      latestEnqueuedAttempt: 3,
    }),
    latestSnapshot,
    'the latest failed attempt restores its exact snapshot for retry',
  );
}

// A rejected write is observable through both enqueue and flush. The queue tail
// recovers so a later edit can be saved and clears the failed flush state.
{
  let attempts = 0;
  const coordinator = new SaveCoordinator(async () => {
    attempts += 1;
    if (attempts === 1) throw new Error('simulated quota failure');
    return { saved: true, indexUpdated: true };
  });
  const failed = await coordinator.enqueue('recover-project', versionDoc('Failed'));
  assert.equal(failed.status, 'failed');
  assert.equal((await coordinator.flush('recover-project')).ok, false);

  const recovered = await coordinator.enqueue('recover-project', versionDoc('Recovered'));
  assert.equal(recovered.status, 'saved');
  assert.equal((await coordinator.flush('recover-project')).ok, true);
  assert.equal(attempts, 2, 'a failure never leaves the project queue permanently rejected');
}

// Destructive invalidation closes the logical project key: queued work drains,
// while no late save can recreate a purged project afterward.
{
  let writes = 0;
  const coordinator = new SaveCoordinator(async () => {
    writes += 1;
    return { saved: true, indexUpdated: true };
  });
  coordinator.invalidate('purged-project');
  const blocked = await coordinator.enqueue('purged-project', versionDoc('Too late'));
  assert.equal(blocked.status, 'failed');
  assert.equal((await coordinator.flush('purged-project')).ok, false);
  assert.equal(writes, 0);
}

// INDEX_KEY RMW is one module-wide transaction lane. A blocked autosave index
// commit cannot roll back metadata written by update_project afterward.
{
  let stored: ProjectMeta[] = [{
    id: 'index-project', name: 'Before', description: 'Before description', updatedAt: 1,
  }];
  let releaseFirstWrite!: () => void;
  let markFirstWriteStarted!: () => void;
  const firstWriteStarted = new Promise<void>((resolve) => { markFirstWriteStarted = resolve; });
  const firstWriteGate = new Promise<void>((resolve) => { releaseFirstWrite = resolve; });
  let writes = 0;
  const coordinator = new ProjectIndexCoordinator(
    async () => stored.map((meta) => ({ ...meta })),
    async (next) => {
      writes += 1;
      if (writes === 1) {
        markFirstWriteStarted();
        await firstWriteGate;
      }
      stored = next.map((meta) => ({ ...meta }));
    },
  );
  const snapshotCommit = coordinator.mutate((index) => ({
    next: index.map((meta) => (meta.id === 'index-project' ? { ...meta, updatedAt: 20 } : meta)),
    value: undefined,
  }));
  await firstWriteStarted;
  const metadataCommit = coordinator.mutate((index) => ({
    next: index.map((meta) => (
      meta.id === 'index-project'
        ? { ...meta, name: 'After', description: 'Kept', updatedAt: 30 }
        : meta
    )),
    value: undefined,
  }));
  releaseFirstWrite();
  await Promise.all([snapshotCommit, metadataCommit]);
  assert.deepEqual(stored[0], {
    id: 'index-project', name: 'After', description: 'Kept', updatedAt: 30,
  });
}

// The reverse order also composes: a later snapshot advances updatedAt without
// restoring the stale name/description it observed before the metadata commit.
{
  let stored: ProjectMeta[] = [{
    id: 'reverse-project', name: 'Before', description: 'Before description', updatedAt: 1,
  }];
  let releaseFirstWrite!: () => void;
  let markFirstWriteStarted!: () => void;
  const firstWriteStarted = new Promise<void>((resolve) => { markFirstWriteStarted = resolve; });
  const firstWriteGate = new Promise<void>((resolve) => { releaseFirstWrite = resolve; });
  let writes = 0;
  const coordinator = new ProjectIndexCoordinator(
    async () => stored.map((meta) => ({ ...meta })),
    async (next) => {
      writes += 1;
      if (writes === 1) {
        markFirstWriteStarted();
        await firstWriteGate;
      }
      stored = next.map((meta) => ({ ...meta }));
    },
  );
  const metadataCommit = coordinator.mutate((index) => ({
    next: index.map((meta) => (
      meta.id === 'reverse-project'
        ? { ...meta, name: 'After', description: 'Kept', updatedAt: 20 }
        : meta
    )),
    value: undefined,
  }));
  await firstWriteStarted;
  const snapshotCommit = coordinator.mutate((index) => ({
    next: index.map((meta) => (meta.id === 'reverse-project' ? { ...meta, updatedAt: 30 } : meta)),
    value: undefined,
  }));
  releaseFirstWrite();
  await Promise.all([metadataCommit, snapshotCommit]);
  assert.deepEqual(stored[0], {
    id: 'reverse-project', name: 'After', description: 'Kept', updatedAt: 30,
  });
}

// A rejected INDEX_KEY write is returned to its caller but never poisons the
// lane; the following mutation re-reads storage and commits normally.
{
  let stored: ProjectMeta[] = [{ id: 'recover-index', name: 'Before', updatedAt: 1 }];
  let failNextWrite = true;
  const coordinator = new ProjectIndexCoordinator(
    async () => stored.map((meta) => ({ ...meta })),
    async (next) => {
      if (failNextWrite) {
        failNextWrite = false;
        throw new Error('simulated index failure');
      }
      stored = next.map((meta) => ({ ...meta }));
    },
  );
  await assert.rejects(coordinator.mutate((index) => ({
    next: index.map((meta) => ({ ...meta, name: 'Lost' })),
    value: undefined,
  })), /simulated index failure/);
  await coordinator.mutate((index) => ({
    next: index.map((meta) => ({ ...meta, name: 'Recovered', updatedAt: 2 })),
    value: undefined,
  }));
  assert.equal(stored[0]?.name, 'Recovered');
}

// Public create/rename/delete/meta entry points share the same lane rather than
// maintaining private read-write sequences.
{
  const [first, second] = await Promise.all([
    createProject('Index first', emptyDoc),
    createProject('Index second', emptyDoc),
  ]);
  await Promise.all([
    renameProject(first.id, 'Renamed before delete'),
    deleteProject(first.id),
    updateProjectMeta(second.id, { description: 'Preserved metadata' }),
  ]);
  const indexed = await listProjects({ includeDeleted: true });
  const deleted = indexed.find((meta) => meta.id === first.id);
  const described = indexed.find((meta) => meta.id === second.id);
  assert.equal(deleted?.name, 'Renamed before delete');
  assert.equal(typeof deleted?.deletedAt, 'number');
  assert.equal(described?.description, 'Preserved metadata');
}

console.log('projectStore.verify: ok');
