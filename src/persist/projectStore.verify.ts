import assert from 'node:assert/strict';
import type { ProjectDoc } from '../editor/types';
import { CURRENT_PROJECT_VERSION } from '../../shared/project-version';
import {
  createProject,
  hasProjectHistory,
  listProjects,
  purgeProject,
  resetProjectStoreMemory,
} from './projectStore';
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

const clearedScopes: string[] = [];
await purgeProject(project.id, { semanticCleanup: async (scopeId) => { clearedScopes.push(scopeId); } });
assert.deepEqual(clearedScopes, [project.id], 'permanent purge clears semantic vectors for the project scope');
assert.deepEqual(await listProjects(), [], 'the final project is permanently deleted');
assert.equal(await hasProjectHistory(), true, 'deleting the final project must not recreate the demo');

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

console.log('projectStore.verify: ok');
