import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  persistExportDirectory,
  resolvePersistedExportDestination,
  restorePersistedExportDirectory,
  validDesktopExportFilename,
} from './export-directory-state.ts';

const root = await mkdtemp(join(tmpdir(), 'openchatcut-export-state-'));
try {
  const statePath = join(root, 'export-destination.json');
  const resolvedRoot = await realpath(root);
  const firstId = 'a'.repeat(32);
  const secondId = 'b'.repeat(32);
  await persistExportDirectory(statePath, root, firstId);
  assert.equal((await restorePersistedExportDirectory(statePath))?.directory, resolvedRoot);
  await persistExportDirectory(statePath, root, secondId);
  assert.equal(await resolvePersistedExportDestination(statePath, firstId), resolvedRoot);
  assert.equal(validDesktopExportFilename('video.mp4'), true);
  assert.equal(validDesktopExportFilename('../video.mp4'), false);
  await assert.rejects(persistExportDirectory(statePath, root, 'short'), /identity/);
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log('export-directory-state.verify: persistence and validation OK');
