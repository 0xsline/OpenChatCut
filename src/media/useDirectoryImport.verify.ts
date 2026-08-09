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
  assert.ok(log.indexOf('ingest:asset-initial') < log.indexOf('activate:watch-a'), 'initial files ingest before activation');
  assert.ok(log.indexOf('ack:initial:accepted') < log.indexOf('activate:watch-a'), 'initial descriptors are acknowledged before activation');

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
