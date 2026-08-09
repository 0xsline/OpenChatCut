import assert from 'node:assert/strict';
import { kvDel, kvGet, kvRemoteMode, kvSet, resetSharedKvMemory } from './sharedKv';

const MIGRATION_KEY = '__openchatcut_shared_store_v1__';
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
  let unauthorizedWrites = 0;
  let remoteProjects: unknown = { found: false };
  installGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/session')) return new Response(null, { status: 401 });
    if (init?.method && init.method !== 'GET') unauthorizedWrites += 1;
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
    assert.deepEqual(await kvGet('projects'), scenario.view, `read-only browser sees the ${scenario.label} remote index`);
    assert.deepEqual(local.get('projects'), localProjects, `${scenario.label} remote migration preserves the local index`);
    assert.equal(local.has(MIGRATION_KEY), false, `${scenario.label} remote migration remains pending`);
  }
  await assert.rejects(
    kvSet('setting', 'after'),
    /只读模式/,
    'sessionless remote writes reject before touching IndexedDB',
  );
  assert.equal(local.get('setting'), 'before', 'rejected remote write leaves the local value unchanged');
  assert.equal(unauthorizedWrites, 0, 'sessionless startup sends no remote mutations');

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
} finally {
  resetSharedKvMemory();
  restoreGlobals();
}

console.log('sharedKv.verify: authority and migration semantics passed');
