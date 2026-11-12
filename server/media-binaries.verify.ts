// Spawnable binaries must resolve to real files once the app ships as an asar archive.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { ffmpegBin, ffprobeBin, unpackedPath } from './media-binaries.ts';

const root = mkdtempSync(join(tmpdir(), 'media-binaries-'));
try {
  const archived = join(root, 'Resources', 'app.asar', 'node_modules', 'ffmpeg-static', 'ffmpeg');
  const twin = join(root, 'Resources', 'app.asar.unpacked', 'node_modules', 'ffmpeg-static', 'ffmpeg');
  assert.equal(unpackedPath(archived), archived, 'without an unpacked twin the path is left alone');
  mkdirSync(join(root, 'Resources', 'app.asar.unpacked', 'node_modules', 'ffmpeg-static'), { recursive: true });
  writeFileSync(twin, 'binary');
  assert.equal(unpackedPath(archived), twin, 'a path inside app.asar is rewritten to its app.asar.unpacked twin');
  const plain = join(root, 'dev', 'node_modules', 'ffmpeg-static', 'ffmpeg');
  assert.equal(unpackedPath(plain), plain, 'dev paths are untouched');
  const lookalike = join(root, 'my-app.asar-notes', 'ffmpeg');
  assert.equal(unpackedPath(lookalike), lookalike, `only a full ${sep}app.asar${sep} segment counts`);
  // The resolved dev binaries are real files that can be spawned (a file override wins).
  assert.ok(!ffmpegBin().includes(`${sep}app.asar${sep}`));
  assert.ok(!ffprobeBin().includes(`${sep}app.asar${sep}`));
  const probeOverride = join(root, 'custom-ffprobe');
  writeFileSync(probeOverride, 'binary');
  process.env.OPENCHATCUT_FFPROBE = probeOverride;
  assert.equal(ffprobeBin(), probeOverride);
  delete process.env.OPENCHATCUT_FFPROBE;
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log('media-binaries checks passed (asar twin rewrite, overrides)');
