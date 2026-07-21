import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CURRENT_PROJECT_VERSION } from '../../../shared/project-version';
import { loadProject, migrateProjectDoc, resetProjectStoreMemory } from '../projectStore';
import { parseProjectEnvelope, PROJECT_EXPORT_FORMAT } from '../projectTransfer';
import { kvGet, kvSet } from '../sharedKv';
import { listTemplates } from '../templateStore';
import { listVersions } from '../versionStore';
import { runProjectMigrations } from './index';

const fixture = (name: string): unknown => JSON.parse(
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'),
);

const v1 = fixture('project-v1.json');
const v2 = fixture('project-v2.json');
const v3 = fixture('project-v3.json');

{
  const sourceSnapshot = JSON.stringify(v1);
  const progress: Array<[number, number, number, number]> = [];
  const migrated = runProjectMigrations(v1, {
    onProgress: (event) => progress.push([
      event.fromVersion,
      event.toVersion,
      event.completedSteps,
      event.totalSteps,
    ]),
  });
  assert.ok(migrated);
  assert.equal(migrated.doc.version, CURRENT_PROJECT_VERSION);
  assert.deepEqual(migrated.appliedSteps, ['v1-to-v2', 'v2-to-v3']);
  assert.deepEqual(progress, [[1, 2, 1, 2], [2, 3, 2, 2]]);
  assert.deepEqual(migrated.doc.assets.map((asset) => asset.id), ['asset_video', 'asset_audio']);
  assert.equal(migrated.doc.assets[0].name, 'interview.mp4', 'project-level asset wins duplicate ids');
  assert.equal(migrated.doc.assets[0].folderId, undefined, 'missing folders are detached');
  assert.equal(migrated.doc.mediaFolders.find((folder) => folder.id === 'folder_orphan')?.parentId, undefined);
  assert.equal(migrated.doc.activeTimelineId, 'tl_fixture', 'stale active timeline falls back safely');
  assert.ok(migrated.doc.timelines.every((timeline) => !Object.hasOwn(timeline, 'assets')));
  assert.ok(migrated.doc.timelines[0].items.every((item) => item.track.startsWith('track_tl_fixture_')));
  assert.equal(JSON.stringify(v1), sourceSnapshot, 'migration steps never mutate source bytes');

  const repeated = migrateProjectDoc(migrated.doc);
  assert.deepEqual(repeated, migrated.doc, 'migrations are idempotent at the current version');
}

{
  const migrated = runProjectMigrations(v2, { onProgress: () => { throw new Error('observer failed'); } });
  assert.ok(migrated, 'progress observer failures do not invalidate migration');
}

{
  const migrated = runProjectMigrations(v2);
  assert.ok(migrated);
  assert.deepEqual(migrated.appliedSteps, ['v2-to-v3']);
  assert.equal(migrated.doc.timelines[0].items[0].track, 'track_tl_fixture_2');
}

{
  const migrated = runProjectMigrations(v3);
  assert.ok(migrated);
  assert.deepEqual(migrated.appliedSteps, []);
  assert.deepEqual(migrated.doc, v3);
}

{
  const legacyTimeline = {
    fps: 24,
    width: 1280,
    height: 720,
    selectedId: null,
    items: [],
  };
  assert.deepEqual(migrateProjectDoc(legacyTimeline), migrateProjectDoc(legacyTimeline),
    'pre-versioned single timelines migrate deterministically');
}

{
  assert.equal(migrateProjectDoc({ ...v3 as object, version: 99 }), null, 'future versions are not guessed');
  assert.equal(migrateProjectDoc({ version: 2, timelines: [], activeTimelineId: '' }), null);
}

// Portable project imports report and use the exact same migration chain.
{
  const progress: Array<[number, number]> = [];
  const parsed = parseProjectEnvelope(JSON.stringify({
    format: PROJECT_EXPORT_FORMAT,
    name: 'Legacy import',
    exportedAt: '2026-07-21T00:00:00.000Z',
    doc: v2,
    media: [],
  }), { onProgress: (event) => progress.push([event.fromVersion, event.toVersion]) });
  assert.ok('envelope' in parsed);
  if ('envelope' in parsed) assert.equal(parsed.envelope.doc.version, CURRENT_PROJECT_VERSION);
  assert.deepEqual(progress, [[2, 3]]);
}

// Cache migration is atomic: save only the completed chain; invalid bytes remain untouched.
{
  resetProjectStoreMemory();
  await kvSet('project:fixture-v1', v1);
  const progress: Array<[number, number]> = [];
  const loaded = await loadProject('fixture-v1', {
    onProgress: (event) => progress.push([event.fromVersion, event.toVersion]),
  });
  assert.equal(loaded?.version, CURRENT_PROJECT_VERSION);
  assert.deepEqual(progress, [[1, 2], [2, 3]]);
  assert.equal((await kvGet<{ version?: number }>('project:fixture-v1'))?.version, CURRENT_PROJECT_VERSION);

  const broken = { version: 2, timelines: [], activeTimelineId: '' };
  await kvSet('project:broken', broken);
  assert.equal(await loadProject('broken'), null);
  assert.deepEqual(await kvGet('project:broken'), broken, 'failed migration never overwrites source bytes');

  const brokenMidChain = {
    version: 1,
    timelines: [{ id: 'tl_broken', name: 'Broken', order: 0, fps: 30, width: 1, height: 1, items: [null] }],
    activeTimelineId: 'tl_broken',
  };
  await kvSet('project:broken-mid-chain', brokenMidChain);
  assert.equal(await loadProject('broken-mid-chain'), null);
  assert.deepEqual(await kvGet('project:broken-mid-chain'), brokenMidChain,
    'a later step failure never persists an intermediate version');
}

// Shared templates and named snapshots use the same chain and persist atomically.
{
  resetProjectStoreMemory();
  await kvSet('templates:all', [{
    id: 'template_legacy', name: 'Legacy template', createdAt: 1, doc: v1, assetIds: ['asset_video'],
  }]);
  assert.equal((await listTemplates())[0].doc.version, CURRENT_PROJECT_VERSION);
  const storedTemplates = await kvGet<Array<{ doc: { version?: number } }>>('templates:all');
  assert.equal(storedTemplates?.[0].doc.version, CURRENT_PROJECT_VERSION);

  resetProjectStoreMemory();
  const mixedLibrary = [
    { id: 'template_legacy', name: 'Legacy template', createdAt: 1, doc: v1, assetIds: [] },
    { id: 'broken', name: 'Broken template', createdAt: 2, doc: { version: 99 }, assetIds: [] },
  ];
  await kvSet('templates:all', mixedLibrary);
  assert.equal((await listTemplates()).length, 1, 'valid entries remain readable beside a corrupt entry');
  assert.deepEqual(await kvGet('templates:all'), mixedLibrary, 'partial library migration is never persisted');

  resetProjectStoreMemory();
  await kvSet('versions:project_legacy', [{ id: 'snapshot_legacy', name: 'Before', createdAt: 1, doc: v2 }]);
  assert.equal((await listVersions('project_legacy'))[0].doc.version, CURRENT_PROJECT_VERSION);
  const storedVersions = await kvGet<Array<{ doc: { version?: number } }>>('versions:project_legacy');
  assert.equal(storedVersions?.[0].doc.version, CURRENT_PROJECT_VERSION);
}

console.log('project migrations verification passed');
