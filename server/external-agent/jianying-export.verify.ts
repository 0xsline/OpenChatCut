import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expandHomeDir, resolveMediaPath } from './jianying-export.ts';

assert.equal(expandHomeDir(''), '');
assert.equal(expandHomeDir('/plain/path'), '/plain/path');
assert.equal(expandHomeDir('~/Movies'), `${process.env.HOME}/Movies`);
assert.equal(expandHomeDir('~other/path'), '~other/path');
assert.equal(expandHomeDir('~/'), `${process.env.HOME}/`);
assert.equal(expandHomeDir('~'), process.env.HOME);

assert.equal(resolveMediaPath(''), undefined);
assert.equal(resolveMediaPath('/media/uploads/../etc/passwd'), undefined);
assert.equal(resolveMediaPath('/media/uploads/./x.mp4'), undefined);
assert.equal(resolveMediaPath('/definitely/not/a/file.mp4'), undefined);

const publicUpload = resolveMediaPath('/media/uploads/01c3ba22-961a-4d4b-aa70-f33727150f93.mp4');
if (publicUpload) {
  assert.ok(publicUpload.endsWith('01c3ba22-961a-4d4b-aa70-f33727150f93.mp4'), 'resolves to a real media file');
} else {
  console.warn('[skip] no media file present on this machine — path resolution fallback verified via negatives');
}

// A path import can store a pointer under .references/ instead of a copy, which
// left exactly those clips "not found locally" until this resolution followed it.
const home = mkdtempSync(join(tmpdir(), 'occ-jianying-ref-'));
try {
  const mediaDir = join(home, 'media', 'uploads');
  const master = join(home, 'master.mp4');
  mkdirSync(join(mediaDir, '.references'), { recursive: true });
  writeFileSync(master, 'not really a movie');
  writeFileSync(
    join(mediaDir, '.references', 'reference-asset.mp4.json'),
    JSON.stringify({ version: 1, sourcePath: master, createdAt: new Date().toISOString() }),
  );
  const resolved = resolveMediaPath('/media/uploads/reference-asset.mp4', { mediaDir });
  assert.equal(resolved, realpathSync(master), 'a referenced master resolves to its original file');

  const copied = join(mediaDir, 'copied-asset.mp4');
  writeFileSync(copied, 'copy');
  assert.equal(resolveMediaPath('/media/uploads/copied-asset.mp4', { mediaDir }), copied);
  assert.equal(resolveMediaPath('/media/uploads/missing-asset.mp4', { mediaDir }), undefined);
} finally {
  rmSync(home, { recursive: true, force: true });
}

console.log('jianying-export media path resolution checks passed');