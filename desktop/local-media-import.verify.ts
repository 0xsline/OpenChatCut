import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { seedKeystore } from '../server/keystore.ts';
import { resolveUploadFile } from '../server/media-dir.ts';
import { mediaReferenceManifestPath } from '../server/media-references.ts';
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

const mainSource = await readFile(new URL('./main.ts', import.meta.url), 'utf8');
assert.match(
  mainSource,
  /createLocalMediaImportHandler\(importLocalMedia\)/,
  'desktop main must bind native reference imports',
);

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
assert.ok(args.indexOf('-threads') > args.indexOf('-c:v'), 'VP9 encoder threads belong to the output option group');

const previousMediaDir = process.env.MEDIA_DIR;
const testRoot = await mkdtemp(join(tmpdir(), 'openchatcut-local-import-'));
const uploadDirectory = join(testRoot, 'uploads');
const sourcePath = join(testRoot, 'source.mov');
const originalContents = Buffer.from('independent local media snapshot');
const expectedContentHash = createHash('sha256').update(originalContents).digest('hex');
const largeSourcePath = join(testRoot, 'source-over-10gb.mp4');
const overTenGigabytes = (10 * 1024 ** 3) + 1;

try {
  process.env.MEDIA_DIR = uploadDirectory;
  seedKeystore({ MEDIA_DIR: uploadDirectory });
  await mkdir(uploadDirectory, { recursive: true });
  await writeFile(sourcePath, originalContents);

  const imported = await importLocalMedia(sourcePath, 'camera-original.mov');
  const importedPath = join(uploadDirectory, imported.storedName);
  await assert.rejects(stat(importedPath), { code: 'ENOENT' }, 'native import must not copy media bytes');
  assert.equal(imported.src, `/media/uploads/${imported.storedName}`);
  assert.equal(imported.storedName.endsWith('.mov'), true);
  assert.equal(imported.contentHash, expectedContentHash, 'native import must stream-hash the source');
  assert.equal(
    resolveUploadFile(imported.storedName),
    await realpath(sourcePath),
    'the stable media URL must resolve to the source',
  );
  await assert.doesNotReject(
    stat(mediaReferenceManifestPath(uploadDirectory, imported.storedName)),
    'native import must persist a small reference manifest',
  );

  await writeFile(sourcePath, 'replacement source bytes');
  assert.deepEqual(
    await readFile(resolveUploadFile(imported.storedName)!),
    Buffer.from('replacement source bytes'),
    'a reference must keep reading the external source instead of a stale copy',
  );

  let simulatedStatPath = '';
  let simulatedHashPath = '';
  let simulatedReference: { directory: string; name: string; sourcePath: string } | undefined;
  const importedLarge = await importLocalMedia(
    largeSourcePath,
    'source-over-10gb.mp4',
    {
      stat: async (path) => {
        simulatedStatPath = path;
        return { isFile: () => true, size: overTenGigabytes, mtimeMs: 123 };
      },
      hashFile: async (path) => {
        simulatedHashPath = path;
        return 'A'.repeat(64);
      },
      registerReference: async (directory, name, referencedSourcePath) => {
        simulatedReference = { directory, name, sourcePath: referencedSourcePath };
      },
    },
  );
  assert.equal(simulatedStatPath, largeSourcePath, 'large imports must inspect the native source path');
  assert.deepEqual(simulatedReference, {
    directory: uploadDirectory,
    name: importedLarge.storedName,
    sourcePath: largeSourcePath,
  }, 'large imports must register the source without allocating a 10 GiB fixture');
  assert.equal(importedLarge.storedName.endsWith('.mp4'), true);
  assert.equal(
    simulatedHashPath,
    '',
    'multi-GiB imports skip the full-file SHA-256 pass to avoid doubling disk I/O',
  );
  assert.equal(importedLarge.contentHash, '', 'large imports report no content hash (dedup disabled)');

  const bridgeFile = { name: 'camera-original.mov' } as File;
  const bridgeSourcePath = join(testRoot, 'camera-original.mov');
  const bridgeImport = {
    src: '/media/uploads/bridge-camera.mov',
    storedName: 'bridge-camera.mov',
    contentHash: expectedContentHash,
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
