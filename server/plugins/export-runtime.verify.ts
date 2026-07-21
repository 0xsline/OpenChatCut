import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import {
  cleanupStaleExportFiles,
  exportJobFilename,
  resolveMaxActiveExports,
  retimeFps,
} from './export-runtime.ts';

assert.equal(resolveMaxActiveExports(undefined), 1);
assert.equal(resolveMaxActiveExports('invalid'), 1);
assert.equal(resolveMaxActiveExports('0'), 1);
assert.equal(resolveMaxActiveExports('2'), 2);
assert.equal(resolveMaxActiveExports('99'), 4);

const exportDir = await mkdtemp(join(tmpdir(), 'openchatcut-export-cleanup-'));
try {
  const now = Date.now();
  const staleName = exportJobFilename('00000000-0000-4000-8000-000000000001', 'mp4');
  const freshName = exportJobFilename('00000000-0000-4000-8000-000000000002', 'webm');
  const unrelatedName = 'user-owned-video.mp4';
  await Promise.all([
    writeFile(join(exportDir, staleName), 'stale export'),
    writeFile(join(exportDir, freshName), 'fresh export'),
    writeFile(join(exportDir, unrelatedName), 'user media'),
  ]);
  const staleDate = new Date(now - 2 * 60 * 60_000);
  await utimes(join(exportDir, staleName), staleDate, staleDate);

  const removed = await cleanupStaleExportFiles(exportDir, { now, retentionMs: 60 * 60_000 });
  assert.equal(removed, 1);
  assert.equal(existsSync(join(exportDir, staleName)), false, 'stale temporary export should be removed');
  assert.equal(existsSync(join(exportDir, freshName)), true, 'fresh temporary export should be retained');
  assert.equal(existsSync(join(exportDir, unrelatedName)), true, 'user media must never be swept');
} finally {
  await rm(exportDir, { recursive: true, force: true });
}

const staleOutput = join(tmpdir(), `openchatcut-retime-check-${randomUUID()}.mp4`);
await writeFile(staleOutput, 'stale partial output');
await assert.rejects(
  retimeFps('/definitely/missing/openchatcut-input.mp4', staleOutput, 30, 'vp8', 4_000_000),
  /ffmpeg fps retime failed/,
);
assert.equal(existsSync(staleOutput), false, 'failed FPS conversion must remove partial output');

console.log('export runtime checks passed');
