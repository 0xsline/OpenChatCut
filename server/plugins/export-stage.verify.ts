import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanupStaleExportStages } from './export-stage.ts';
import { serverPlugins } from './index.ts';

const pluginNames = serverPlugins().map((plugin) => plugin.name);
const stageIndex = pluginNames.indexOf('openchatcut-export-stage');
const exportIndex = pluginNames.indexOf('openchatcut-export');
assert.ok(stageIndex >= 0 && exportIndex >= 0 && stageIndex < exportIndex, 'stage route must precede /export catch-all');

const directory = await mkdtemp(join(tmpdir(), 'openchatcut-export-stage-cleanup-'));
try {
  const now = Date.now();
  const staleStage = 'openchatcut-export-stage-00000000-0000-4000-8000-000000000001.mp4';
  const stalePartial = 'openchatcut-export-stage-00000000-0000-4000-8000-000000000002.webm.part';
  const freshStage = 'openchatcut-export-stage-00000000-0000-4000-8000-000000000003.webm';
  const prefixedUserFile = 'openchatcut-export-stage-project.mp4';
  await Promise.all([
    writeFile(join(directory, staleStage), 'stale'),
    writeFile(join(directory, stalePartial), 'partial'),
    writeFile(join(directory, freshStage), 'fresh'),
    writeFile(join(directory, prefixedUserFile), 'user'),
  ]);
  const staleDate = new Date(now - 60 * 60_000);
  await Promise.all([
    utimes(join(directory, staleStage), staleDate, staleDate),
    utimes(join(directory, stalePartial), staleDate, staleDate),
    utimes(join(directory, prefixedUserFile), staleDate, staleDate),
  ]);

  const removed = await cleanupStaleExportStages(directory, { now, retentionMs: 30 * 60_000 });
  assert.equal(removed, 2);
  assert.equal(existsSync(join(directory, staleStage)), false);
  assert.equal(existsSync(join(directory, stalePartial)), false);
  assert.equal(existsSync(join(directory, freshStage)), true);
  assert.equal(existsSync(join(directory, prefixedUserFile)), true, 'non-UUID user file must be retained');
} finally {
  await rm(directory, { recursive: true, force: true });
}

console.log('export stage verification passed');
