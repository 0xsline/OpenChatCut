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
import type { BrowserOwnershipClaimResult } from './project-edit-ownership.ts';

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
  const {
    claimBrowserProjectOwnership,
    claimOfflineProjectOwnership,
    releaseProjectEditOwnership,
  } = await import('./project-edit-ownership.ts');
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

  const initialClaim = await claimOfflineProjectOwnership(projectId, 'offline-owner-1');
  assert.equal(initialClaim.status, 'claimed');
  if (initialClaim.status !== 'claimed') throw new Error('offline ownership claim failed');
  let ownership = initialClaim.claim;
  const snapshot = await loadOfflineStoredProject(projectId);
  assert(snapshot);
  const draftSession = createExternalEditSession(snapshot.doc, 'checkpoint test', 'auto');
  const checkpoint = checkpointExternalEditSession(draftSession);
  assert.equal(await saveOfflineEditCheckpoint({
    projectId,
    expectedRevision: snapshot.revision,
    checkpoint,
    ownership,
    canSave: () => true,
  }), 'saved');
  assert.deepEqual(
    await loadOfflineEditCheckpoint(projectId, snapshot.revision),
    checkpoint,
  );
  await deleteOfflineEditCheckpoint(projectId, checkpoint.sessionId, ownership);
  assert.equal(await loadOfflineEditCheckpoint(projectId, snapshot.revision), null);
  const futureCheckpoint = {
    version: 2,
    projectId,
    opaqueFutureState: { mustSurvive: true },
  };
  await setStoredEntry(`offline-edit-session:${projectId}`, futureCheckpoint);
  await assert.rejects(
    loadOfflineEditCheckpoint(projectId, snapshot.revision),
    /version 2 is not supported/,
  );
  await assert.rejects(
    saveOfflineEditCheckpoint({
      projectId,
      expectedRevision: snapshot.revision,
      checkpoint,
      ownership,
      canSave: () => true,
    }),
    /version 2 is not supported/,
  );
  await assert.rejects(
    deleteOfflineEditCheckpoint(projectId, checkpoint.sessionId, ownership),
    /corrupt or unsupported/,
  );
  assert.deepEqual(
    (await getStoredEntry(`offline-edit-session:${projectId}`)).value,
    futureCheckpoint,
    'an old offline client cannot downgrade a future checkpoint',
  );
  const committed = await commitOfflineStoredProject({
    projectId,
    expectedRevision: snapshot.revision,
    doc: projectDoc(1080, 1920),
    ownership,
    canCommit: () => true,
  });
  assert.equal(committed.status, 'applied');
  assert(committed.ownership);
  ownership = committed.ownership;
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
    ownership,
    canCommit: () => true,
  });
  assert.equal(stale.status, 'stale');
  assert.deepEqual((await getStoredEntry(`project:${projectId}`)).value, concurrent);
  assert.deepEqual((await getStoredEntry(`versions:${projectId}`)).value, beforeStaleVersions);

  await releaseProjectEditOwnership(ownership);
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
  const dedupeClaim = await claimOfflineProjectOwnership(projectId, 'offline-owner-2');
  assert.equal(dedupeClaim.status, 'claimed');
  if (dedupeClaim.status !== 'claimed') throw new Error('dedupe ownership claim failed');
  ownership = dedupeClaim.claim;
  const dedupeSnapshot = await loadOfflineStoredProject(projectId);
  assert(dedupeSnapshot);
  const deduped = await commitOfflineStoredProject({
    projectId,
    expectedRevision: dedupeSnapshot.revision,
    doc: projectDoc(1080, 1920),
    ownership,
    canCommit: () => true,
  });
  assert.equal(deduped.status, 'applied');
  assert(deduped.ownership);
  ownership = deduped.ownership;
  assert.equal(deduped.automaticVersionCreated, false);
  assert.deepEqual((await getStoredEntry(`versions:${projectId}`)).value, [automatic, manual]);

  await releaseProjectEditOwnership(ownership);
  await setStoredEntry(`project:${projectId}`, base);
  const rollbackSnapshot = await loadOfflineStoredProject(projectId);
  assert(rollbackSnapshot);
  const beforeRollbackProjects = (await getStoredEntry('projects')).value;
  const beforeRollbackVersions = (await getStoredEntry(`versions:${projectId}`)).value;
  const rollbackClaim = await claimOfflineProjectOwnership(projectId, 'offline-owner-3');
  assert.equal(rollbackClaim.status, 'claimed');
  if (rollbackClaim.status !== 'claimed') throw new Error('rollback ownership claim failed');
  ownership = rollbackClaim.claim;
  let guardChecks = 0;
  const takeover = await commitOfflineStoredProject({
    projectId,
    expectedRevision: rollbackSnapshot.revision,
    doc: projectDoc(1080, 1920),
    ownership,
    canCommit: () => {
      guardChecks += 1;
      return guardChecks < 4;
    },
  });
  assert.equal(takeover.status, 'browser-takeover');
  assert.deepEqual((await getStoredEntry(`project:${projectId}`)).value, base);
  assert.deepEqual((await getStoredEntry('projects')).value, beforeRollbackProjects);
  assert.deepEqual((await getStoredEntry(`versions:${projectId}`)).value, beforeRollbackVersions);

  await releaseProjectEditOwnership(ownership);
  await setStoredEntry(`project:${projectId}`, base);
  const raceClaim = await claimOfflineProjectOwnership(projectId, 'offline-race-owner');
  assert.equal(raceClaim.status, 'claimed');
  if (raceClaim.status !== 'claimed') throw new Error('race ownership claim failed');
  let browserClaim: Promise<BrowserOwnershipClaimResult> | undefined;
  const serializedCommit = await commitOfflineStoredProject({
    projectId,
    expectedRevision: raceClaim.revision,
    doc: projectDoc(1000, 1000),
    ownership: raceClaim.claim,
    canCommit: () => {
      browserClaim ??= claimBrowserProjectOwnership(
        projectId,
        'browser-race-owner',
        raceClaim.revision,
      );
      return true;
    },
  });
  assert.equal(serializedCommit.status, 'applied');
  assert.equal((await browserClaim)?.status, 'stale',
    'browser registration queued behind an offline commit must reload the committed revision');
  assert(serializedCommit.ownership);
  await releaseProjectEditOwnership(serializedCommit.ownership);

  const browserTakeover = await claimBrowserProjectOwnership(
    projectId,
    'browser-takeover-owner',
    serializedCommit.revision!,
  );
  assert.equal(browserTakeover.status, 'claimed');
  // A browser window re-claiming its OWN project (same ownerId, same revision)
  // recovers (claimed) even without a capability, because the route-level
  // capability check (broker capabilityMatches) already rejects forged/mismatched
  // renewals before this claim runs. Blocking same-owner recovery produced a
  // spurious 409 that flashed "close the other window" when the bridge
  // tear-down/reconnect path re-registered the same editor without its in-memory
  // capability.
  const reconnect = await claimBrowserProjectOwnership(
    projectId,
    'browser-takeover-owner',
    serializedCommit.revision!,
  );
  assert.equal(reconnect.status, 'claimed',
    'a same-window reconnect must recover its own persisted ownership');
  const renewed = await claimBrowserProjectOwnership(
    projectId,
    'browser-takeover-owner',
    serializedCommit.revision!,
    true,
  );
  assert.equal(renewed.status, 'claimed',
    'the live renderer can renew its persisted ownership');
  const fencedCommit = await commitOfflineStoredProject({
    projectId,
    expectedRevision: serializedCommit.revision!,
    doc: projectDoc(720, 720),
    ownership: serializedCommit.ownership,
    canCommit: () => true,
  });
  assert.equal(fencedCommit.status, 'browser-takeover');
  assert.deepEqual((await getStoredEntry(`project:${projectId}`)).value, projectDoc(1000, 1000),
    'browser ownership claimed first fences the stale offline writer');
} finally {
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  await rm(root, { recursive: true, force: true });
}

console.log('offline-project-store.verify: ok');
