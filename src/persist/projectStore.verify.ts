import assert from 'node:assert/strict';
import type { ProjectDoc } from '../editor/types';
import {
  createProject,
  hasProjectHistory,
  listProjects,
  purgeProject,
  resetProjectStoreMemory,
} from './projectStore';

const emptyDoc: ProjectDoc = {
  version: 2,
  assets: [],
  mediaFolders: [],
  timelines: [],
  activeTimelineId: '',
};

resetProjectStoreMemory();
assert.equal(await hasProjectHistory(), false, 'brand-new store has no project history');

const project = await createProject('仅有工程', emptyDoc);
assert.equal(await hasProjectHistory(), true, 'creating a project initializes the store');

await purgeProject(project.id);
assert.deepEqual(await listProjects(), [], 'the final project is permanently deleted');
assert.equal(await hasProjectHistory(), true, 'deleting the final project must not recreate the demo');

console.log('projectStore.verify: ok');
