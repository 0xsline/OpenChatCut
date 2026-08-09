// Run: npx tsx server/plugins/project-store-project-document.verify.ts
import assert from 'node:assert/strict';
import { CURRENT_PROJECT_VERSION } from '../../shared/project-version.ts';
import { revisionOf } from '../../src/agent/external-edit-session.ts';
import { INITIAL } from '../../src/editor/initial.ts';
import type { ProjectDoc } from '../../src/editor/types.ts';
import { docFromTimeline } from '../../src/persist/projectStore.ts';
import {
  projectEditOwnershipKey,
  renewedProjectEditOwnership,
  type ProjectEditOwnershipClaim,
} from '../external-agent/project-edit-ownership-codec.ts';
import { createProjectDocumentStoreOperation } from './project-store-project-document.ts';
import type { LockedProjectStore } from './project-store.ts';

function projectDoc(width: number): ProjectDoc {
  return docFromTimeline({ ...INITIAL, width, height: 1080, items: [] });
}

const projectId = 'project-doc-cas';
const projectKey = `project:${projectId}`;
const original = projectDoc(1920);
const originalRevision = revisionOf(original);
const claim: ProjectEditOwnershipClaim = {
  projectId,
  ownerKind: 'browser',
  ownerId: 'browser-owner',
  epoch: 4,
  baseRevision: originalRevision,
};
const entries = new Map<string, unknown>([
  [projectKey, original],
  [projectEditOwnershipKey(projectId), renewedProjectEditOwnership(claim, originalRevision)],
]);
const store: LockedProjectStore = {
  readEntry: async (key) => entries.has(key)
    ? { found: true, value: entries.get(key) }
    : { found: false },
  writeEntry: async (key, value) => { entries.set(key, value); },
  writeEntryExact: async (key, value) => { entries.set(key, value); },
  removeEntry: async (key) => { entries.delete(key); },
};
const compareAndSwap = createProjectDocumentStoreOperation(async (work) => work(store));
const updated = projectDoc(1280);
const applied = await compareAndSwap({
  operation: 'project-document-cas',
  key: projectKey,
  expectedRevision: originalRevision,
  ownerId: claim.ownerId,
  ownershipEpoch: claim.epoch,
  value: updated,
});
assert.equal(applied.accepted, true);
assert.equal(applied.currentRevision, revisionOf(updated));
assert.equal(applied.ownershipEpoch, claim.epoch);

const stale = await compareAndSwap({
  operation: 'project-document-cas',
  key: projectKey,
  expectedRevision: originalRevision,
  ownerId: claim.ownerId,
  ownershipEpoch: claim.epoch,
  value: projectDoc(720),
});
assert.equal(stale.accepted, false);
assert.deepEqual(entries.get(projectKey), updated, 'a stale browser cannot replace a committed document');

const future = { version: CURRENT_PROJECT_VERSION + 100, sentinel: 'preserve-raw' };
entries.set(projectKey, future);
await assert.rejects(
  compareAndSwap({
    operation: 'project-document-cas',
    key: projectKey,
    expectedRevision: revisionOf(updated),
    ownerId: claim.ownerId,
    ownershipEpoch: claim.epoch,
    value: projectDoc(640),
  }),
  /corrupt or unsupported/,
);
assert.equal(entries.get(projectKey), future, 'unsupported future ProjectDoc bytes remain unchanged');

console.log('project-store-project-document.verify.ts: ok');
