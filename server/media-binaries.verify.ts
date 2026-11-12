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
} finally {
  rmSync(root, { recursive: true, force: true });
}

// The resolved dev binaries are real files that can be spawned (an explicit override wins).
assert.ok(!ffmpegBin().includes(`${sep}app.asar${sep}`));
assert.ok(!ffprobeBin().includes(`${sep}app.asar${sep}`));
process.env.OPENCHATCUT_FFPROBE = '/custom/ffprobe';
assert.equal(ffprobeBin(), '/custom/ffprobe');
delete process.env.OPENCHATCUT_FFPROBE;

// Issue #262: FFMPEG_PATH is a cross-tool convention that is often set to the bin
// directory. A directory override must resolve to the executable inside it; passing the
// directory through reached copyFile() in the Remotion mirror and failed with EPERM.
const binDirectory = join(root, 'ffmpeg-bin');
mkdirSync(binDirectory, { recursive: true });
const platformName = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
writeFileSync(join(binDirectory, platformName), 'binary');
process.env.FFMPEG_PATH = binDirectory;
assert.equal(ffmpegBin(), join(binDirectory, platformName),
  'a directory FFMPEG_PATH resolves to the ffmpeg binary inside it');
process.env.FFMPEG_PATH = join(binDirectory, platformName);
assert.equal(ffmpegBin(), join(binDirectory, platformName), 'a file FFMPEG_PATH is passed through');
delete process.env.FFMPEG_PATH;

console.log('media-binaries checks passed (asar twin rewrite, overrides, directory FFMPEG_PATH)');
