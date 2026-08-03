import assert from 'node:assert/strict';
import { constants } from 'node:fs';
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
import {
  createLocalMediaImportHandler,
  importLocalMediaFromFile,
  LOCAL_MEDIA_IMPORT_CHANNEL,
} from './local-media-bridge.ts';

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
const largeSourcePath = join(testRoot, 'source-over-10gb.mp4');
const overTenGigabytes = (10 * 1024 ** 3) + 1;

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

  let simulatedStatPath = '';
  let simulatedCopy:
    | { source: string; destination: string; mode: number }
    | undefined;
  const importedLarge = await importLocalMedia(
    largeSourcePath,
    'source-over-10gb.mp4',
    {
      stat: async (path) => {
        simulatedStatPath = path;
        return { isFile: () => true, size: overTenGigabytes };
      },
      copyFile: async (source, destination, mode) => {
        simulatedCopy = { source, destination, mode };
      },
    },
  );
  assert.equal(simulatedStatPath, largeSourcePath, 'large imports must inspect the native source path');
  assert.deepEqual(simulatedCopy, {
    source: largeSourcePath,
    destination: join(uploadDirectory, importedLarge.storedName),
    mode: constants.COPYFILE_FICLONE,
  }, 'large imports must reach the copy operation without allocating a 10 GiB fixture');
  assert.equal(importedLarge.storedName.endsWith('.mp4'), true);

  const bridgeFile = { name: 'camera-original.mov' } as File;
  const bridgeSourcePath = join(testRoot, 'camera-original.mov');
  const bridgeImport = {
    src: '/media/uploads/bridge-camera.mov',
    storedName: 'bridge-camera.mov',
  };
  const ipcInvocations: Array<{
    channel: string;
    sourcePath: string;
    originalName: string;
  }> = [];
  const preloadImport = await importLocalMediaFromFile(bridgeFile, {
    getPathForFile: (file) => {
      assert.equal(file, bridgeFile);
      return bridgeSourcePath;
    },
    invoke: async (channel, sourcePath, originalName) => {
      ipcInvocations.push({ channel, sourcePath, originalName });
      return bridgeImport;
    },
  });
  assert.deepEqual(preloadImport, bridgeImport);
  assert.deepEqual(ipcInvocations, [{
    channel: LOCAL_MEDIA_IMPORT_CHANNEL,
    sourcePath: bridgeSourcePath,
    originalName: bridgeFile.name,
  }], 'preload must send the resolved path and File.name through IPC');

  let pathlessInvokeCalls = 0;
  const pathlessImport = await importLocalMediaFromFile(bridgeFile, {
    getPathForFile: () => '',
    invoke: async () => {
      pathlessInvokeCalls += 1;
      return bridgeImport;
    },
  });
  assert.equal(pathlessImport, null, 'pathless browser Files must retain the HTTP fallback');
  assert.equal(pathlessInvokeCalls, 0, 'pathless browser Files must not invoke native import IPC');
  const unresolvedImport = await importLocalMediaFromFile(bridgeFile, {
    getPathForFile: () => {
      throw new Error('File has no native path');
    },
    invoke: async () => {
      pathlessInvokeCalls += 1;
      return bridgeImport;
    },
  });
  assert.equal(unresolvedImport, null, 'native path resolution failures must retain the HTTP fallback');
  assert.equal(pathlessInvokeCalls, 0, 'failed path resolution must not invoke native import IPC');

  const mainImportCalls: Array<{ sourcePath: string; originalName: string }> = [];
  const mainHandler = createLocalMediaImportHandler(async (sourcePath, originalName) => {
    mainImportCalls.push({ sourcePath, originalName });
    return bridgeImport;
  });
  assert.deepEqual(
    await mainHandler(undefined, bridgeSourcePath, bridgeFile.name),
    bridgeImport,
    'main must return the filesystem importer result',
  );
  assert.deepEqual(mainImportCalls, [{
    sourcePath: bridgeSourcePath,
    originalName: bridgeFile.name,
  }], 'main must call importLocalMedia with the validated IPC arguments');
  await assert.rejects(
    mainHandler(undefined, 'relative/camera.mov', bridgeFile.name),
    /absolute path/,
    'main must reject relative source paths',
  );
  await assert.rejects(
    mainHandler(undefined, bridgeSourcePath, join('nested', bridgeFile.name)),
    /invalid local media filename/,
    'main must reject nested or traversal filenames',
  );
  assert.equal(mainImportCalls.length, 1, 'invalid IPC payloads must not reach the filesystem importer');
} finally {
  if (previousMediaDir === undefined) delete process.env.MEDIA_DIR;
  else process.env.MEDIA_DIR = previousMediaDir;
  await rm(testRoot, { recursive: true, force: true });
}

console.log('desktop local-media-import verification passed');
