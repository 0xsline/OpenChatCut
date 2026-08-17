import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, stat, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { seedKeystore } from '../server/keystore.ts';
import { importAgentPaths, pathAllowedByRoots } from './agent-path-import.ts';
import { canonicalCurrentUploadDirectory } from './directory-watch-import.ts';

// End-to-end main-process import for issue #84 Feature B: a real file inside
// the whitelist lands in the upload directory with fingerprinting; outside
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

const uploadDir = await canonicalCurrentUploadDirectory();
const cleanup = new Set<string>();
try {
  // ── Unconfigured roots fail loudly (checked first: seeding never clears) ──
  const unconfigured = await importAgentPaths({
    paths: [sourcePath],
    projectId: 'verify-project',
    knownHashes: [],
  });
  assert.match(unconfigured.errors[0]?.error ?? '', /AGENT_IMPORT_ROOTS is not configured/, 'unconfigured roots explain themselves');

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
  cleanup.add(storedPath);
  assert.equal((await stat(storedPath)).isFile(), true, 'copy landed in the upload directory');
  assert.ok(imported.durationSeconds != null && imported.durationSeconds > 0, 'probe reports a duration');

  // ── Duplicate (same content hash) is skipped silently ──
  const duplicate = await importAgentPaths({
    paths: [sourcePath],
    projectId: 'verify-project',
    knownHashes: [imported.contentHash],
  });
  assert.equal(duplicate.imported.length, 0, 'duplicate is not re-imported');
  assert.equal(duplicate.errors.length, 0, 'duplicate is not an error');

  // ── Path outside the roots is rejected with a clear error ──
  const outside = join(workRoot, 'outside.wav');
  await writeFile(outside, silentWavBytes());
  const rejected = await importAgentPaths({
    paths: [outside],
    projectId: 'verify-project',
    knownHashes: [],
  });
  assert.equal(rejected.imported.length, 0, 'outside path imports nothing');
  assert.match(rejected.errors[0]?.error ?? '', /outside the configured import roots/, 'outside path explains the whitelist');
  assert.equal(pathAllowedByRoots([importRoot], outside), false, 'containment check agrees');

  console.log('agent-path-import.e2e.verify: whitelisted import, dedupe, and rejection passed');
} finally {
  for (const path of cleanup) {
    await rm(path, { force: true }).catch(() => undefined);
  }
  await rm(workRoot, { recursive: true, force: true }).catch(() => undefined);
  seedKeystore({ AGENT_IMPORT_ROOTS: '' });
}
