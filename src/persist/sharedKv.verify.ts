import assert from 'node:assert/strict';
import { kvDel, kvGet, kvGetFresh, kvKeys, kvRemoteMode, kvSet, resetSharedKvMemory } from './sharedKv';
import { mergeProjectEntries } from '../../server/plugins/project-store-entries';
import { CURRENT_PROJECT_VERSION } from '../../shared/project-version';
import { loadProjectForEditing, migrateProjectDoc } from './projectStore';
import { v1 } from './migrations/migrations.verify.fixtures';
import { recoverUnmergedProjects, type StoreSnapshot } from './sharedKvRecovery';

const MIGRATION_KEY = '__openchatcut_shared_store_v1__';
const PENDING_KEYS_KEY = '__openchatcut_shared_pending_v1__';
const globals = globalThis as typeof globalThis & Record<string, unknown>;
const savedGlobals = new Map<string, PropertyDescriptor | undefined>();
for (const name of ['fetch', 'history', 'indexedDB', 'location', 'sessionStorage', 'window']) {
  savedGlobals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
}

function installGlobal(name: string, value: unknown): void {
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
}

function restoreGlobals(): void {
  for (const [name, descriptor] of savedGlobals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
}

function asyncRequest<T>(read: () => T): IDBRequest<T> {
  const request = { error: null, onerror: null, onsuccess: null } as unknown as IDBRequest<T>;
  queueMicrotask(() => {
    try {
      Reflect.set(request, 'result', read());
      request.onsuccess?.(new Event('success'));
    } catch (error) {
      Reflect.set(request, 'error', error);
      request.onerror?.(new Event('error'));
    }
  });
  return request;
}

function fakeIndexedDb(values: Map<string, unknown>): IDBFactory {
  const db = {
    createObjectStore: () => ({} as IDBObjectStore),
    transaction: () => {
      const transaction = {
        error: null,
        oncomplete: null,
        onerror: null,
      } as unknown as IDBTransaction;
      const complete = (): void => queueMicrotask(() => transaction.oncomplete?.(new Event('complete')));
      const objectStore = {
        get: (key: IDBValidKey) => asyncRequest(() => values.get(String(key))),
        getAllKeys: () => asyncRequest(() => [...values.keys()]),
        put: (value: unknown, key?: IDBValidKey) => {
          values.set(String(key), value);
          complete();
          return {} as IDBRequest<IDBValidKey>;
        },
        delete: (key: IDBValidKey) => {
          values.delete(String(key));
          complete();
          return {} as IDBRequest<undefined>;
        },
      } as unknown as IDBObjectStore;
      Reflect.set(transaction, 'objectStore', () => objectStore);
      return transaction;
    },
  } as unknown as IDBDatabase;
  return {
    open: () => {
      const request = {
        error: null,
        onerror: null,
        onsuccess: null,
        onupgradeneeded: null,
      } as unknown as IDBOpenDBRequest;
      queueMicrotask(() => {
        Reflect.set(request, 'result', db);
        request.onupgradeneeded?.(new Event('upgradeneeded') as IDBVersionChangeEvent);
        request.onsuccess?.(new Event('success'));
      });
      return request;
    },
  } as unknown as IDBFactory;
}

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => { values.delete(key); },
    setItem: (key, value) => { values.set(key, value); },
  };
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function legacyOfflineDocument() {
  const legacy = v1 as {
    assets: Array<Record<string, unknown>>;
    timelines: Array<Record<string, unknown> & { items: Array<Record<string, unknown>> }>;
  };
  return {
    ...legacy, name: 'offline-new', unknown: { retained: true },
    assets: legacy.assets.map((asset) => ({ ...asset, unknownAsset: { retained: true } })),
    timelines: legacy.timelines.map((timeline) => ({
      ...timeline, unknownTimeline: { retained: true },
      items: timeline.items.map((item) => ({ ...item, unknownItem: { retained: true } })),
    })),
  };
}

async function verifyEditedRecovery(hasOwnership: boolean): Promise<void> {
  const key = 'project:edited-recovery';
  const value = legacyOfflineDocument();
  const entries = { projects: [{ id: 'edited-recovery', name: 'Original', updatedAt: 20 }], [key]: value };
  let remote: Record<string, unknown> = {
    ...entries, [key]: { ...(v1 as object), name: 'authoritative' },
    'project-edit-ownership:edited-recovery': { ownerId: 'original-owner' },
  };
  const snapshot = (): StoreSnapshot => ({ version: 1, entries: { projects: remote.projects, [key]: remote[key] } });
  const readEntry = async (name: string) => ({ found: Object.hasOwn(remote, name), value: remote[name] });
  const merge = async (incoming: Record<string, unknown>): Promise<StoreSnapshot> => {
    remote = mergeProjectEntries(remote, incoming);
    return { version: 1, entries: {
      projects: remote.projects,
      ...Object.fromEntries(Object.keys(incoming).filter((name) => name.startsWith('project:')).map((name) => [name, remote[name]])),
    } };
  };
  const pending = new Set([key]);
  await recoverUnmergedProjects(entries, snapshot(), pending, merge, readEntry);
  const firstKey = Object.keys(remote).find((name) => name.startsWith('project:recovered_'))!;
  const edited = { ...value, name: 'user-edited recovery' };
  remote[firstKey] = edited;
  if (hasOwnership) remote[`project-edit-ownership:${firstKey.slice('project:'.length)}`] = { ownerId: 'recovery-owner' };
  const result = await recoverUnmergedProjects(entries, snapshot(), pending, merge, readEntry);
  assert.deepEqual(remote[firstKey], edited, 'retry must preserve a recovery edited since its response was lost');
  assert.deepEqual(remote[`${firstKey}_1`], value, 'the retained offline original gets one new suffix copy');
  assert.equal(Object.keys(remote).filter((name) => name.startsWith('project:recovered_')).length, 2);
  assert.deepEqual([...result.recovered], [key]);
}

const local = new Map<string, unknown>();
installGlobal('indexedDB', fakeIndexedDb(local));
installGlobal('history', { state: null, replaceState: () => undefined });
installGlobal('sessionStorage', memoryStorage());

try {
  const localProjects = [{ id: 'local-only', name: 'Local', updatedAt: 1 }];
  installGlobal('location', {
    hash: '',
    pathname: '/',
    protocol: 'http:',
    search: '',
  });
  Reflect.deleteProperty(globals, 'window');
  let remoteProjects: unknown = { found: false };
  const mergeBodies: Array<Record<string, unknown>> = [];
  installGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/merge')) {
      const body = JSON.parse(String(init?.body ?? '{}')) as { entries?: Record<string, unknown> };
      mergeBodies.push(body.entries ?? {});
      return jsonResponse({ version: 1, entries: body.entries ?? {} });
    }
    if (url.endsWith('/entry') && init?.method === 'PUT') {
      return jsonResponse({ ok: true });
    }
    if (url.includes('/entry?key=projects')) return jsonResponse(remoteProjects);
    if (url.endsWith('/api/project-store')) return jsonResponse({ version: 1, entries: {} });
    throw new Error(`unexpected request: ${url}`);
  });

  for (const scenario of [
    { label: 'absent', response: { found: false }, view: undefined },
    { label: 'empty', response: { found: true, value: [] }, view: [] },
  ]) {
    local.clear();
    local.set('projects', localProjects);
    local.set('setting', 'before');
    remoteProjects = scenario.response;
    resetSharedKvMemory();
    assert.deepEqual(await kvGet('projects'), scenario.view,
      `a loopback editor sees the ${scenario.label} remote index after migrating`);
    assert.equal(mergeBodies.length, 1,
      `${scenario.label} bootstrap merges the local index into the shared store`);
    assert.ok('projects' in (mergeBodies[0] ?? {}),
      `${scenario.label} merge pushes the local project index`);
    assert.equal(local.has(MIGRATION_KEY), true,
      `${scenario.label} loopback migration completes immediately`);
    await kvSet('setting', 'after');
    assert.equal(local.get('setting'), 'after',
      'loopback writes flow through to the shared store');
    mergeBodies.length = 0;
  }

  // A failed merge must never fall through to the sync-down branch: with an
  // empty remote library that branch would delete the only local project
  // index. Migration stays pending and a later load retries the merge.
  {
    let failMerge = true;
    let remoteEntry: unknown = { found: false };
    installGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/merge')) {
        if (failMerge) return new Response('merge unavailable', { status: 500 });
        const body = JSON.parse(String(init?.body ?? '{}')) as { entries?: Record<string, unknown> };
        const entries = body.entries ?? {};
        if ('projects' in entries) remoteEntry = { found: true, value: entries.projects };
        return jsonResponse({ version: 1, entries });
      }
      if (url.includes('/entry?key=projects')) return jsonResponse(remoteEntry);
      if (url.endsWith('/api/project-store')) return jsonResponse({ version: 1, entries: {} });
      throw new Error(`unexpected request: ${url}`);
    });
    local.clear();
    local.set('projects', localProjects);
    resetSharedKvMemory();
    assert.deepEqual(await kvGet('projects'), localProjects,
      'after a failed merge the local project index stays authoritative for reads');
    assert.deepEqual(local.get('projects'), localProjects,
      'a failed merge with an empty remote library must not delete the local index');
    assert.equal(local.has(MIGRATION_KEY), false,
      'migration stays pending so a later load retries the merge');

    failMerge = false;
    resetSharedKvMemory();
    assert.deepEqual(await kvGet('projects'), localProjects,
      'the retried merge serves the preserved local index');
    assert.equal(local.has(MIGRATION_KEY), true,
      'a later successful merge completes the migration');
  }

  installGlobal('location', { hash: '', pathname: '/', protocol: 'file:', search: '' });
  resetSharedKvMemory();
  local.clear();
  await kvSet('local-setting', 'offline');
  assert.equal(kvRemoteMode(), 'local');
  assert.equal(await kvGet('local-setting'), 'offline', 'offline writes retain local-first behavior');
  await kvDel('local-setting');
  assert.equal(await kvGet('local-setting'), undefined, 'offline deletes retain local behavior');

  const remoteEntries: Record<string, unknown> = {
    projects: [{ id: 'shared', name: 'Shared', updatedAt: 2 }],
  };
  installGlobal('window', {
    openChatCutDesktop: {
      projectStore: async (request: unknown) => {
        const input = request as { operation: string; key?: string; value?: unknown; entries?: Record<string, unknown> };
        if (input.operation === 'entry') {
          return input.key && Object.hasOwn(remoteEntries, input.key)
            ? { found: true, value: remoteEntries[input.key] }
            : { found: false };
        }
        if (input.operation === 'merge') {
          Object.assign(remoteEntries, input.entries);
          return { version: 1, entries: { projects: remoteEntries.projects } };
        }
        if (input.operation === 'set' && input.key) {
          remoteEntries[input.key] = input.value;
          return { found: true, value: input.value };
        }
        return { version: 1, entries: { ...remoteEntries } };
      },
    },
  });
  local.clear();
  resetSharedKvMemory();
  await kvSet('authorized-setting', 'shared');
  assert.equal(local.get('authorized-setting'), 'shared', 'authorized remote write updates IndexedDB');
  assert.equal(remoteEntries['authorized-setting'], 'shared', 'authorized remote write reaches the shared store');

  // Desktop IPC bridge exists but the store keeps failing (issue #63):
  // bootstrap fails, yet reads and project-document writes must degrade to
  // local copies instead of hard-failing hydration and saves.
  installGlobal('window', {
    openChatCutDesktop: {
      projectStore: async () => { throw new Error('project store lock guard is busy'); },
    },
  });
  local.clear();
  resetSharedKvMemory();
  assert.equal(await kvGetFresh('projects'), undefined,
    'a failing desktop store degrades fresh reads to the local copy');
  await kvSet('project:issue-63', { name: 'resilient', version: 1 });
  assert.deepEqual(local.get('project:issue-63'), { name: 'resilient', version: 1 },
    'a failing desktop store degrades project saves to local instead of throwing');
  assert.deepEqual(await kvGet('project:issue-63'), { name: 'resilient', version: 1 },
    'the degraded local save stays readable');

  await kvSet('pending-setting', 'local-new');
  assert.deepEqual(local.get(PENDING_KEYS_KEY), ['project:issue-63', 'pending-setting'],
    'offline writes persist their pending keys');
  local.set(MIGRATION_KEY, true);
  remoteEntries['pending-setting'] = 'remote-old';
  installGlobal('window', {
    openChatCutDesktop: {
      projectStore: async (request: unknown) => {
        const input = request as { operation: string; key?: string; value?: unknown; entries?: Record<string, unknown> };
        if (input.operation === 'entry') {
          return input.key && Object.hasOwn(remoteEntries, input.key)
            ? { found: true, value: remoteEntries[input.key] }
            : { found: false };
        }
        if (input.operation === 'merge') {
          Object.assign(remoteEntries, input.entries);
          return { version: 1, entries: { projects: remoteEntries.projects } };
        }
        return { version: 1, entries: { ...remoteEntries } };
      },
    },
  });
  resetSharedKvMemory();
  assert.equal(await kvGet('pending-setting'), 'local-new',
    'a reload merges persisted pending writes before reading a stale remote value');
  assert.equal(remoteEntries['pending-setting'], 'local-new',
    'the persisted pending value reaches the shared store');
  assert.equal(local.has(PENDING_KEYS_KEY), false,
    'a successful merge clears the persisted pending marker');

  // Use the real server merge: ownership fences survive lease release and
  // deliberately reject stale offline bodies even though merge returns 200.
  const recoveryCases = [0, Date.now() + 60_000].flatMap((leaseExpiresAt) => (
    ['merge', 'entry'].map((failureAt) => ({ leaseExpiresAt, failureAt }))
  ));
  for (const { leaseExpiresAt, failureAt } of recoveryCases) {
    local.clear();
    resetSharedKvMemory();
    const offlineDoc = legacyOfflineDocument();
    const remoteDoc = { ...(v1 as object), name: 'remote-old' };
    const expectedMigrated = migrateProjectDoc(offlineDoc);
    assert.ok(expectedMigrated, 'the legacy fixture is a real openable V1 project');
    installGlobal('window', { openChatCutDesktop: {
      projectStore: async () => { throw new Error('offline'); },
    } });
    await kvSet('projects', [{ id: 'reconnect', name: 'Original', updatedAt: 20 }]);
    await kvSet('project:reconnect', offlineDoc);
    let remote: Record<string, unknown> = {
      projects: [{ id: 'reconnect', name: 'Original', updatedAt: 10 }],
      'project:reconnect': remoteDoc,
      'project-edit-ownership:reconnect': { ownerId: 'old-tab', leaseExpiresAt },
    };
    let dropRecoveryResponse = true;
    installGlobal('window', { openChatCutDesktop: {
      projectStore: async (request: unknown) => {
        const input = request as { operation: string; key: string; entries: Record<string, unknown> };
        if (failureAt === 'entry' && dropRecoveryResponse && input.operation === 'entry'
          && input.key.startsWith('project:recovered_') && Object.hasOwn(remote, input.key)) {
          dropRecoveryResponse = false;
          throw new Error('connection lost before recovery confirmation');
        }
        if (input.operation === 'entry') return {
          found: Object.hasOwn(remote, input.key), value: remote[input.key],
        };
        if (input.operation === 'merge') {
          remote = mergeProjectEntries(remote, input.entries);
          if (failureAt === 'merge' && dropRecoveryResponse
            && Object.keys(input.entries).some((key) => key.startsWith('project:recovered_'))) {
            dropRecoveryResponse = false;
            throw new Error('connection lost after recovery was committed');
          }
          // The real HTTP merge response deliberately omits document bodies.
          return { version: 1, entries: { projects: remote.projects } };
        }
        return { version: 1, entries: { ...remote } };
      },
    } });
    resetSharedKvMemory();
    assert.deepEqual(await kvGet('project:reconnect'), offlineDoc,
      'an unacknowledged recovery keeps the original offline body readable');
    assert.ok((local.get(PENDING_KEYS_KEY) as string[]).includes('project:reconnect'));
    await kvKeys();
    assert.deepEqual(await kvGetFresh('project:reconnect'), offlineDoc,
      'snapshot enumeration and fresh reads must preserve pending documents');
    assert.deepEqual(remote['project:reconnect'], remoteDoc, 'recovery never bypasses ownership');

    resetSharedKvMemory();
    assert.deepEqual(await kvGet('project:reconnect'), remoteDoc,
      'only a confirmed recovery permits adopting the authoritative original');
    const recoveryKeys = Object.keys(remote).filter((key) => key.startsWith('project:recovered_'));
    assert.equal(recoveryKeys.length, 1, 'a lost response/reload must not duplicate the recovery');
    const recoveredKey = recoveryKeys[0]!;
    assert.deepEqual(await kvGet(recoveredKey), offlineDoc, 'the recovery retains the complete raw V1 body');
    const migrationSteps: number[] = [];
    const opened = await loadProjectForEditing(recoveredKey.slice('project:'.length), {
      onProgress: (step) => migrationSteps.push(step.fromVersion),
    });
    assert.equal(opened.status, 'ok', 'the recovered legacy project opens through the real editor load boundary');
    if (opened.status === 'ok') {
      assert.equal(opened.doc.version, CURRENT_PROJECT_VERSION);
      assert.deepEqual(migrationSteps, [1, 2]);
      assert.deepEqual(opened.doc, expectedMigrated);
      assert.deepEqual(Reflect.get(opened.doc, 'unknown'), { retained: true });
      assert.deepEqual(Reflect.get(opened.doc.assets[0]!, 'unknownAsset'), { retained: true });
      assert.deepEqual(Reflect.get(opened.doc.timelines[0]!, 'unknownTimeline'), { retained: true });
      assert.deepEqual(Reflect.get(opened.doc.timelines[0]!.items[0]!, 'unknownItem'), { retained: true });
      assert.equal(opened.doc.assets[0]!.src, '/media/uploads/interview.mp4');
    }
    assert.deepEqual(await kvGet(recoveredKey), offlineDoc, 'loading migration does not rewrite the raw recovery');
    const index = await kvGet<Array<{ id: string; name: string }>>('projects');
    assert.ok(index?.some((meta) => meta.id === recoveredKey.slice('project:'.length)
      && meta.name === '[Recovered offline] Original'), 'the dashboard exposes the recovery copy');
    assert.equal(local.has(PENDING_KEYS_KEY), false, 'confirmed recoveries acknowledge pending keys');
    resetSharedKvMemory();
    await kvGet('projects');
    assert.equal(Object.keys(remote).filter((key) => key.startsWith('project:recovered_')).length, 1);
  }
  // A limited recovery response must retain confirmations for other pending documents.
  local.clear();
  resetSharedKvMemory();
  installGlobal('window', { openChatCutDesktop: { projectStore: async () => { throw new Error('offline'); } } });
  const mixedIndex = ['conflict-a', 'accepted-b', 'conflict-c'].map((id) => ({ id, name: id, updatedAt: 20 }));
  const mixedDocuments = Object.fromEntries(mixedIndex.map(({ id }) => [
    `project:${id}`, { ...legacyOfflineDocument(), name: id },
  ]));
  await kvSet('projects', mixedIndex);
  for (const [key, value] of Object.entries(mixedDocuments)) await kvSet(key, value);
  let mixedRemote: Record<string, unknown> = {
    projects: mixedIndex,
    ...mixedDocuments,
    'project:conflict-a': { ...(v1 as object), name: 'remote-a' },
    'project:conflict-c': { ...(v1 as object), name: 'remote-c' },
    'project-edit-ownership:conflict-a': { ownerId: 'owner-a' },
    'project-edit-ownership:conflict-c': { ownerId: 'owner-c' },
  };
  installGlobal('window', { openChatCutDesktop: {
    projectStore: async (request: unknown) => {
      const input = request as { operation: string; key: string; entries: Record<string, unknown> };
      if (input.operation === 'entry') return { found: Object.hasOwn(mixedRemote, input.key), value: mixedRemote[input.key] };
      if (input.operation === 'merge') {
        mixedRemote = mergeProjectEntries(mixedRemote, input.entries);
        return { version: 1, entries: { projects: mixedRemote.projects } };
      }
      return { version: 1, entries: { ...mixedRemote } };
    },
  } });
  resetSharedKvMemory();
  await kvGet('projects');
  const mixedCopies = Object.entries(mixedRemote).filter(([key]) => key.startsWith('project:recovered_'));
  assert.equal(mixedCopies.length, 2, 'only the two conflicting documents need recovery copies');
  assert.deepEqual(mixedCopies.map(([, value]) => Reflect.get(value as object, 'name')).sort(), ['conflict-a', 'conflict-c']);
  assert.deepEqual(await kvGet('project:accepted-b'), mixedDocuments['project:accepted-b']);
  assert.equal(local.has(PENDING_KEYS_KEY), false, 'all three pending documents have explicit confirmation');
  await verifyEditedRecovery(false);
  await verifyEditedRecovery(true);
} finally {
  resetSharedKvMemory();
  restoreGlobals();
}
console.log('sharedKv.verify: authority, migration, and remote-failure fallback semantics passed');
