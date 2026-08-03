import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { seedKeystore } from '../server/keystore.ts';
import {
  hasAlphaPixelFormat,
  importLocalMedia,
  isTransparentMovProbe,
  transparentMovProxyArgs,
} from './local-media-import.ts';

assert.equal(hasAlphaPixelFormat('yuva444p10le'), true, 'ProRes 4444 alpha must be detected');
assert.equal(hasAlphaPixelFormat('gbrap12le'), true, 'planar RGB alpha must be detected');
assert.equal(hasAlphaPixelFormat('yuv420p'), false, 'ordinary video must stay opaque');
assert.equal(
  isTransparentMovProbe({ codec_name: 'prores', profile: '4444', pix_fmt: 'yuva444p10le' }),
  true,
);
assert.equal(
  isTransparentMovProbe({ codec_name: 'prores', profile: '4444', pix_fmt: 'yuv444p10le' }),
  false,
  'profile alone must not proxy an opaque ProRes 4444 file',
);
assert.equal(
  isTransparentMovProbe({ codec_name: 'vp9', pix_fmt: 'yuv420p', tags: { alpha_mode: 1 } }),
  true,
  'explicit alpha metadata must be honored',
);

const args = transparentMovProxyArgs('/tmp/source.mov', '/tmp/proxy.webm');
assert.deepEqual(args.slice(0, 7), [
  '-y', '-i', '/tmp/source.mov', '-map', '0:v:0', '-map', '0:a?',
]);
assert.equal(args.includes('-an'), false, 'transparent proxies must not disable audio');
const audioCodecIndex = args.indexOf('-c:a');
assert.notEqual(audioCodecIndex, -1, 'transparent proxies must configure an audio codec');
assert.equal(args[audioCodecIndex + 1], 'libopus', 'WebM proxy audio must use browser-compatible Opus');
assert.ok(args.includes('yuva420p'), 'proxy must preserve alpha');
assert.ok(args.includes('alpha_mode=1'), 'proxy must label VP9 alpha for Chromium');
assert.equal(args.includes('libx264'), false, 'H.264 would discard alpha');

const previousMediaDir = process.env.MEDIA_DIR;
const testRoot = await mkdtemp(join(tmpdir(), 'openchatcut-local-import-'));
const uploadDirectory = join(testRoot, 'uploads');
const sourcePath = join(testRoot, 'source.mov');
const originalContents = Buffer.from('independent local media snapshot');

try {
  process.env.MEDIA_DIR = uploadDirectory;
  seedKeystore({ MEDIA_DIR: uploadDirectory });
  await mkdir(uploadDirectory, { recursive: true });
  await writeFile(sourcePath, originalContents);

  const imported = await importLocalMedia(sourcePath, 'camera-original.mov');
  const importedPath = join(uploadDirectory, imported.storedName);
  const [sourceInfo, importedInfo] = await Promise.all([stat(sourcePath), stat(importedPath)]);

  assert.equal(sourceInfo.dev, importedInfo.dev, 'fixture must exercise a same-volume import');
  assert.notEqual(importedInfo.ino, sourceInfo.ino, 'imported media must not be a hard link');
  assert.equal(imported.src, `/media/uploads/${imported.storedName}`);
  assert.equal(imported.storedName.endsWith('.mov'), true);

  await truncate(sourcePath, 0);
  await writeFile(sourcePath, 'replacement source bytes');
  assert.deepEqual(
    await readFile(importedPath),
    originalContents,
    'truncating and rewriting the source must not alter the imported snapshot',
  );
} finally {
  if (previousMediaDir === undefined) delete process.env.MEDIA_DIR;
  else process.env.MEDIA_DIR = previousMediaDir;
  await rm(testRoot, { recursive: true, force: true });
}

console.log('desktop local-media-import verification passed');
