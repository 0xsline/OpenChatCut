import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  deleteMediaReference,
  listMediaReferences,
  mediaReferenceManifestPath,
  recordedMediaReferenceSource,
  registerMediaReference,
  resolveMediaReference,
} from './media-references.ts';

const root = await mkdtemp(join(tmpdir(), 'openchatcut-media-reference-'));
const source = join(root, 'source clip.mp4');
const uploads = join(root, 'uploads');
const name = 'asset-1.mp4';

try {
  await writeFile(source, 'external media bytes');
  await registerMediaReference(uploads, name, source);
  assert.equal(resolveMediaReference(uploads, name), await realpath(source));
  assert.deepEqual(
    (await listMediaReferences(uploads)).map((entry) => ({ name: entry.name, bytes: entry.bytes })),
    [{ name, bytes: 20 }],
  );
  // POSIX permission bits: Windows reports no owner-only mode.
  if (process.platform !== 'win32') {
    assert.equal((await stat(mediaReferenceManifestPath(uploads, name))).mode & 0o077, 0);
  }

  // A moved source stops resolving, but exports can still name where it was.
  const moved = join(root, 'moved clip.mp4');
  await writeFile(moved, 'moved media bytes');
  await registerMediaReference(uploads, 'asset-2.mp4', moved);
  const recorded = await realpath(moved);
  await rm(moved);
  assert.equal(resolveMediaReference(uploads, 'asset-2.mp4'), null);
  assert.equal(recordedMediaReferenceSource(uploads, 'asset-2.mp4'), recorded);
  assert.equal(recordedMediaReferenceSource(uploads, 'missing.mp4'), null);
  assert.equal(await deleteMediaReference(uploads, 'asset-2.mp4'), true);

  assert.equal(await deleteMediaReference(uploads, name), true);
  assert.equal(resolveMediaReference(uploads, name), null);
  assert.equal(await readFile(source, 'utf8'), 'external media bytes', 'deleting a reference must preserve its source');
  assert.equal(await deleteMediaReference(uploads, name), false);
} finally {
  await rm(root, { recursive: true, force: true });
}

process.stdout.write('media-references.verify: register, resolve, recorded source, list, and source-safe delete passed\n');
