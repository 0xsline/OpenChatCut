import assert from 'node:assert/strict';
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

console.log('jianying-export media path resolution checks passed');