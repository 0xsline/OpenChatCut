import assert from 'node:assert/strict';
import type { Stats } from 'node:fs';
import {
  DirectoryDestinationChangedError,
  DirectoryImportCancelledError,
  importDirectoryCandidate,
  type DirectoryCandidateRequest,
  type DirectoryImportDependencies,
} from './directory-watch-import.ts';

const ROOT = '/watch';
const SOURCE = `${ROOT}/clip.mov`;
const HASH_A = 'aa'.repeat(32);
const HASH_B = 'bb'.repeat(32);

// Production cleanup joins use platform separators, and a resolved upload
// directory gains a Windows drive prefix; compare paths positionally instead.
const asPosixPaths = (paths: readonly string[]): Set<string> =>
  new Set(paths.map((path) => path.replace(/\\/g, '/').replace(/^[A-Za-z]:/, '')));

function fileStats(size = 100, mtimeMs = 10, ino = 20): Stats {
  return {
    size,
    mtimeMs,
    ino,
    isFile: () => true,
  } as Stats;
}

function request(
  knownHashes: ReadonlySet<string> = new Set(),
  cancelled: () => boolean = () => false,
  signal: AbortSignal = new AbortController().signal,
): DirectoryCandidateRequest {
  return {
    sourcePath: SOURCE,
    root: ROOT,
    name: 'clip.mov',
    pinnedUploadDirectory: '/uploads',
    knownHashes,
    cancelled,
    signal,
  };
}

interface DependencyHarness {
  dependencies: DirectoryImportDependencies;
  readonly removed: string[];
  imports: number;
  probes: number;
}

function harness(
  overrides: Partial<DirectoryImportDependencies> = {},
): DependencyHarness {
  const removed: string[] = [];
  const result: DependencyHarness = {
    removed,
    imports: 0,
    probes: 0,
    dependencies: undefined as unknown as DirectoryImportDependencies,
  };
  result.dependencies = {
    realpath: async (path) => path,
    stat: async () => fileStats(),
    uploadDirectory: () => '/uploads',
    canonicalUploadDirectory: async () => '/uploads',
    importLocalMedia: async () => {
      result.imports += 1;
      return { src: '/media/uploads/id.mov', storedName: 'id.mov', contentHash: HASH_A };
    },
    createTransparentMovProxy: async () => null,
    resolveUpload: () => SOURCE,
    normalizeVideo: async (inputPath, publicSrc) => ({
      path: publicSrc,
      outputPath: inputPath,
      normalized: false,
      reason: 'source accepted',
      bytes: 100,
      width: 1920,
      height: 1080,
      durationSeconds: 2,
      sourceFps: 30,
      variableFrameRate: false,
    }),
    probeMedia: async () => {
      result.probes += 1;
      return { durationSeconds: 2, width: 1920, height: 1080, sourceFps: 30 };
    },
    unlink: async (path) => { removed.push(path); },
    ...overrides,
  };
  return result;
}

const escaped = harness({ realpath: async () => '/outside/clip.mov' });
assert.deepEqual(
  await importDirectoryCandidate(request(), escaped.dependencies),
  { status: 'retry', retryImmediately: false },
  'a symlink escape must be ignored without importing its target',
);
assert.equal(escaped.imports, 0);

const duplicate = harness();
const duplicateResult = await importDirectoryCandidate(
  request(new Set([HASH_A])), duplicate.dependencies,
);
assert.equal(duplicateResult.status, 'duplicate');
assert.deepEqual(
  asPosixPaths(duplicate.removed),
  new Set([
    '/uploads/id.mov', '/uploads/id.mp4', '/uploads/id.alpha.webm',
    '/uploads/.references/id.mov.json',
  ]),
  'duplicate hashes must delete every original/proxy/normalization candidate',
);
assert.equal(duplicate.probes, 0, 'hash dedupe must happen before probe or proxy work');

const probeFailure = harness({ normalizeVideo: async () => { throw new Error('partial file'); } });
assert.deepEqual(
  await importDirectoryCandidate(request(), probeFailure.dependencies),
  { status: 'retry', retryImmediately: false },
  'a post-copy probe failure must remain retryable',
);
assert.deepEqual(
  asPosixPaths(probeFailure.removed),
  new Set([
    '/uploads/id.mov', '/uploads/id.mp4', '/uploads/id.alpha.webm',
    '/uploads/.references/id.mov.json',
  ]),
  'probe failure must remove all newly created output candidates',
);

let cancelled = false;
const cancelledCopy = harness({
  importLocalMedia: async () => {
    cancelled = true;
    return { src: '/media/uploads/id.mov', storedName: 'id.mov', contentHash: HASH_A };
  },
});
await assert.rejects(
  importDirectoryCandidate(request(new Set(), () => cancelled), cancelledCopy.dependencies),
  DirectoryImportCancelledError,
);
assert.deepEqual(
  asPosixPaths(cancelledCopy.removed),
  new Set([
    '/uploads/id.mov', '/uploads/id.mp4', '/uploads/id.alpha.webm',
    '/uploads/.references/id.mov.json',
  ]),
  'cancellation winning after copy must clean the unpublished copy',
);

const normalizeAbort = new AbortController();
const normalizeEntered = Promise.withResolvers<void>();
const cancelledNormalize = harness({
  normalizeVideo: async (_inputPath, _publicSrc, signal) => {
    normalizeEntered.resolve();
    const stopped = Promise.withResolvers<never>();
    signal.addEventListener('abort', () => stopped.reject(signal.reason), { once: true });
    return stopped.promise;
  },
});
const normalizePending = importDirectoryCandidate(
  request(new Set(), () => normalizeAbort.signal.aborted, normalizeAbort.signal),
  cancelledNormalize.dependencies,
);
await normalizeEntered.promise;
normalizeAbort.abort(new DirectoryImportCancelledError());
await assert.rejects(normalizePending, DirectoryImportCancelledError);
assert.deepEqual(
  asPosixPaths(cancelledNormalize.removed),
  new Set([
    '/uploads/id.mov', '/uploads/id.mp4', '/uploads/id.alpha.webm',
    '/uploads/.references/id.mov.json',
  ]),
  'stop must abort backend normalization and remove every owned output before settling',
);

let destinationChecks = 0;
const destinationChanged = harness({
  uploadDirectory: () => '/changed',
  canonicalUploadDirectory: async () => (++destinationChecks === 1 ? '/uploads' : '/changed'),
});
await assert.rejects(
  importDirectoryCandidate(request(), destinationChanged.dependencies),
  DirectoryDestinationChangedError,
);
assert.deepEqual(
  asPosixPaths(destinationChanged.removed),
  new Set([
    '/uploads/id.mov', '/uploads/id.mp4', '/uploads/id.alpha.webm',
    '/uploads/.references/id.mov.json',
    '/changed/id.mov', '/changed/id.mp4', '/changed/id.alpha.webm',
    '/changed/.references/id.mov.json',
  ]),
  'MEDIA_DIR changes during copy must clean both pinned and newly selected destinations',
);

const transparent = harness({
  createTransparentMovProxy: async () => ({ src: '/media/uploads/id.alpha.webm' }),
});
const transparentResult = await importDirectoryCandidate(request(), transparent.dependencies);
assert.equal(transparentResult.status, 'imported');
if (transparentResult.status === 'imported') {
  assert.equal(transparentResult.prepared.file.proxyKind, 'alpha-webm');
  assert.equal(transparentResult.prepared.file.src, '/media/uploads/id.alpha.webm');
  assert.equal(transparentResult.prepared.file.durationSeconds, 2);
  assert.equal(transparentResult.prepared.file.sourceFps, 30);
  assert.deepEqual(
    asPosixPaths(transparentResult.prepared.createdPaths),
    new Set([
      '/uploads/id.mov', '/uploads/id.mp4', '/uploads/id.alpha.webm',
      '/uploads/.references/id.mov.json',
    ]),
    'the opaque grant must retain every possible renderer output for later ack cleanup',
  );
}

let statCall = 0;
const changingSource = harness({
  stat: async () => (++statCall === 1 ? fileStats(10, 1) : fileStats(11, 2)),
});
assert.deepEqual(
  await importDirectoryCandidate(request(), changingSource.dependencies),
  { status: 'retry', retryImmediately: false },
  'a file changing during the stability check must be retried without copying',
);
assert.equal(changingSource.imports, 0);

const hashes = new Set<string>();
const firstBatch = harness();
const first = await importDirectoryCandidate(request(hashes), firstBatch.dependencies);
assert.equal(first.status, 'imported');
if (first.status === 'imported') hashes.add(first.prepared.file.contentHash);
const secondBatch = harness({
  importLocalMedia: async () => ({
    src: '/media/uploads/second.mov', storedName: 'second.mov', contentHash: HASH_A,
  }),
});
assert.equal((await importDirectoryCandidate(request(hashes), secondBatch.dependencies)).status, 'duplicate');
assert.ok(asPosixPaths(secondBatch.removed).has('/uploads/second.mov'));

const differentContent = harness({
  importLocalMedia: async () => ({ src: '/media/uploads/different.mov', storedName: 'different.mov', contentHash: HASH_B }),
});
assert.equal(
  (await importDirectoryCandidate(request(hashes), differentContent.dependencies)).status,
  'imported',
  'same-batch dedupe must retain distinct content hashes',
);

const unhashedLargeFile = harness({
  importLocalMedia: async () => ({
    src: '/media/uploads/large.mov', storedName: 'large.mov', contentHash: '',
  }),
});
const unhashedResult = await importDirectoryCandidate(request(hashes), unhashedLargeFile.dependencies);
assert.equal(unhashedResult.status, 'imported', 'large files without an eager hash must still import');
if (unhashedResult.status === 'imported') {
  assert.equal(unhashedResult.prepared.file.contentHash, '');
}

process.stdout.write('directory-watch-import.verify: confinement, retries, dedupe, and cleanup passed\n');
