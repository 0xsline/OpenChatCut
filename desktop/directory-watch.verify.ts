import assert from 'node:assert/strict';
import type { DirectoryImportEvent } from '../shared/directory-import.ts';
import {
  DirectoryScanLimitError,
  DirectoryWatchSession,
  scanImportDirectory,
  type DirectoryEntry,
  type DirectoryWatchDependencies,
} from './directory-watch.ts';
import type {
  DirectoryCandidateRequest,
  DirectoryCandidateResult,
  DirectoryFileFingerprint,
} from './directory-watch-import.ts';

const ROOT = '/watch-root';
const UPLOADS = '/media/uploads';
const FINGERPRINT: DirectoryFileFingerprint = { size: 10, mtimeMs: 20, ino: 30 };

function entry(name: string, kind: 'file' | 'directory' | 'symlink' = 'file'): DirectoryEntry {
  return {
    name,
    isFile: () => kind === 'file',
    isDirectory: () => kind === 'directory',
    isSymbolicLink: () => kind === 'symlink',
  };
}

function hashFor(name: string): string {
  const code = name.charCodeAt(0).toString(16).padStart(2, '0');
  return code.repeat(32);
}

function imported(request: DirectoryCandidateRequest): DirectoryCandidateResult {
  if (request.knownFingerprint) {
    return { status: 'unchanged', fingerprint: request.knownFingerprint };
  }
  const storedName = `${request.name.replace(/\W/g, '-')}.mp4`;
  return {
    status: 'imported',
    prepared: {
      file: {
        name: request.name,
        src: `/media/uploads/${storedName}`,
        storedName,
        compatibilityNormalized: true,
        contentHash: hashFor(request.name),
        kind: 'video',
        size: FINGERPRINT.size,
        sourceModifiedAt: FINGERPRINT.mtimeMs,
      },
      fingerprint: FINGERPRINT,
      createdPaths: [`${UPLOADS}/${storedName}`],
    },
  };
}

interface Harness {
  readonly tree: Map<string, DirectoryEntry[]>;
  readonly events: DirectoryImportEvent[];
  readonly removed: string[][];
  readonly dependencies: DirectoryWatchDependencies;
  fireWatch(): void;
  setDestination(path: string): void;
}

function createHarness(
  importCandidate: (request: DirectoryCandidateRequest) => Promise<DirectoryCandidateResult>
    = async (request) => imported(request),
): Harness {
  const tree = new Map<string, DirectoryEntry[]>([[ROOT, []]]);
  const events: DirectoryImportEvent[] = [];
  const removed: string[][] = [];
  let listener: () => void = () => undefined;
  let destination = UPLOADS;
  return {
    tree,
    events,
    removed,
    dependencies: {
      readdir: async (path) => tree.get(path) ?? [],
      watch: (_path, nextListener) => {
        listener = nextListener;
        return { close: () => { listener = () => undefined; } };
      },
      realpath: async (path) => path,
      canonicalUploadDirectory: async () => destination,
      settleWrites: async () => undefined,
      importCandidate,
      removeFiles: async (paths) => { removed.push([...paths]); },
      randomId: (() => {
        let value = 0;
        return () => `import-${++value}`;
      })(),
    },
    fireWatch: () => listener(),
    setDestination: (path) => { destination = path; },
  };
}

function sessionFor(harness: Harness, watchId: string): DirectoryWatchSession {
  return new DirectoryWatchSession({
    watchId,
    projectId: `project-${watchId}`,
    root: ROOT,
    pinnedUploadDirectory: UPLOADS,
    existingContentHashes: [],
    onImported: (event) => {
      harness.events.push(event);
      return true;
    },
  }, harness.dependencies);
}

const lifecycle = createHarness();
lifecycle.tree.set(ROOT, [entry('a.mp4')]);
const lifecycleSession = sessionFor(lifecycle, 'lifecycle');
const initial = await lifecycleSession.start();
assert.equal(initial.files.length, 1);
assert.equal(initial.files[0].name, 'a.mp4');
await lifecycleSession.acknowledge(initial.files[0].importId, 'accepted');

lifecycle.tree.set(ROOT, [entry('a.mp4'), entry('b.mp4')]);
lifecycle.fireWatch();
assert.equal(lifecycle.events.length, 0, 'inactive watches must retain dirtiness without emitting');
await lifecycleSession.activate();
assert.deepEqual(lifecycle.events.map((event) => event.file.name), ['b.mp4']);
assert.equal(lifecycle.events[0].projectId, 'project-lifecycle');
await lifecycleSession.acknowledge(lifecycle.events[0].file.importId, 'duplicate');
assert.deepEqual(lifecycle.removed, [[`${UPLOADS}/b-mp4.mp4`]], 'renderer duplicate ack must clean output');
await lifecycleSession.stop();

const setupRace = createHarness();
const setupDependencies: DirectoryWatchDependencies = {
  ...setupRace.dependencies,
  watch: (_path, listener) => {
    setupRace.tree.set(ROOT, [entry('created-during-setup.mp4')]);
    listener();
    return { close: () => undefined };
  },
};
const setupSession = new DirectoryWatchSession({
  watchId: 'setup-race',
  projectId: 'project-setup-race',
  root: ROOT,
  pinnedUploadDirectory: UPLOADS,
  existingContentHashes: [],
  onImported: () => true,
}, setupDependencies);
const setupResult = await setupSession.start();
assert.deepEqual(
  setupResult.files.map((file) => file.name),
  ['created-during-setup.mp4'],
  'installing fs.watch before the initial scan must close the setup race',
);
await setupSession.acknowledge(setupResult.files[0].importId, 'accepted');
await setupSession.stop();

const partial = createHarness((() => {
  let calls = 0;
  return async (request): Promise<DirectoryCandidateResult> => {
    calls += 1;
    return calls === 1
      ? { status: 'retry', retryImmediately: false }
      : imported(request);
  };
})());
partial.tree.set(ROOT, [entry('partial.mp4')]);
const partialSession = sessionFor(partial, 'partial');
assert.equal((await partialSession.start()).files.length, 0);
await partialSession.activate();
assert.deepEqual(partial.events.map((event) => event.file.name), ['partial.mp4']);
await partialSession.stop();

const started = Promise.withResolvers<void>();
const release = Promise.withResolvers<void>();
let concurrentImports = 0;
let maximumConcurrentImports = 0;
const overlap = createHarness(async (request) => {
  concurrentImports += 1;
  maximumConcurrentImports = Math.max(maximumConcurrentImports, concurrentImports);
  started.resolve();
  await release.promise;
  concurrentImports -= 1;
  return imported(request);
});
const overlapSession = sessionFor(overlap, 'overlap');
await overlapSession.start();
await overlapSession.activate();
overlap.tree.set(ROOT, [entry('slow.mp4')]);
overlap.fireWatch();
await started.promise;
overlap.fireWatch();
overlap.fireWatch();
release.resolve();
while (overlap.events.length === 0) {
  const turn = Promise.withResolvers<void>();
  setImmediate(turn.resolve);
  await turn.promise;
}
await overlapSession.stop();
assert.equal(maximumConcurrentImports, 1, 'same-watcher event scans must remain single-flight');
assert.equal(overlap.events.length, 1, 'dirty reruns must not republish an unchanged file');

const stopStarted = Promise.withResolvers<void>();
const stopRelease = Promise.withResolvers<void>();
const stopping = createHarness(async (request) => {
  stopStarted.resolve();
  await stopRelease.promise;
  return imported(request);
});
const stoppingSession = sessionFor(stopping, 'stopping');
await stoppingSession.start();
await stoppingSession.activate();
stopping.tree.set(ROOT, [entry('cancelled.mp4')]);
stopping.fireWatch();
await stopStarted.promise;
const stopBarrier = stoppingSession.stop();
stopRelease.resolve();
await stopBarrier;
assert.equal(stopping.events.length, 0, 'stop must suppress post-close emission');
assert.deepEqual(
  stopping.removed,
  [[`${UPLOADS}/cancelled-mp4.mp4`]],
  'a copy completed after cancellation must be removed before stop resolves',
);
stopping.fireWatch();
assert.equal(stopping.events.length, 0, 'closed native watchers must not enqueue later scans');

const destination = createHarness();
const destinationSession = sessionFor(destination, 'destination');
await destinationSession.start();
destination.setDestination('/media/changed');
await assert.rejects(destinationSession.activate(), /media destination changed/);
destination.tree.set(ROOT, [entry('ignored.mp4')]);
destination.fireWatch();
assert.equal(destination.events.length, 0, 'MEDIA_DIR changes must stop the watch before publication');

const tooMany = Array.from({ length: 401 }, (_, index) => entry(`file-${index}.mp4`));
await assert.rejects(
  scanImportDirectory(ROOT, { readdir: async () => tooMany }),
  (error: unknown) => error instanceof DirectoryScanLimitError && error.kind === 'files',
  'the 400-file bound must be reported rather than treated as a complete scan',
);
await assert.rejects(
  scanImportDirectory(ROOT, {
    readdir: async (path) => [entry(`level-${path.split('/').length}`, 'directory')],
  }),
  (error: unknown) => error instanceof DirectoryScanLimitError && error.kind === 'depth',
  'the 12-level bound must be reported rather than treated as a complete scan',
);
assert.deepEqual(
  await scanImportDirectory(ROOT, { readdir: async () => [entry('escape.mp4', 'symlink')] }),
  [],
  'directory symlink entries must never become import candidates',
);

process.stdout.write('directory-watch.verify: lifecycle, barriers, retries, and bounds passed\n');
