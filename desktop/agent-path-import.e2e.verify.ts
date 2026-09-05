import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, stat, realpath, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { seedKeystore } from '../server/keystore.ts';
import { resolveUploadFile } from '../server/media-dir.ts';
import { mediaReferenceManifestPath } from '../server/media-references.ts';
import { importAgentPaths, pathAllowedByRoots } from './agent-path-import.ts';
import { canonicalCurrentUploadDirectory } from './directory-watch-import.ts';

// End-to-end main-process import for issue #84 Feature B: a real file inside
// the whitelist lands in the media pool as a reference with fingerprinting; outside
// paths and duplicates are handled without error. CI-safe (no GUI): the
// desktop main process is plain Node file logic.

/** A valid 16-bit mono PCM wav (1s silence) so the probe reports a
 *  duration; CI checkouts have no runtime uploads to copy from. */
function silentWavBytes(seconds = 1): Uint8Array {
  const sampleRate = 16_000;
  const samples = sampleRate * seconds;
  const dataSize = samples * 2;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);
  return new Uint8Array(buffer);
}

const workRoot = await mkdtemp(join(tmpdir(), 'occ84-e2e-'));
await mkdir(join(workRoot, '素材盘'), { recursive: true });
const importRoot = await realpath(join(workRoot, '素材盘'));
const sourceName = '访谈素材.wav';
const sourcePath = join(importRoot, sourceName);
await writeFile(sourcePath, silentWavBytes());
await writeFile(join(importRoot, '剪辑说明.md'), '# 文稿');

const uploadDir = await canonicalCurrentUploadDirectory();
const cleanup = new Set<string>();
try {
  // Local paths are available without a folder grant by default.
  seedKeystore({ AGENT_IMPORT_ROOTS: '' });
  const unconfigured = await importAgentPaths({
    paths: [sourcePath],
    projectId: 'verify-project',
    knownHashes: [],
  });
  assert.equal(unconfigured.errors.length, 0);
  assert.equal(unconfigured.imported.length, 1, 'default access imports without a folder picker');
  for (const file of unconfigured.imported) cleanup.add(mediaReferenceManifestPath(uploadDir, file.storedName));

  seedKeystore({ AGENT_IMPORT_ROOTS: importRoot });

  // ── Whitelisted file imports end-to-end ──
  const first = await importAgentPaths({
    paths: [sourcePath],
    projectId: 'verify-project',
    knownHashes: [],
  });
  assert.equal(first.errors.length, 0, `no errors: ${JSON.stringify(first.errors)}`);
  assert.equal(first.imported.length, 1, 'exactly one file imported');
  const imported = first.imported[0]!;
  assert.equal(imported.name, sourceName, 'UTF-8 name preserved');
  assert.equal(imported.kind, 'audio', 'wav lands as audio');
  assert.match(imported.contentHash, /^[0-9a-f]{64}$/, 'SHA-256 fingerprint present');
  assert.ok(imported.src.startsWith('/media/uploads/'), `published src (${imported.src})`);
  const storedPath = join(uploadDir, imported.storedName);
  cleanup.add(mediaReferenceManifestPath(uploadDir, imported.storedName));
  await assert.rejects(stat(storedPath), { code: 'ENOENT' }, 'Agent import must not copy media bytes');
  assert.equal(resolveUploadFile(imported.storedName), sourcePath, 'the pool URL resolves to the source');
  assert.ok(imported.durationSeconds != null && imported.durationSeconds > 0, 'probe reports a duration');

  if (process.platform !== 'win32') {
    const rootAlias = join(workRoot, '素材盘-link');
    await symlink(importRoot, rootAlias, 'dir');
    seedKeystore({ AGENT_IMPORT_ROOTS: rootAlias });
    const throughAlias = await importAgentPaths({
      paths: [join(rootAlias, sourceName)],
      projectId: 'verify-project',
      knownHashes: [imported.contentHash],
    });
    assert.equal(throughAlias.errors.length, 0, 'symlinked roots resolve before containment checks');
    assert.equal(throughAlias.duplicateCount, 1, 'symlinked /tmp-style paths reach the importer');
    seedKeystore({ AGENT_IMPORT_ROOTS: importRoot });
  }

  // ── Duplicate (same content hash) is skipped silently ──
  const duplicate = await importAgentPaths({
    paths: [sourcePath],
    projectId: 'verify-project',
    knownHashes: [imported.contentHash],
  });
  assert.equal(duplicate.imported.length, 0, 'duplicate is not re-imported');
  assert.equal(duplicate.errors.length, 0, 'duplicate is not an error');
  assert.equal(duplicate.duplicateCount, 1, 'duplicate count is explicit');

  const batch = await importAgentPaths({ paths: [sourcePath, sourcePath], projectId: 'verify-project', knownHashes: [] });
  assert.equal(batch.imported.length, 1, 'same-batch duplicate content lands once');
  assert.equal(batch.duplicateCount, 1);
  for (const file of batch.imported) cleanup.add(mediaReferenceManifestPath(uploadDir, file.storedName));

  // ── Unsupported documents are reported instead of looking like duplicates ──
  const folder = await importAgentPaths({
    paths: [importRoot],
    projectId: 'verify-project',
    knownHashes: [imported.contentHash],
  });
  assert.deepEqual(folder.unsupportedFiles, ['剪辑说明.md'], 'unsupported document name is reported');

  // ── Path outside the roots is rejected with a clear error ──
  const outside = join(workRoot, 'outside.wav');
  await writeFile(outside, silentWavBytes());
  const rejected = await importAgentPaths({
    paths: [outside],
    projectId: 'verify-project',
    knownHashes: [],
  });
  assert.equal(rejected.imported.length, 0, 'outside path imports nothing');
  assert.equal(rejected.errors[0]?.code, 'PATH_OUTSIDE_IMPORT_ROOTS');
  assert.match(rejected.errors[0]?.error ?? '', /已添加的目录/, 'outside path explains the configured roots');
  assert.equal(pathAllowedByRoots([importRoot], outside), false, 'containment check agrees');

  console.log('agent-path-import.e2e.verify: whitelisted import, dedupe, and rejection passed');
} finally {
  for (const path of cleanup) {
    await rm(path, { force: true }).catch(() => undefined);
  }
  await rm(workRoot, { recursive: true, force: true }).catch(() => undefined);
  seedKeystore({ AGENT_IMPORT_ROOTS: '' });
}
