import assert from 'node:assert/strict';
import { kvDel, kvGet, kvGetFresh, kvRemoteMode, kvSet, resetSharedKvMemory } from './sharedKv';

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
          return { version: 1, entries: { ...remoteEntries } };
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
          return { version: 1, entries: { ...remoteEntries } };
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
} finally {
  resetSharedKvMemory();
  restoreGlobals();
}
console.log('sharedKv.verify: authority, migration, and remote-failure fallback semantics passed');
