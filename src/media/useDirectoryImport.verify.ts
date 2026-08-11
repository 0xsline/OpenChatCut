import assert from 'node:assert/strict';
import type { DirectoryImportedFile, DirectoryImportEvent } from '../../shared/directory-import';
import type { MediaAsset } from '../editor/types';
import {
  DirectoryImportRuntime,
  bindDirectoryImportRuntime,
  type DirectoryImportDesktopApi,
} from './useDirectoryImport';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const HASH_C = 'c'.repeat(64);

function descriptor(importId: string, contentHash: string): DirectoryImportedFile {
  return {
    importId,
    name: `${importId}.mp4`,
    src: `/media/uploads/${importId}.mp4`,
    storedName: `${importId}.mp4`,
    contentHash,
    kind: 'video',
    size: 1024,
    sourceModifiedAt: 1_725_000_000_000,
    durationSeconds: 2,
    compatibilityNormalized: true,
  };
}

function assetOf(file: DirectoryImportedFile, id = `asset-${file.importId}`): MediaAsset {
  return {
    id,
    name: file.name,
    sourceFilename: file.name,
    kind: file.kind,
    src: file.src,
    durationInFrames: 60,
    sourceRevision: `source-sha256-${file.contentHash}`,
    sourceContentHash: file.contentHash,
    sourceSize: file.size,
    sourceModifiedAt: file.sourceModifiedAt,
  };
}

function deferred<T>() {
  const result = Promise.withResolvers<T>();
  return result;
}

{
  const log: string[] = [];
  const errors: unknown[] = [];
  const assets: MediaAsset[] = [assetOf(descriptor('existing', HASH_A))];
  let projectId = 'project-a';
  const initial = descriptor('initial', HASH_B);
  const api: DirectoryImportDesktopApi = {
    startImportDirectoryWatch: async (requestedProjectId, hashes) => {
      log.push(`start:${requestedProjectId}:${hashes.join(',')}`);
      return { watchId: 'watch-a', projectId: 'project-a', directoryName: 'Shots', files: [initial] };
    },
    activateImportDirectoryWatch: async (watchId) => { log.push(`activate:${watchId}`); },
    acknowledgeImportDirectoryFile: async (_watchId, importId, disposition) => {
      log.push(`ack:${importId}:${disposition}`);
    },
    stopImportDirectoryWatch: async (watchId) => { log.push(`stop:${watchId}`); },
    subscribeImportDirectory: () => () => undefined,
  };
  const runtime = new DirectoryImportRuntime({
    api,
    getProjectId: () => projectId,
    getFps: () => 30,
    getAssets: () => assets,
    ingest: (asset) => { log.push(`ingest:${asset.id}`); assets.push(asset); },
    convert: async (file) => { log.push(`convert:${file.importId}`); return assetOf(file); },
    onWatchChange: () => undefined,
    onBusyChange: () => undefined,
    onError: (reason) => errors.push(reason),
  });

  await runtime.start();
  assert.match(log[0] ?? '', new RegExp(`start:project-a:${HASH_A}`), 'watch start is seeded with live content hashes');
  assert.ok(log.indexOf('ack:initial:reserved') < log.indexOf('ingest:asset-initial'), 'main-process reservation precedes ProjectDoc ingest');
  assert.ok(log.indexOf('ingest:asset-initial') < log.indexOf('ack:initial:accepted'), 'successful ProjectDoc ingest precedes ownership finalization');
  assert.ok(log.indexOf('ack:initial:accepted') < log.indexOf('activate:watch-a'), 'initial descriptors finalize before activation');

  const liveDuplicate = descriptor('live-duplicate', HASH_B);
  runtime.handleEvent({ watchId: 'watch-a', projectId: 'project-a', file: liveDuplicate });
  await runtime.settle();
  assert.ok(log.includes('ack:live-duplicate:duplicate'), 'same-watch live duplicates are discarded');
  assert.equal(assets.filter((asset) => asset.sourceContentHash === HASH_B).length, 1);

  assets.push(assetOf(descriptor('concurrent-normal-import', HASH_C)));
  runtime.handleEvent({
    watchId: 'watch-a', projectId: 'project-a', file: descriptor('live-assets-duplicate', HASH_C),
  });
  await runtime.settle();
  assert.ok(log.includes('ack:live-assets-duplicate:duplicate'), 'final mutation dedupes against current live assets');

  runtime.handleEvent({
    watchId: 'watch-a', projectId: 'project-b', file: descriptor('wrong-project', 'd'.repeat(64)),
  });
  await runtime.settle();
  assert.ok(log.includes('ack:wrong-project:rejected'), 'events are filtered by both watch and project id');

  projectId = 'project-b';
  runtime.handleEvent({
    watchId: 'watch-a', projectId: 'project-a', file: descriptor('stale-project', 'e'.repeat(64)),
  });
  await runtime.settle();
  assert.ok(log.includes('ack:stale-project:rejected'), 'project changes reject queued old-project events');
  assert.equal(assets.some((asset) => asset.id === 'asset-stale-project'), false);
  assert.deepEqual(errors, []);
  await runtime.stop();
  assert.ok(log.includes('stop:watch-a'), 'project switch/unmount cleanup stops the active watcher');
}

{
  const gate = deferred<MediaAsset>();
  const log: string[] = [];
  const subscription: { current: ((event: DirectoryImportEvent) => void) | null } = { current: null };
  const api: DirectoryImportDesktopApi = {
    startImportDirectoryWatch: async () => ({
      watchId: 'watch-barrier', projectId: 'project-a', directoryName: 'Barrier', files: [],
    }),
    activateImportDirectoryWatch: async () => undefined,
    acknowledgeImportDirectoryFile: async (_watchId, importId, disposition) => {
      log.push(`ack:${importId}:${disposition}`);
    },
    stopImportDirectoryWatch: async () => { log.push('stopped'); },
    subscribeImportDirectory: (listener) => { subscription.current = listener; return () => { subscription.current = null; }; },
  };
  const runtime = new DirectoryImportRuntime({
    api,
    getProjectId: () => 'project-a',
    getFps: () => 30,
    getAssets: () => [],
    ingest: () => log.push('ingested'),
    convert: async () => gate.promise,
    onWatchChange: () => undefined,
    onBusyChange: () => undefined,
    onError: (reason) => { throw reason; },
  });
  await runtime.start();
  const cleanup = bindDirectoryImportRuntime(api, runtime);
  assert.equal(typeof subscription.current, 'function');
  subscription.current?.({
    watchId: 'watch-barrier', projectId: 'project-a', file: descriptor('pending', 'f'.repeat(64)),
  });
  const stopping = cleanup();
  assert.equal(subscription.current, null, 'API replacement/unmount cleanup unsubscribes immediately');
  await Promise.resolve();
  assert.equal(log.includes('stopped'), false, 'stop waits for an in-flight descriptor barrier');
  gate.resolve(assetOf(descriptor('pending', 'f'.repeat(64))));
  await stopping;
  assert.equal(log.includes('ingested'), false, 'cancellation wins before final mutation');
  assert.deepEqual(log, ['ack:pending:rejected', 'stopped']);
  assert.equal(subscription.current, null, 'subscription cleanup remains available to the hook owner');
}

{
  const file = descriptor('committed-before-ingest', '1'.repeat(64));
  const publishedFiles = new Set([file.src]);
  const persistedProjectAssets: MediaAsset[] = [];
  let committed = false;
  const api: DirectoryImportDesktopApi = {
    startImportDirectoryWatch: async () => ({
      watchId: 'watch-committed', projectId: 'project-a', directoryName: 'Committed', files: [file],
    }),
    activateImportDirectoryWatch: async () => undefined,
    acknowledgeImportDirectoryFile: async (_watchId, importId, disposition) => {
      assert.equal(importId, file.importId);
      assert.ok(disposition === 'reserved' || disposition === 'accepted');
      if (disposition === 'accepted') committed = true;
    },
    stopImportDirectoryWatch: async () => {
      if (!committed) publishedFiles.delete(file.src);
    },
    subscribeImportDirectory: () => () => undefined,
  };
  const runtime = new DirectoryImportRuntime({
    api,
    getProjectId: () => 'project-a',
    getFps: () => 30,
    getAssets: () => persistedProjectAssets,
    ingest: (asset) => persistedProjectAssets.push(asset),
    convert: async (candidate) => assetOf(candidate),
    onWatchChange: () => undefined,
    onBusyChange: () => undefined,
    onError: (reason) => { throw reason; },
  });

  await runtime.start();
  assert.equal(persistedProjectAssets.length, 1, 'committed publication is exposed to ProjectDoc exactly once');
  await runtime.stop();
  assert.equal(publishedFiles.has(file.src), true, 'owner loss must not unlink an accepted publication');
  const [reopenedAsset] = structuredClone(persistedProjectAssets);
  assert.ok(reopenedAsset);
  assert.equal(
    publishedFiles.has(reopenedAsset.src),
    true,
    'a reopened ProjectDoc reference remains backed by committed media',
  );
}

{
  const contentHash = '2'.repeat(64);
  const failedFile = descriptor('failed-commit', contentHash);
  const assets: MediaAsset[] = [];
  const errors: unknown[] = [];
  let uncommittedPublication = true;
  let abandonedPublicationCleaned = false;
  const failedApi: DirectoryImportDesktopApi = {
    startImportDirectoryWatch: async () => ({
      watchId: 'watch-failed-commit',
      projectId: 'project-a',
      directoryName: 'Failed commit',
      files: [failedFile],
    }),
    activateImportDirectoryWatch: async () => undefined,
    acknowledgeImportDirectoryFile: async (_watchId, _importId, disposition) => {
      assert.equal(disposition, 'reserved');
      throw new Error('simulated reservation acknowledgement failure');
    },
    stopImportDirectoryWatch: async () => {
      if (uncommittedPublication) {
        uncommittedPublication = false;
        abandonedPublicationCleaned = true;
      }
    },
    subscribeImportDirectory: () => () => undefined,
  };
  const failedRuntime = new DirectoryImportRuntime({
    api: failedApi,
    getProjectId: () => 'project-a',
    getFps: () => 30,
    getAssets: () => assets,
    ingest: (asset) => assets.push(asset),
    convert: async (candidate) => assetOf(candidate),
    onWatchChange: () => undefined,
    onBusyChange: () => undefined,
    onError: (reason) => errors.push(reason),
  });

  await failedRuntime.start();
  assert.equal(assets.length, 0, 'a failed main-process reservation must not expose an asset');
  assert.equal(errors.length, 1);
  await failedRuntime.stop();
  assert.equal(abandonedPublicationCleaned, true, 'a failed reservation remains safely cleanable');

  const retryFile = descriptor('retry-after-failed-commit', contentHash);
  let retryCommitted = false;
  const retryApi: DirectoryImportDesktopApi = {
    startImportDirectoryWatch: async () => ({
      watchId: 'watch-retry', projectId: 'project-a', directoryName: 'Retry', files: [retryFile],
    }),
    activateImportDirectoryWatch: async () => undefined,
    acknowledgeImportDirectoryFile: async (_watchId, _importId, disposition) => {
      assert.ok(disposition === 'reserved' || disposition === 'accepted');
      if (disposition === 'accepted') retryCommitted = true;
    },
    stopImportDirectoryWatch: async () => undefined,
    subscribeImportDirectory: () => () => undefined,
  };
  const retryRuntime = new DirectoryImportRuntime({
    api: retryApi,
    getProjectId: () => 'project-a',
    getFps: () => 30,
    getAssets: () => assets,
    ingest: (asset) => assets.push(asset),
    convert: async (candidate) => assetOf(candidate),
    onWatchChange: () => undefined,
    onBusyChange: () => undefined,
    onError: (reason) => { throw reason; },
  });
  await retryRuntime.start();
  assert.equal(retryCommitted, true);
  assert.equal(assets.length, 1, 'cleaned failed publications remain retryable without duplicate ingest');
  await retryRuntime.stop();
}

{
  const reserveEntered = deferred<void>();
  const releaseReserve = deferred<void>();
  const assets: MediaAsset[] = [];
  const dispositions: string[] = [];
  let projectId = 'project-a';
  let publicationExists = true;
  const file = descriptor('delayed-reserve', '3'.repeat(64));
  const api: DirectoryImportDesktopApi = {
    startImportDirectoryWatch: async () => ({
      watchId: 'watch-delayed-reserve',
      projectId: 'project-a',
      directoryName: 'Delayed reserve',
      files: [file],
    }),
    activateImportDirectoryWatch: async () => undefined,
    acknowledgeImportDirectoryFile: async (_watchId, _importId, disposition) => {
      dispositions.push(disposition);
      if (disposition === 'reserved') {
        reserveEntered.resolve();
        await releaseReserve.promise;
      } else if (disposition === 'rejected') {
        publicationExists = false;
      } else {
        assert.fail(`unexpected disposition after project switch: ${disposition}`);
      }
    },
    stopImportDirectoryWatch: async () => {
      if (publicationExists) publicationExists = false;
    },
    subscribeImportDirectory: () => () => undefined,
  };
  const runtime = new DirectoryImportRuntime({
    api,
    getProjectId: () => projectId,
    getFps: () => 30,
    getAssets: () => assets,
    ingest: (asset) => assets.push(asset),
    convert: async (candidate) => assetOf(candidate),
    onWatchChange: () => undefined,
    onBusyChange: () => undefined,
    onError: (reason) => { throw reason; },
  });

  const starting = runtime.start();
  await reserveEntered.promise;
  projectId = 'project-b';
  const stopping = runtime.stop();
  releaseReserve.resolve();
  await Promise.all([starting, stopping]);
  assert.deepEqual(
    dispositions,
    ['reserved', 'rejected'],
    'a project switch during reservation rolls back before watcher stop',
  );
  assert.equal(assets.length, 0, 'a stale delayed reservation must never reach ProjectDoc');
  assert.equal(publicationExists, false, 'a stale reservation remains safely cleanable');
}

{
  const finalizeEntered = deferred<void>();
  const releaseFinalize = deferred<void>();
  const assets: MediaAsset[] = [];
  const errors: unknown[] = [];
  const file = descriptor('delayed-finalize', '4'.repeat(64));
  let acceptedAttempts = 0;
  let committed = false;
  const publicationExists = true;
  let retired = false;
  const api: DirectoryImportDesktopApi = {
    startImportDirectoryWatch: async () => ({
      watchId: 'watch-delayed-finalize',
      projectId: 'project-a',
      directoryName: 'Delayed finalize',
      files: [file],
    }),
    activateImportDirectoryWatch: async () => undefined,
    acknowledgeImportDirectoryFile: async (_watchId, _importId, disposition) => {
      if (disposition === 'reserved') return;
      assert.equal(disposition, 'accepted');
      acceptedAttempts += 1;
      if (acceptedAttempts === 1) {
        finalizeEntered.resolve();
        await releaseFinalize.promise;
      }
      if (acceptedAttempts <= 2) throw new Error('simulated finalize transport failure');
      assert.equal(retired, true, 'final reconciliation addresses the retired publication grant');
      committed = true;
    },
    stopImportDirectoryWatch: async () => {
      retired = true;
    },
    subscribeImportDirectory: () => () => undefined,
  };
  const runtime = new DirectoryImportRuntime({
    api,
    getProjectId: () => 'project-a',
    getFps: () => 30,
    getAssets: () => assets,
    ingest: (asset) => assets.push(asset),
    convert: async (candidate) => assetOf(candidate),
    onWatchChange: () => undefined,
    onBusyChange: () => undefined,
    onError: (reason) => errors.push(reason),
  });

  const starting = runtime.start();
  await finalizeEntered.promise;
  assert.equal(assets.length, 1, 'ProjectDoc mutation completes before ownership finalization');
  const stopping = runtime.stop();
  assert.equal(retired, false, 'stop waits behind the two in-flight finalization attempts');
  releaseFinalize.resolve();
  await Promise.all([starting, stopping]);
  assert.equal(acceptedAttempts, 3, 'retirement reconciles a publication after both initial acknowledgements fail');
  assert.equal(committed, true, 'the retired reservation is finalized idempotently');
  assert.equal(publicationExists, true, 'no side effect can observe deleted bytes after ProjectDoc ingest');
  assert.equal(errors.length, 2, 'both initial transport failures remain observable');
}

{
  const file = descriptor('failed-ingest', '5'.repeat(64));
  const dispositions: string[] = [];
  const errors: unknown[] = [];
  let publicationExists = true;
  const api: DirectoryImportDesktopApi = {
    startImportDirectoryWatch: async () => ({
      watchId: 'watch-failed-ingest',
      projectId: 'project-a',
      directoryName: 'Failed ingest',
      files: [file],
    }),
    activateImportDirectoryWatch: async () => undefined,
    acknowledgeImportDirectoryFile: async (_watchId, _importId, disposition) => {
      dispositions.push(disposition);
      if (disposition === 'rejected') publicationExists = false;
    },
    stopImportDirectoryWatch: async () => {
      if (publicationExists) publicationExists = false;
    },
    subscribeImportDirectory: () => () => undefined,
  };
  const runtime = new DirectoryImportRuntime({
    api,
    getProjectId: () => 'project-a',
    getFps: () => 30,
    getAssets: () => [],
    ingest: () => { throw new Error('simulated ProjectDoc mutation failure'); },
    convert: async (candidate) => assetOf(candidate),
    onWatchChange: () => undefined,
    onBusyChange: () => undefined,
    onError: (reason) => errors.push(reason),
  });

  await runtime.start();
  assert.deepEqual(dispositions, ['reserved', 'rejected']);
  assert.equal(publicationExists, false, 'ingest failure rolls back its reservation');
  assert.equal(errors.length, 1);
  await runtime.stop();
}
