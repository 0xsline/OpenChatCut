import assert from 'node:assert/strict';
import {
  isDirectoryImportedFile,
  isDirectoryWatchStartResult,
} from './directory-import.ts';

const base = {
  importId: 'import-a',
  name: 'camera.mov',
  src: '/media/uploads/camera.mp4',
  storedName: 'camera.mp4',
  contentHash: 'ab'.repeat(32),
  kind: 'video' as const,
  size: 1_024,
  sourceModifiedAt: 1_725_000_000_000,
  durationSeconds: 3,
  width: 1920,
  height: 1080,
  sourceFps: 30,
};

assert.equal(isDirectoryImportedFile({ ...base, compatibilityNormalized: true }), true);
assert.equal(isDirectoryImportedFile({
  ...base,
  src: '/media/uploads/camera.alpha.webm',
  storedName: 'camera.mov',
  proxyKind: 'alpha-webm',
}), true);
assert.equal(isDirectoryImportedFile(base), false, 'ordinary video requires backend normalization');
assert.equal(isDirectoryImportedFile({
  ...base,
  compatibilityNormalized: true,
  proxyKind: 'alpha-webm',
}), false, 'video readiness discriminants are mutually exclusive');
assert.equal(isDirectoryImportedFile({
  ...base,
  compatibilityNormalized: true,
  originalFilePath: '/private/camera.mov',
}), false, 'absolute source paths must not cross the preload contract');
assert.equal(isDirectoryWatchStartResult({
  watchId: 'watch-a',
  projectId: 'project-a',
  directoryName: 'Shots',
  root: '/private/Shots',
  files: [{ ...base, compatibilityNormalized: true }],
}), false, 'watch roots must never reach the renderer');
assert.equal(isDirectoryWatchStartResult({
  watchId: 'watch-a',
  projectId: 'project-a',
  directoryName: 'Shots',
  files: [{ ...base, compatibilityNormalized: true }],
}), true);

process.stdout.write('directory-import.verify: opaque paths and readiness discriminants passed\n');
