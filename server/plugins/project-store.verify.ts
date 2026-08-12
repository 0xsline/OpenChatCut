import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import './project-store-merge.verify';
import {
  atomicWriteFile,
  type AtomicWriteOperations,
} from './project-store-durable';

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
  await verifyAtomicWriteOrdering();
  await verifyCorruptEntryIsolation(lockRoot);
} finally {
  await rm(lockRoot, { recursive: true, force: true });
}

console.log('project-store.verify: ok');
