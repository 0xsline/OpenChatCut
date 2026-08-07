import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CURRENT_PROJECT_VERSION } from '../../shared/project-version.ts';
import {
  checkpointExternalEditSession,
  createExternalEditSession,
} from '../../src/agent/external-edit-session.ts';
import type { ProjectDoc } from '../../src/editor/types.ts';

function projectDoc(width = 1920, height = 1080): ProjectDoc {
  return {
    version: CURRENT_PROJECT_VERSION,
    assets: [],
    mediaFolders: [],
    activeTimelineId: 'timeline-1',
    timelines: [{
      id: 'timeline-1',
      name: 'Timeline 1',
      order: 0,
      fps: 30,
      width,
      height,
      items: [],
      selectedId: null,
      trackOrder: ['track-v1'],
      tracks: { 'track-v1': { kind: 'video' } },
    }],
  };
}

function entryArray(value: unknown): unknown[] {
  assert(Array.isArray(value));
  return value;
}

const root = await mkdtemp(join(tmpdir(), 'occ-offline-store-'));
const previousHome = process.env.HOME;
process.env.HOME = root;

// Store paths are captured at module evaluation, so known modules load only
// after HOME points at an isolated directory.

try {
  const { getStoredEntry, setStoredEntry } = await import('../plugins/project-store.ts');
  const {
    commitOfflineStoredProject,
    deleteOfflineEditCheckpoint,
    loadOfflineEditCheckpoint,
    loadOfflineStoredProject,
    saveOfflineEditCheckpoint,
  } = await import('./offline-project-store.ts');
  const projectId = 'stored-project';
  const base = projectDoc();
  await setStoredEntry(`project:${projectId}`, base);
  await setStoredEntry('projects', [{ id: projectId, name: 'Stored project', updatedAt: 10 }]);
  await setStoredEntry(`versions:${projectId}`, [{
    id: 'manual-version',
    name: 'Manual',
    createdAt: 1,
    automatic: false,
    doc: projectDoc(640, 360),
  }]);

  const snapshot = await loadOfflineStoredProject(projectId);
  assert(snapshot);
  const draftSession = createExternalEditSession(snapshot.doc, 'checkpoint test', 'auto');
  const checkpoint = checkpointExternalEditSession(draftSession);
  assert.equal(await saveOfflineEditCheckpoint({
    projectId,
    expectedRevision: snapshot.revision,
    checkpoint,
    canSave: () => true,
  }), 'saved');
  assert.deepEqual(
    await loadOfflineEditCheckpoint(projectId, snapshot.revision),
    checkpoint,
  );
  await deleteOfflineEditCheckpoint(projectId, checkpoint.sessionId);
  assert.equal(await loadOfflineEditCheckpoint(projectId, snapshot.revision), null);
  const committed = await commitOfflineStoredProject({
    projectId,
    expectedRevision: snapshot.revision,
    doc: projectDoc(1080, 1920),
    canCommit: () => true,
  });
  assert.equal(committed.status, 'applied');
  const saved = await getStoredEntry(`project:${projectId}`);
  assert.deepEqual(saved.value, projectDoc(1080, 1920));
  const versions = entryArray((await getStoredEntry(`versions:${projectId}`)).value);
  assert.equal(versions.length, 2);
  assert(versions[0] && typeof versions[0] === 'object' && 'automatic' in versions[0]);
  assert.equal(versions[0].automatic, true);
  assert(versions[0] && typeof versions[0] === 'object' && 'doc' in versions[0]);
  assert.deepEqual(versions[0].doc, base);
  assert(versions.some((entry) => entry !== null && typeof entry === 'object' && 'id' in entry && entry.id === 'manual-version'));
  const projects = entryArray((await getStoredEntry('projects')).value);
  const meta = projects.find((entry) => entry !== null && typeof entry === 'object' && 'id' in entry && entry.id === projectId);
  assert(meta && typeof meta === 'object' && 'updatedAt' in meta && typeof meta.updatedAt === 'number');
  assert(meta.updatedAt > 10);

  const concurrent = projectDoc(1280, 720);
  await setStoredEntry(`project:${projectId}`, concurrent);
  const beforeStaleVersions = (await getStoredEntry(`versions:${projectId}`)).value;
  const stale = await commitOfflineStoredProject({
    projectId,
    expectedRevision: snapshot.revision,
    doc: projectDoc(720, 1280),
    canCommit: () => true,
  });
  assert.equal(stale.status, 'stale');
  assert.deepEqual((await getStoredEntry(`project:${projectId}`)).value, concurrent);
  assert.deepEqual((await getStoredEntry(`versions:${projectId}`)).value, beforeStaleVersions);

  await setStoredEntry(`project:${projectId}`, base);
  const automatic = {
    id: 'automatic-base',
    name: 'Automatic',
    createdAt: 100,
    automatic: true,
    doc: base,
  };
  const manual = {
    id: 'manual-preserved',
    name: 'Manual',
    createdAt: 50,
    automatic: false,
    doc: projectDoc(640, 360),
  };
  await setStoredEntry(`versions:${projectId}`, [automatic, manual]);
  const dedupeSnapshot = await loadOfflineStoredProject(projectId);
  assert(dedupeSnapshot);
  const deduped = await commitOfflineStoredProject({
    projectId,
    expectedRevision: dedupeSnapshot.revision,
    doc: projectDoc(1080, 1920),
    canCommit: () => true,
  });
  assert.equal(deduped.status, 'applied');
  assert.equal(deduped.automaticVersionCreated, false);
  assert.deepEqual((await getStoredEntry(`versions:${projectId}`)).value, [automatic, manual]);

  await setStoredEntry(`project:${projectId}`, base);
  const rollbackSnapshot = await loadOfflineStoredProject(projectId);
  assert(rollbackSnapshot);
  const beforeRollbackProjects = (await getStoredEntry('projects')).value;
  const beforeRollbackVersions = (await getStoredEntry(`versions:${projectId}`)).value;
  let guardChecks = 0;
  const takeover = await commitOfflineStoredProject({
    projectId,
    expectedRevision: rollbackSnapshot.revision,
    doc: projectDoc(1080, 1920),
    canCommit: () => {
      guardChecks += 1;
      return guardChecks < 4;
    },
  });
  assert.equal(takeover.status, 'browser-takeover');
  assert.deepEqual((await getStoredEntry(`project:${projectId}`)).value, base);
  assert.deepEqual((await getStoredEntry('projects')).value, beforeRollbackProjects);
  assert.deepEqual((await getStoredEntry(`versions:${projectId}`)).value, beforeRollbackVersions);
} finally {
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  await rm(root, { recursive: true, force: true });
}

console.log('offline-project-store.verify: ok');
