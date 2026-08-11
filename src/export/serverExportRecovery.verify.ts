// Export recovery keeps server stages authoritative while IndexedDB retains
// browser FileSystemHandle authority. This verifier covers monotonic legacy
// reconciliation, tombstones, ready contention, leases, and late rebinds.
import assert from 'node:assert/strict';
import type { TimelineState } from '../editor/types';
import {
  createExportRecoveryLeaseOperation,
  type ExportRecoveryLeaseInput,
} from '../../server/plugins/project-store-export-recovery';
import type { LockedProjectStore } from '../../server/plugins/project-store';
import type { ExportDestination } from './exportDestination';
import {
  claimServerExportDelivery,
  listServerExportJobs,
  markServerExportOutputReady,
  markServerExportTargetCommitted,
  persistServerExportJob,
  releaseServerExportDelivery,
  resetServerExportRecoveryMemory,
  retireServerExportJob,
  type PersistedServerExportJob,
} from './serverExportRecovery';

const requests: Array<{ request: unknown }> = [];
const indexedDbRows = new Map<string, unknown>();
const originalIndexedDbDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB');
let transportOutage = false;

interface FakeRequest<Result> {
  result: Result;
  error: Error | null;
  onsuccess: (() => void) | null;
  onerror: (() => void) | null;
}

interface FakeTransaction {
  oncomplete: (() => void) | null;
  onerror: (() => void) | null;
  onabort: (() => void) | null;
  error: Error | null;
  objectStore(): {
    put(value: unknown): void;
    delete(key: string): void;
    get(key: string): FakeRequest<unknown>;
    getAll(): FakeRequest<unknown[]>;
  };
}

function installIndexedDb(): void {
  const database = {
    close: () => undefined,
    transaction: (): FakeTransaction => {
      const transaction: FakeTransaction = {
        oncomplete: null,
        onerror: null,
        onabort: null,
        error: null,
        objectStore: () => ({
          put: (value) => {
            if (!value || typeof value !== 'object' || !('renderId' in value)
              || typeof value.renderId !== 'string') {
              throw new Error('fake IndexedDB row requires renderId');
            }
            indexedDbRows.set(value.renderId, value);
          },
          delete: (key) => { indexedDbRows.delete(key); },
          get: (key) => {
            const request: FakeRequest<unknown> = {
              result: indexedDbRows.get(key),
              error: null,
              onsuccess: null,
              onerror: null,
            };
            queueMicrotask(() => request.onsuccess?.());
            return request;
          },
          getAll: () => {
            const request: FakeRequest<unknown[]> = {
              result: [...indexedDbRows.values()],
              error: null,
              onsuccess: null,
              onerror: null,
            };
            queueMicrotask(() => request.onsuccess?.());
            return request;
          },
        }),
      };
      queueMicrotask(() => transaction.oncomplete?.());
      return transaction;
    },
  };
  const factory = {
    open: () => {
      const request = {
        result: database,
        error: null,
        onsuccess: null as (() => void) | null,
        onerror: null as (() => void) | null,
        onblocked: null as (() => void) | null,
        onupgradeneeded: null as (() => void) | null,
      };
      queueMicrotask(() => request.onsuccess?.());
      return request;
    },
  };
  Object.defineProperty(globalThis, 'indexedDB', {
    configurable: true,
    value: factory,
  });
}


interface FakeProjectStoreRequest {
  operation: string;
  key?: string;
  value?: unknown;
  entries?: Record<string, unknown>;
  action?: string;
  authorityEstablished?: boolean;
  ownerInstanceId?: string;
  leaseToken?: string;
  leaseMs?: number;
  renderId?: string;
}

function fakeRecoveryOperation(store: Record<string, unknown>) {
  const locked: LockedProjectStore = {
    readEntry: async (key) => Object.hasOwn(store, key)
      ? { found: true, value: store[key] }
      : { found: false },
    writeEntry: async (key, value) => { store[key] = value; },
    writeAgentRuntimeExact: async (key, value) => { store[key] = value; },
    writeEntryExact: async (key, value) => { store[key] = value; },
    removeEntry: async (key) => { delete store[key]; },
  };
  let serialized = Promise.resolve();
  return createExportRecoveryLeaseOperation(async (work) => {
    const result = serialized.then(() => work(locked));
    serialized = result.then(() => undefined, () => undefined);
    return result;
  });
}

function installTransport(store: Record<string, unknown>): void {
  requests.length = 0;
  const mutateRecovery = fakeRecoveryOperation(store);
  (globalThis as Record<string, unknown>).window = {
    openChatCutDesktop: {
      projectStore: async (request: FakeProjectStoreRequest) => {
        if (transportOutage) throw new Error('project store unavailable');
        requests.push({ request });
        if (request.operation === 'export-recovery-lease') {
          return mutateRecovery(request as ExportRecoveryLeaseInput);
        }
        if (request.operation === 'entry') {
          const key = request.key ?? '';
          return Object.hasOwn(store, key)
            ? { found: true, value: store[key] }
            : { found: false };
        }
        if (request.operation === 'set' || request.operation === 'delete') {
          throw new Error('generic export recovery mutation is forbidden');
        }
        if (request.operation === 'snapshot') {
          return { version: 1, entries: store };
        }
        return { ok: true };
      },
    },
  };
}

function uninstallTransport(): void {
  delete (globalThis as Record<string, unknown>).window;
}

function record(
  renderId: string,
  projectId: string,
  destination: ExportDestination = { type: 'downloads', label: 'downloads' },
): PersistedServerExportJob {
  return {
    version: 1,
    renderId,
    projectId,
    label: `job-${renderId}`,
    targetPath: null,
    createdAt: 1,
    updatedAt: 1,
    format: 'video',
    codec: 'h264',
    base: 'base',
    fps: 30,
    state: { fps: 30, width: 1920, height: 1080, items: [], selectedId: null } as unknown as TimelineState,
    destination,
    autoQaEnabled: false,
    stage: 'polling',
  };
}

async function verifyDurableDeliveryLeaseExclusion(): Promise<void> {
  const rows = new Map<string, unknown>();
  const retained = record('lease-render', 'lease-project');
  rows.set('export-recovery:lease-render', retained);
  const store: LockedProjectStore = {
    readEntry: async (key) => rows.has(key)
      ? { found: true, value: rows.get(key) }
      : { found: false },
    writeEntry: async (key, value) => { rows.set(key, value); },
    writeAgentRuntimeExact: async (key, value) => { rows.set(key, value); },
    writeEntryExact: async (key, value) => { rows.set(key, value); },
    removeEntry: async (key) => { rows.delete(key); },
  };
  let serialized = Promise.resolve();
  const mutate = createExportRecoveryLeaseOperation(async (work) => {
    const result = serialized.then(() => work(store));
    serialized = result.then(() => undefined, () => undefined);
    return result;
  });
  const request = (ownerInstanceId: string) => ({
    operation: 'export-recovery-lease' as const,
    key: 'export-recovery:lease-render',
    renderId: 'lease-render',
    action: 'claim' as const,
    ownerInstanceId,
    leaseMs: 60_000,
  });
  const [first, second] = await Promise.all([mutate(request('tab-a')), mutate(request('tab-b'))]);
  assert.equal(Number(first.accepted) + Number(second.accepted), 1,
    'one durable retained output can have only one delivery owner');
  const loser = first.accepted ? 'tab-b' : 'tab-a';
  assert.equal((await mutate(request(loser))).accepted, false,
    'a second tab cannot deliver while the first lease is live');
  const winner = first.accepted ? first : second;
  const ready = await mutate({
    operation: 'export-recovery-lease',
    key: 'export-recovery:lease-render',
    renderId: 'lease-render',
    action: 'ready',
    ownerInstanceId: loser,
  });
  assert.equal(ready.accepted, true, 'a competing ready observation is idempotent');
  const readyRecord = rows.get('export-recovery:lease-render') as PersistedServerExportJob;
  assert.equal(readyRecord.stage, 'output-ready');
  assert.equal(readyRecord.deliveryClaim?.leaseToken, winner.lease?.leaseToken,
    'ready must preserve the winning live claim');
  assert.equal((await mutate({
    operation: 'export-recovery-lease',
    key: 'export-recovery:lease-render',
    renderId: 'lease-render',
    action: 'ready',
    ownerInstanceId: loser,
  })).accepted, true, 'ready remains idempotent after output-ready');
  const winnerOwner = first.accepted ? 'tab-a' : 'tab-b';
  const rebound = await mutate({
    operation: 'export-recovery-lease',
    key: 'export-recovery:lease-render',
    renderId: 'lease-render',
    action: 'rebind',
    ownerInstanceId: winnerOwner,
    leaseToken: winner.lease?.leaseToken,
    value: { ...readyRecord, targetPath: 'late-rebind.mp4' },
  });
  assert.equal(rebound.accepted, true,
    'an unresolved output older than the one-hour retention window remains rebindable');
}

async function main(): Promise<void> {
  const serverStore: Record<string, unknown> = {};
  installTransport(serverStore);
  resetServerExportRecoveryMemory();
  indexedDbRows.clear();
  installIndexedDb();
  await verifyDurableDeliveryLeaseExclusion();

  // Browser handle authority is always kept in IndexedDB, while the remote
  // stage is JSON-safe and is joined to that handle after a refresh.
  const browserHandle: Extract<ExportDestination, { type: 'browser-directory' }>['handle'] = {
    kind: 'directory',
    name: 'Exports',
    queryPermission: async () => 'granted',
    requestPermission: async () => 'granted',
    getFileHandle: async () => ({
      createWritable: async () => ({
        write: async () => undefined,
        close: async () => undefined,
      }),
    }),
  };
  await persistServerExportJob(record('render-browser', 'project-browser', {
    type: 'browser-directory',
    label: 'Exports',
    handle: browserHandle,
  }));
  const remoteBrowser = serverStore['export-recovery:render-browser'] as PersistedServerExportJob;
  assert.equal(remoteBrowser.destination.type, 'browser-directory');
  if (remoteBrowser.destination.type !== 'browser-directory') throw new Error('expected browser descriptor');
  assert.equal(remoteBrowser.destination.handle, null, 'remote stage must never serialize FileSystemHandle authority');
  assert.doesNotThrow(() => JSON.stringify(remoteBrowser), 'remote recovery stage must remain JSON-safe');
  const localBrowser = indexedDbRows.get('render-browser') as PersistedServerExportJob;
  assert.equal(localBrowser.destination.type, 'browser-directory');
  if (localBrowser.destination.type !== 'browser-directory') throw new Error('expected local browser destination');
  assert.equal(localBrowser.destination.handle, browserHandle, 'IndexedDB must retain the live handle after remote success');
  resetServerExportRecoveryMemory();
  const refreshedBrowser = (await listServerExportJobs('project-browser'))[0]!;
  assert.equal(refreshedBrowser.destination.type, 'browser-directory');
  if (refreshedBrowser.destination.type !== 'browser-directory') throw new Error('expected refreshed browser destination');
  assert.equal(refreshedBrowser.destination.handle, browserHandle, 'refresh must join remote stage with local authority');
  indexedDbRows.delete('render-browser');
  const withoutLocalAuthority = (await listServerExportJobs('project-browser'))[0]!;
  assert.equal(withoutLocalAuthority.destination.type, 'browser-directory');
  if (withoutLocalAuthority.destination.type !== 'browser-directory') {
    throw new Error('expected browser descriptor without local authority');
  }
  assert.equal(withoutLocalAuthority.destination.handle, null,
    'a cache wipe must expose a reselection descriptor instead of dropping the recovery stage');
  requests.length = 0;


  // ── initial persistence uses the server-locked one-time reconcile operation ──
  await persistServerExportJob(record('render-1', 'project-a'));
  assert.equal(requests.length, 1);
  const reconcileRequest = requests[0]!.request as FakeProjectStoreRequest;
  assert.equal(reconcileRequest.operation, 'export-recovery-lease');
  assert.equal(reconcileRequest.action, 'reconcile');
  assert.equal(reconcileRequest.authorityEstablished, false);

  // ── ready + lease + committed are atomic server-side transitions ──
  await markServerExportOutputReady('render-1');
  const deliveryClaim = await claimServerExportDelivery('render-1');
  assert.ok(deliveryClaim);
  await markServerExportTargetCommitted('render-1', deliveryClaim);
  const updated = serverStore['export-recovery:render-1'] as PersistedServerExportJob;
  assert.equal(updated.stage, 'target-committed');
  await releaseServerExportDelivery('render-1', deliveryClaim);

  // ── a newer stale local timestamp cannot rewind server output-ready authority ──
  await persistServerExportJob(record('render-stale', 'project-stale', {
    type: 'browser-directory',
    label: 'Exports',
    handle: browserHandle,
  }));
  await markServerExportOutputReady('render-stale');
  const staleLocal = indexedDbRows.get('render-stale') as PersistedServerExportJob;
  indexedDbRows.set('render-stale', { ...staleLocal, stage: 'polling', updatedAt: Number.MAX_SAFE_INTEGER });
  const staleListed = (await listServerExportJobs('project-stale'))[0]!;
  assert.equal(staleListed.stage, 'output-ready');
  assert.equal((serverStore['export-recovery:render-stale'] as PersistedServerExportJob).stage, 'output-ready',
    'local reconciliation must never rewrite authoritative remote stage');

  // ── a genuinely local legacy row is promoted once through reconcile ──
  uninstallTransport();
  await persistServerExportJob(record('render-legacy', 'project-a'));
  installTransport(serverStore);
  const withLegacy = await listServerExportJobs('project-a');
  assert.ok(withLegacy.some((job) => job.renderId === 'render-legacy'));
  const promoted = indexedDbRows.get('render-legacy') as PersistedServerExportJob;
  assert.equal(promoted.remoteAuthorityEstablished, true);

  // ── once remote authority existed, a missing row becomes a durable tombstone ──
  await persistServerExportJob(record('render-tombstone', 'project-tombstone', {
    type: 'browser-directory',
    label: 'Exports',
    handle: browserHandle,
  }));
  delete serverStore['export-recovery:render-tombstone'];
  assert.deepEqual(await listServerExportJobs('project-tombstone'), []);
  const tombstone = serverStore['export-recovery:render-tombstone'] as Record<string, unknown>;
  assert.equal(tombstone.stage, 'retired');
  assert.equal(indexedDbRows.has('render-tombstone'), false);

  // ── explicit retirement is durable and idempotent ──
  assert.equal(await retireServerExportJob('render-1'), true);
  assert.equal((serverStore['export-recovery:render-1'] as Record<string, unknown>).stage, 'retired');
  assert.equal(await retireServerExportJob('render-1'), true);

  console.log('✓ export-recovery store verify: monotonic reconcile + claims + tombstones passed');

}

void main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    transportOutage = false;
    if (originalIndexedDbDescriptor) Object.defineProperty(globalThis, 'indexedDB', originalIndexedDbDescriptor);
    else Reflect.deleteProperty(globalThis, 'indexedDB');
  });
