import assert from 'node:assert/strict';
import { loadInitialProjects, type ProjectStartupSource } from './appShell';
import type { ProjectMeta } from '../persist/projectStoreCoordinators';

const demo = { id: 'demo', name: '示例工程', updatedAt: 1 };

function source(options: {
  projects?: ProjectMeta[];
  hasHistory?: boolean;
  canSeedDemo: boolean;
  onCreate?: () => void;
}): ProjectStartupSource {
  return {
    list: async () => options.projects ?? [],
    hasHistory: async () => options.hasHistory ?? false,
    canSeedDemo: () => options.canSeedDemo,
    createDemo: async () => {
      options.onCreate?.();
      return demo;
    },
  };
}

let readOnlyCreates = 0;
const readOnlyProjects = await loadInitialProjects(source({
  canSeedDemo: false,
  onCreate: () => { readOnlyCreates += 1; },
}));
assert.deepEqual(readOnlyProjects, [], 'sessionless empty remote listing resolves to an empty terminal state');
assert.equal(readOnlyCreates, 0, 'read-only startup never attempts the rejected demo write');

for (const mode of ['authorized remote', 'local/offline']) {
  let creates = 0;
  const projects = await loadInitialProjects(source({
    canSeedDemo: true,
    onCreate: () => { creates += 1; },
  }));
  assert.deepEqual(projects, [demo], `${mode} first-run still seeds the demo`);
  assert.equal(creates, 1, `${mode} first-run creates exactly one demo`);
}

let historyCreates = 0;
assert.deepEqual(
  await loadInitialProjects(source({
    hasHistory: true,
    canSeedDemo: true,
    onCreate: () => { historyCreates += 1; },
  })),
  [],
  'an intentionally emptied project history stays empty',
);
assert.equal(historyCreates, 0, 'project history still suppresses demo recreation');

const existing = [{ id: 'existing', name: 'Existing', updatedAt: 2 }];
assert.deepEqual(
  await loadInitialProjects(source({ projects: existing, canSeedDemo: false })),
  existing,
  'existing projects remain readable without write authority',
);

console.log('appShell.verify: project startup authority semantics passed');
