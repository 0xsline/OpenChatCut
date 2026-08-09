import assert from 'node:assert/strict';
import type { DirectoryImportedFile } from '../../shared/directory-import';
import { directoryFileToAsset } from './directoryImportAsset';

const HASH = 'a'.repeat(64);
const base: DirectoryImportedFile = {
  importId: 'import-a',
  name: 'camera.mov',
  src: '/media/uploads/camera.mp4',
  storedName: 'camera.mp4',
  contentHash: HASH,
  kind: 'video',
  size: 4096,
  sourceModifiedAt: 1_725_000_000_000,
  durationSeconds: 12,
  width: 1920,
  height: 1080,
  sourceFps: 25,
  compatibilityNormalized: true,
};

{
  const asset = await directoryFileToAsset(base, 30, { createId: () => 'asset-normalized' });
  assert.equal(asset.src, '/media/uploads/camera.mp4', 'renderer publishes the backend-owned canonical output');
  assert.equal(asset.durationInFrames, 360, 'canonical descriptor duration uses the project FPS');
  assert.deepEqual([asset.width, asset.height], [1920, 1080]);
  assert.equal(asset.sourceFilename, 'camera.mov');
  assert.equal(asset.sourceContentHash, HASH);
  assert.equal(asset.sourceSize, 4096);
  assert.equal(asset.sourceModifiedAt, base.sourceModifiedAt);
  assert.equal(asset.sourceRevision, `source-sha256-${HASH}`);
}

{
  const original: DirectoryImportedFile = {
    importId: base.importId, name: base.name, src: base.src, storedName: base.storedName,
    contentHash: base.contentHash, kind: base.kind, size: base.size,
    sourceModifiedAt: base.sourceModifiedAt, durationSeconds: base.durationSeconds,
    width: base.width, height: base.height, sourceFps: base.sourceFps,
  };
  const asset = await directoryFileToAsset({
    ...original,
    src: '/media/uploads/camera.alpha.webm',
    storedName: 'camera.alpha.webm',
    proxyKind: 'alpha-webm',
    durationSeconds: 10,
  }, 30, { createId: () => 'asset-alpha' });
  assert.equal(asset.src, '/media/uploads/camera.alpha.webm', 'transparent MOV proxy descriptors publish directly');
  assert.equal(asset.durationInFrames, 300, 'source FPS never replaces project FPS');
  await assert.rejects(
    directoryFileToAsset(original, 30, { createId: () => 'asset-unsafe' }),
    /尚未完成兼容性处理/,
    'ordinary watched video descriptors must be normalized before renderer publication',
  );
}

for (const kind of ['image', 'svg'] as const) {
  const asset = await directoryFileToAsset({
    ...base,
    importId: `import-${kind}`,
    name: `still.${kind === 'svg' ? 'svg' : 'png'}`,
    storedName: `still.${kind === 'svg' ? 'svg' : 'png'}`,
    kind,
    durationSeconds: 1,
  }, 24, { createId: () => `asset-${kind}` });
  assert.equal(asset.durationInFrames, 120, `${kind} assets use the canonical five-second still duration`);
}

{
  const fallback = await directoryFileToAsset({
    ...base,
    importId: 'import-gif', name: 'loop.gif', storedName: 'loop.gif', kind: 'gif',
    durationSeconds: undefined,
  }, 30, { createId: () => 'asset-gif' });
  assert.equal(fallback.durationInFrames, 150, 'GIF metadata fallback is five seconds');
  const timed = await directoryFileToAsset({
    ...base,
    importId: 'import-gif-timed', name: 'timed.gif', storedName: 'timed.gif', kind: 'gif',
    durationSeconds: 2,
  }, 30, { createId: () => 'asset-gif-timed' });
  assert.equal(timed.durationInFrames, 60, 'probed GIF duration uses the project FPS');
}

{
  const audio = await directoryFileToAsset({
    ...base,
    importId: 'import-audio', name: 'voice.wav', storedName: 'voice.wav', kind: 'audio',
    durationSeconds: 8, sourceFps: 96,
  }, 24, { createId: () => 'asset-audio' });
  assert.equal(audio.durationInFrames, 192, 'timed media always uses project FPS');
}
