import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import './project-store-merge.verify';
import {
  atomicWriteFile,
  createOwnerSafeLeaseLock,
  type AtomicWriteOperations,
} from './project-store-durable';


const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function verifyLongOwnershipCannotBeStolen(root: string): Promise<void> {
  const path = join(root, 'long.lock');
  const options = {
    path,
    leaseMs: 50,
    heartbeatMs: 10,
    retries: 6,
    retryMs: 5,
    isPidAlive: () => true,
  };
  const owner = await createOwnerSafeLeaseLock(options).acquire();
  await sleep(120);
  await assert.rejects(
    createOwnerSafeLeaseLock(options).acquire(),
    /busy/,
    'a heartbeat must keep ownership beyond the stale lease duration',
  );
  const record = JSON.parse(await readFile(join(path, 'owner.json'), 'utf8')) as {
    token: string;
    pid: number;
  };
  assert.equal(record.token, owner.token);
  assert.equal(record.pid, process.pid);
  await owner.release();
}

async function verifyOldReleaseCannotRemoveReplacement(root: string): Promise<void> {
  const path = join(root, 'aba.lock');
  const lock = createOwnerSafeLeaseLock({ path, leaseMs: 100, heartbeatMs: 20 });
  const oldOwner = await lock.acquire();
  const displaced = `${path}.displaced`;
  await rename(path, displaced);
  const replacement = await lock.acquire();
  await oldOwner.release();
  const record = JSON.parse(await readFile(join(path, 'owner.json'), 'utf8')) as { token: string };
  assert.equal(record.token, replacement.token, 'an old release cannot unlink a replacement lock');
  await replacement.release();
  await rm(displaced, { recursive: true, force: true });
}

async function verifyLiveExpiredOwnerIsNotReaped(root: string): Promise<void> {
  const path = join(root, 'live-expired.lock');
  await mkdir(path);
  await writeFile(join(path, 'owner.json'), JSON.stringify({
    token: 'live-owner',
    pid: process.pid,
    expiresAt: Date.now() - 1_000,
  }));
  const contender = createOwnerSafeLeaseLock({
    path,
    leaseMs: 50,
    retries: 4,
    retryMs: 5,
    isPidAlive: () => true,
  });
  await assert.rejects(contender.acquire(), /busy/, 'an expired lease cannot supersede a live owner');
  const record = JSON.parse(await readFile(join(path, 'owner.json'), 'utf8')) as { token: string };
  assert.equal(record.token, 'live-owner');
  await rm(path, { recursive: true, force: true });
}

async function verifyDeadStaleRecovery(root: string): Promise<void> {
  const path = join(root, 'dead.lock');
  await mkdir(path);
  await writeFile(join(path, 'owner.json'), JSON.stringify({
    token: 'dead-owner',
    pid: 999_999,
    expiresAt: Date.now() - 1_000,
  }));
  const recovered = await createOwnerSafeLeaseLock({
    path,
    leaseMs: 50,
    heartbeatMs: 10,
    isPidAlive: () => false,
  }).acquire();
  assert.notEqual(recovered.token, 'dead-owner');
  await recovered.release();
}

async function verifyConcurrentWritersSerialize(root: string): Promise<void> {
  const lock = createOwnerSafeLeaseLock({
    path: join(root, 'concurrent.lock'),
    leaseMs: 100,
    heartbeatMs: 20,
    retries: 300,
    retryMs: 2,
  });
  let active = 0;
  let maximumActive = 0;
  await Promise.all(Array.from({ length: 8 }, async () => {
    const owner = await lock.acquire();
    try {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await sleep(8);
      active -= 1;
    } finally {
      await owner.release();
    }
  }));
  assert.equal(maximumActive, 1, 'concurrent writers must remain serialized');
}

function recordingAtomicOperations(events: string[], failRename = false): AtomicWriteOperations {
  return {
    open: async (_path, flags) => flags === 'wx'
      ? {
          writeFile: async () => { events.push('write'); },
          sync: async () => { events.push('file-sync'); },
          close: async () => { events.push('file-close'); },
        }
      : {
          sync: async () => { events.push('directory-sync'); },
          close: async () => { events.push('directory-close'); },
        },
    rename: async () => {
      events.push('rename');
      if (failRename) throw new Error('rename failed');
    },
    rm: async (path) => { events.push(`remove:${path}`); },
  };
}

async function verifyAtomicWriteOrdering(): Promise<void> {
  const events: string[] = [];
  await atomicWriteFile('/virtual/store/entry.json', '{}', {
    operations: recordingAtomicOperations(events),
  });
  assert.ok(events.indexOf('file-sync') < events.indexOf('rename'), 'file sync must precede rename');
  assert.ok(events.indexOf('directory-sync') > events.indexOf('rename'), 'directory sync must follow rename');

  const failedEvents: string[] = [];
  await assert.rejects(atomicWriteFile('/virtual/store/failed.json', '{}', {
    operations: recordingAtomicOperations(failedEvents, true),
  }), /rename failed/);
  assert.ok(failedEvents.some((event) => event.startsWith('remove:/virtual/store/failed.json.')));
}

async function verifyCorruptEntryIsolation(root: string): Promise<void> {
  const previousHome = process.env.HOME;
  process.env.HOME = root;
  try {
    const storeDir = join(root, '.openchatcut', 'project-store-v1');
    await mkdir(storeDir, { recursive: true });
    await writeFile(join(storeDir, '.ready'), '1\n');
    await writeFile(join(storeDir, `${encodeURIComponent('project:healthy')}.json`), JSON.stringify({ healthy: true }));
    await writeFile(join(storeDir, `${encodeURIComponent('project:broken')}.json`), '{');
    // Dynamic import is intentional: project-store captures HOME at module evaluation.
    const { readStore } = await import('./project-store.ts');
    const store = await readStore();
    assert.deepEqual(store.entries['project:healthy'], { healthy: true });
    const brokenEntry = store.entries['project:broken'];
    assert(brokenEntry && typeof brokenEntry === 'object' && 'kind' in brokenEntry);
    assert.equal(
      brokenEntry.kind,
      'quarantined-project-store-entry',
      'one corrupt entry becomes an explicit marker instead of aborting the directory read',
    );
    const quarantine = await readdir(join(storeDir, '.quarantine'));
    assert.equal(quarantine.length, 1);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
}

const lockRoot = await mkdtemp(join(tmpdir(), 'openchatcut-project-store-'));
try {
  await verifyLongOwnershipCannotBeStolen(lockRoot);
  await verifyOldReleaseCannotRemoveReplacement(lockRoot);
  await verifyLiveExpiredOwnerIsNotReaped(lockRoot);
  await verifyDeadStaleRecovery(lockRoot);
  await verifyConcurrentWritersSerialize(lockRoot);
  await verifyAtomicWriteOrdering();
  await verifyCorruptEntryIsolation(lockRoot);
} finally {
  await rm(lockRoot, { recursive: true, force: true });
}

console.log('project-store.verify: ok');
