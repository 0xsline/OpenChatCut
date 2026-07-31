import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const originalCwd = process.cwd();
const root = await mkdtemp(join(tmpdir(), 'openchatcut-music-media-'));

try {
  process.chdir(root);
  // Load after chdir so the module-level default media directory is isolated to this test process.
  const { saveAudioResponse } = await import('./music-media.ts');
  const uploads = join(root, 'public', 'media', 'uploads');

  await assert.rejects(
    saveAudioResponse(new Response(Uint8Array.of(1, 2, 3, 4)), 'flac'),
    /unable to probe generated music/,
  );
  assert.deepEqual(await readdir(uploads), [], 'failed media validation must remove its partial file');

  const saved = await saveAudioResponse(new Response(Uint8Array.of(1, 2, 3, 4)), 'pcm', 2);
  assert.equal(saved.durationSeconds, 1);
  const files = await readdir(uploads);
  assert.equal(files.length, 1);
  assert.equal(files[0]?.startsWith('.'), false, 'successful media must be atomically published without a partial name');
  assert.deepEqual(await readFile(join(uploads, files[0]!)), Buffer.from([1, 2, 3, 4]));
} finally {
  process.chdir(originalCwd);
  await rm(root, { recursive: true, force: true });
}

console.log('music media atomic publication verification passed');
