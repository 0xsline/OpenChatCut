import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { FSWatcher } from 'node:fs';
import { join } from 'node:path';
import {
  createDirectoryWatchHandle,
  DirectoryScanLimitError,
  DirectoryWatchSession,
  scanImportDirectory,
  type DirectoryWatchDependencies,
} from './directory-watch.ts';
import type {
  DirectoryCandidateResult,
} from './directory-watch-import.ts';
import { ROOT, UPLOADS, createHarness, entry, imported, sessionFor, waitForCondition } from './directory-watch.verify-fixtures.ts';

const lifecycle = createHarness();
lifecycle.tree.set(ROOT, [entry('a.mp4')]);
const lifecycleSession = sessionFor(lifecycle, 'lifecycle');
const initial = await lifecycleSession.start();
assert.equal(initial.files.length, 1);
assert.equal(initial.files[0].name, 'a.mp4');
await lifecycleSession.acknowledge(initial.files[0].importId, 'reserved');
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

const committedPublication = createHarness();
committedPublication.tree.set(ROOT, [entry('committed.mp4')]);
const committedSession = sessionFor(committedPublication, 'committed-publication');
const committedStart = await committedSession.start();
const [committedFile] = committedStart.files;
assert.ok(committedFile);
await assert.rejects(
  committedSession.acknowledge(committedFile.importId, 'accepted'),
  /publication is not reserved/,
  'ownership cannot finalize before the renderer reserves the publication',
);
await committedSession.acknowledge(committedFile.importId, 'reserved');
await committedSession.acknowledge(committedFile.importId, 'accepted');
await committedSession.acknowledge(
  committedFile.importId,
  'accepted',
);
const reopenedProjectDoc = structuredClone({ assets: [{ src: committedFile.src }] });
await committedSession.stop();
assert.deepEqual(
  committedPublication.removed,
  [],
  'owner loss after an accepted acknowledgement must not unlink committed media',
);
assert.equal(
  reopenedProjectDoc.assets[0]?.src,
  committedFile.src,
  'a reopened ProjectDoc must retain its reachable committed publication reference',
);

const retiredReservation = createHarness();
retiredReservation.tree.set(ROOT, [entry('reserved-only.mp4')]);
const retiredReservationSession = sessionFor(retiredReservation, 'retired-reservation');
const retiredReservationStart = await retiredReservationSession.start();
const [retiredReservationFile] = retiredReservationStart.files;
assert.ok(retiredReservationFile);
await retiredReservationSession.acknowledge(retiredReservationFile.importId, 'reserved');
await retiredReservationSession.stop();
assert.deepEqual(
  retiredReservation.removed,
  [],
  'retirement conservatively retains a reservation that may already be referenced by ProjectDoc',
);
await retiredReservationSession.acknowledge(retiredReservationFile.importId, 'accepted');
await retiredReservationSession.acknowledge(retiredReservationFile.importId, 'accepted');
assert.deepEqual(retiredReservation.removed, [], 'accepted retirement reconciliation permanently retains bytes');
const retiredRejection = createHarness();
retiredRejection.tree.set(ROOT, [entry('rejected-after-retirement.mp4')]);
const retiredRejectionSession = sessionFor(retiredRejection, 'retired-rejection');
const retiredRejectionStart = await retiredRejectionSession.start();
const [retiredRejectionFile] = retiredRejectionStart.files;
assert.ok(retiredRejectionFile);
await retiredRejectionSession.acknowledge(retiredRejectionFile.importId, 'reserved');
await retiredRejectionSession.stop();
assert.deepEqual(retiredRejection.removed, [], 'retirement keeps the ambiguous reservation');
await retiredRejectionSession.acknowledge(retiredRejectionFile.importId, 'rejected');
await retiredRejectionSession.acknowledge(retiredRejectionFile.importId, 'rejected');
assert.deepEqual(
  retiredRejection.removed,
  [[`${UPLOADS}/rejected-after-retirement-mp4.mp4`]],
  'an explicit rejection cleans retired bytes exactly once',
);


const failedCommit = createHarness();
failedCommit.tree.set(ROOT, [entry('retryable.mp4')]);
const failedCommitSession = sessionFor(failedCommit, 'failed-commit');
const failedCommitStart = await failedCommitSession.start();
const [failedCommitFile] = failedCommitStart.files;
assert.ok(failedCommitFile);
const failedCommitStop = failedCommitSession.stop();
await assert.rejects(
  failedCommitSession.acknowledge(failedCommitFile.importId, 'reserved'),
  /directory watch is stopped/,
  'an acknowledgement that loses ownership before commit must fail',
);
await failedCommitStop;
assert.deepEqual(
  failedCommit.removed,
  [[`${UPLOADS}/retryable-mp4.mp4`]],
  'stop may clean a publication whose ownership reservation never committed',
);
const retryCommitSession = sessionFor(failedCommit, 'retry-commit');
const retryCommitStart = await retryCommitSession.start();
const [retryCommitFile] = retryCommitStart.files;
assert.ok(retryCommitFile);
await retryCommitSession.acknowledge(retryCommitFile.importId, 'reserved');
await retryCommitSession.acknowledge(retryCommitFile.importId, 'accepted');
await retryCommitSession.stop();
assert.deepEqual(
  failedCommit.removed,
  [[`${UPLOADS}/retryable-mp4.mp4`]],
  'a retry that commits must survive stop without a second unlink',
);

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
await setupSession.acknowledge(setupResult.files[0].importId, 'reserved');
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

const debounceEntered = Promise.withResolvers<void>();
const releaseDebounce = Promise.withResolvers<void>();
let debounceImports = 0;
const closingDuringDebounce = createHarness(async (request) => {
  debounceImports += 1;
  return imported(request);
});
const debounceSession = new DirectoryWatchSession({
  watchId: 'debounce-close',
  projectId: 'project-debounce-close',
  root: ROOT,
  pinnedUploadDirectory: UPLOADS,
  existingContentHashes: [],
  onImported: (event) => {
    closingDuringDebounce.events.push(event);
    return true;
  },
}, {
  ...closingDuringDebounce.dependencies,
  settleWrites: async () => {
    debounceEntered.resolve();
    await releaseDebounce.promise;
  },
});
await debounceSession.start();
await debounceSession.activate();
closingDuringDebounce.tree.set(ROOT, [entry('deleted-before-import.mp4')]);
closingDuringDebounce.fireWatch();
await debounceEntered.promise;
closingDuringDebounce.tree.delete(ROOT);
const debounceStop = debounceSession.stop();
assert.equal(debounceImports, 0, 'close during debounce must invalidate paths before import');
releaseDebounce.resolve();
await debounceStop;
assert.equal(closingDuringDebounce.events.length, 0, 'close during debounce must not emit a snapshot');

const vanishedErrors: unknown[] = [];
const vanished = createHarness(async (request) => {
  if (request.name === 'gone.mp4') {
    throw Object.assign(new Error('candidate vanished'), { code: 'ENOENT' });
  }
  return imported(request);
});
vanished.tree.set(ROOT, [entry('gone.mp4'), entry('valid.mp4')]);
const vanishedSession = new DirectoryWatchSession({
  watchId: 'vanished',
  projectId: 'project-vanished',
  root: ROOT,
  pinnedUploadDirectory: UPLOADS,
  existingContentHashes: [],
  onImported: (event) => {
    vanished.events.push(event);
    return true;
  },
  onFileError: (error) => { vanishedErrors.push(error); },
}, vanished.dependencies);
const vanishedStart = await vanishedSession.start();
assert.deepEqual(
  vanishedStart.files.map((file) => file.name),
  ['valid.mp4'],
  'a vanished candidate must not abort imports that remain valid',
);
assert.equal(vanishedErrors.length, 1, 'a vanished candidate must be reported individually');
await vanishedSession.acknowledge(vanishedStart.files[0].importId, 'reserved');
await vanishedSession.acknowledge(vanishedStart.files[0].importId, 'accepted');
await vanishedSession.stop();

let syncFallbackPolls = 0;
const syncFallbackHandle = createDirectoryWatchHandle(
  ROOT,
  () => { syncFallbackPolls += 1; },
  () => { throw Object.assign(new Error('UNKNOWN: unknown error, watch'), { code: 'UNKNOWN' }); },
  1,
);
await new Promise((resolve) => { setTimeout(resolve, 5); });
assert.equal(syncFallbackPolls, 0, 'polling fallback must wait for the session to request the next scan');
syncFallbackHandle.poll?.();
await waitForCondition(() => syncFallbackPolls > 0);
syncFallbackHandle.close();
const closedSyncFallbackPolls = syncFallbackPolls;
await new Promise((resolve) => { setTimeout(resolve, 5); });
assert.equal(syncFallbackPolls, closedSyncFallbackPolls, 'closing a polling fallback must stop future scans');

let asyncFallbackPolls = 0;
let asyncNativeClosed = false;
const asyncNativeWatcher = new EventEmitter() as EventEmitter & { close(): void };
asyncNativeWatcher.close = () => { asyncNativeClosed = true; };
const asyncFallbackHandle = createDirectoryWatchHandle(
  ROOT,
  () => { asyncFallbackPolls += 1; },
  () => asyncNativeWatcher as FSWatcher,
  1,
);
asyncNativeWatcher.emit('error', Object.assign(new Error('UNKNOWN: unknown error, watch'), { code: 'UNKNOWN' }));
await waitForCondition(() => asyncFallbackPolls > 0);
assert.equal(asyncFallbackPolls, 1, 'asynchronous native watcher failure must start polling without another scan');
assert.equal(asyncNativeClosed, true, 'a native watcher error must close the failed watcher before polling');
asyncFallbackHandle.close();

const cooperativePolling = createHarness();
let cooperativeListener = (): void => undefined;
let cooperativePolls = 0;
const cooperativeSession = new DirectoryWatchSession({
  watchId: 'cooperative-polling',
  projectId: 'project-cooperative-polling',
  root: ROOT,
  pinnedUploadDirectory: UPLOADS,
  existingContentHashes: [],
  onImported: (event) => {
    cooperativePolling.events.push(event);
    return true;
  },
}, {
  ...cooperativePolling.dependencies,
  watch: (_path, listener) => {
    cooperativeListener = listener;
    return {
      close: () => { cooperativeListener = () => undefined; },
      poll: () => { cooperativePolls += 1; },
    };
  },
});
await cooperativeSession.start();
assert.equal(cooperativePolls, 0, 'inactive fallback polling must not start before activation');
await cooperativeSession.activate();
assert.equal(cooperativePolls, 1, 'fallback polling must be requested after an active scan completes');
cooperativePolling.tree.set(ROOT, [entry('poll-created.mp4')]);
cooperativeListener();
while (cooperativePolling.events.length === 0) {
  const turn = Promise.withResolvers<void>();
  setImmediate(turn.resolve);
  await turn.promise;
}
assert.equal(cooperativePolls, 2, 'the next fallback poll must be scheduled only after the dirty scan finishes');
await cooperativeSession.stop();

const watcherFailures: unknown[] = [];
const watcherErrorHandle = new EventEmitter() as EventEmitter & { close(): void };
watcherErrorHandle.close = () => undefined;
const watcherError = createHarness();
const watcherErrorSession = new DirectoryWatchSession({
  watchId: 'watcher-error',
  projectId: 'project-watcher-error',
  root: ROOT,
  pinnedUploadDirectory: UPLOADS,
  existingContentHashes: [],
  onImported: (event) => {
    watcherError.events.push(event);
    return true;
  },
  onFatalError: (error) => { watcherFailures.push(error); },
}, {
  ...watcherError.dependencies,
  watch: () => watcherErrorHandle,
});
await watcherErrorSession.start();
watcherErrorHandle.emit('error', Object.assign(new Error('UNKNOWN: unknown error, watch'), { code: 'UNKNOWN' }));
const watcherErrorTurn = Promise.withResolvers<void>();
setImmediate(watcherErrorTurn.resolve);
await watcherErrorTurn.promise;
assert.equal(watcherFailures.length, 1, 'native watcher errors must be reported instead of escaping the main process');
assert.equal(watcherError.events.length, 0, 'a failed native watcher must not continue publishing files');
await assert.rejects(
  watcherErrorSession.activate(),
  /directory watch is not ready|unknown error, watch/i,
  'a native watcher failure must retire the session',
);

const firstReadyImport = Promise.withResolvers<void>();
const releaseFirstReadyImport = Promise.withResolvers<void>();
const secondReadyImport = Promise.withResolvers<void>();
const releaseSecondReadyImport = Promise.withResolvers<void>();
let readyImportCalls = 0;
const currentReady = createHarness(async (request) => {
  readyImportCalls += 1;
  if (readyImportCalls === 1) {
    firstReadyImport.resolve();
    await releaseFirstReadyImport.promise;
  } else if (readyImportCalls === 2) {
    secondReadyImport.resolve();
    await releaseSecondReadyImport.promise;
  }
  return imported(request);
});
currentReady.tree.set(ROOT, [entry('current.mp4')]);
const currentReadySession = sessionFor(currentReady, 'current-ready');
let readySettled = false;
const currentReadyStart = currentReadySession.start();
void currentReadyStart.then(
  () => { readySettled = true; },
  () => { readySettled = true; },
);
await firstReadyImport.promise;
currentReady.fireWatch();
releaseFirstReadyImport.resolve();
await secondReadyImport.promise;
assert.equal(readySettled, false, 'ready must wait for the current generation reconcile');
releaseSecondReadyImport.resolve();
const currentReadyResult = await currentReadyStart;
assert.deepEqual(currentReadyResult.files.map((file) => file.name), ['current.mp4']);
assert.deepEqual(
  currentReady.removed,
  [[`${UPLOADS}/current-mp4.mp4`]],
  'a superseded generation must clean its staged copy before ready',
);
await currentReadySession.acknowledge(currentReadyResult.files[0].importId, 'reserved');
await currentReadySession.acknowledge(currentReadyResult.files[0].importId, 'accepted');
await currentReadySession.stop();

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
const scanErrors: unknown[] = [];
assert.deepEqual(
  await scanImportDirectory(ROOT, {
    readdir: async (path) => {
      if (path === ROOT) return [entry('blocked', 'directory'), entry('survivor.mp4')];
      throw Object.assign(new Error('directory is inaccessible'), { code: 'EACCES' });
    },
  }, () => false, (error) => { scanErrors.push(error); }),
  [{ path: join(ROOT, 'survivor.mp4'), name: 'survivor.mp4' }],
  'an inaccessible nested directory must not discard readable sibling files',
);
assert.equal(scanErrors.length, 1, 'nested scan failures must be reported individually');

process.stdout.write('directory-watch.verify: lifecycle, barriers, retries, and bounds passed\n');
