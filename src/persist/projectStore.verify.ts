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

const emptyDoc: ProjectDoc = {
  version: CURRENT_PROJECT_VERSION,
  assets: [],
  mediaFolders: [],
  timelines: [],
  activeTimelineId: '',
};

resetProjectStoreMemory();
assert.equal(await hasProjectHistory(), false, 'brand-new store has no project history');

const project = await createProject('only engineering', emptyDoc);
assert.equal(await hasProjectHistory(), true, 'creating a project initializes the store');

await purgeProject(project.id);
assert.deepEqual(await listProjects(), [], 'the final project is permanently deleted');
assert.equal(await hasProjectHistory(), true, 'deleting the final project must not recreate the demo');

console.log('projectStore.verify: ok');
