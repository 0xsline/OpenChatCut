const DB_NAME = 'openchatcut';
const STORE = 'kv';
const MIGRATION_KEY = '__openchatcut_shared_store_v1__';
const API_PATH = '/api/project-store';
const memoryStore = new Map<string, unknown>();

interface StoreSnapshot {
  version: 1;
  entries: Record<string, unknown>;
}

interface EntryResponse {
  found: boolean;
  value?: unknown;
}

let remoteCache: Record<string, unknown> | null = null;
const remoteKnown = new Set<string>();
let readyPromise: Promise<void> | undefined;

const hasIdb = (): boolean => typeof indexedDB !== 'undefined';
const canSync = (): boolean =>
  typeof window !== 'undefined'
  && typeof location !== 'undefined'
  && typeof fetch === 'function'
  && (location.protocol === 'http:' || location.protocol === 'https:');
const isProjectDocumentKey = (key: string): boolean => /^project:[a-zA-Z0-9_-]{1,160}$/.test(key);
const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function localGet<T>(key: string): Promise<T | undefined> {
  if (!hasIdb()) return memoryStore.get(key) as T | undefined;
  const db = await openDb();
  return new Promise<T | undefined>((resolve, reject) => {
    const request = db.transaction(STORE, 'readonly').objectStore(STORE).get(key);
    request.onsuccess = () => resolve(request.result as T | undefined);
    request.onerror = () => reject(request.error);
  });
}

async function localSet(key: string, value: unknown): Promise<void> {
  if (!hasIdb()) {
    memoryStore.set(key, value);
    return;
  }
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(STORE, 'readwrite');
    transaction.objectStore(STORE).put(value, key);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
}

async function localDel(key: string): Promise<void> {
  if (!hasIdb()) {
    memoryStore.delete(key);
    return;
  }
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(STORE, 'readwrite');
    transaction.objectStore(STORE).delete(key);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
}

async function localKeys(): Promise<string[]> {
  if (!hasIdb()) return [...memoryStore.keys()];
  const db = await openDb();
  return new Promise<string[]>((resolve, reject) => {
    const request = db.transaction(STORE, 'readonly').objectStore(STORE).getAllKeys();
    request.onsuccess = () => resolve(request.result.filter((key): key is string => typeof key === 'string'));
    request.onerror = () => reject(request.error);
  });
}

async function localEntries(): Promise<Record<string, unknown>> {
  const entries: Record<string, unknown> = {};
  for (const key of await localKeys()) {
    if (key !== MIGRATION_KEY) entries[key] = await localGet(key);
  }
  return entries;
}

function validSnapshot(value: unknown): value is StoreSnapshot {
  return isRecord(value) && value.version === 1 && isRecord(value.entries);
}

async function requestSnapshot(path = '', init?: RequestInit): Promise<StoreSnapshot> {
  const response = await fetch(`${API_PATH}${path}`, {
    cache: 'no-store',
    ...init,
    headers: { 'Content-Type': 'application/json', ...init?.headers },
  });
  if (!response.ok) throw new Error(`project store request failed: ${response.status}`);
  const value: unknown = await response.json();
  if (!validSnapshot(value)) throw new Error('invalid project store response');
  return value;
}

async function requestEntry(key: string): Promise<EntryResponse> {
  const response = await fetch(`${API_PATH}/entry?key=${encodeURIComponent(key)}`, { cache: 'no-store' });
  if (!response.ok) throw new Error(`project index request failed: ${response.status}`);
  const value: unknown = await response.json();
  if (!isRecord(value) || typeof value.found !== 'boolean') throw new Error('invalid project index response');
  return value as unknown as EntryResponse;
}

function cacheEntry(key: string, entry: EntryResponse): void {
  remoteKnown.add(key);
  remoteCache = entry.found
    ? { ...remoteCache, [key]: entry.value }
    : Object.fromEntries(Object.entries(remoteCache ?? {}).filter(([name]) => name !== key));
}

async function fetchRemoteEntry(key: string): Promise<void> {
  const entry = await requestEntry(key);
  cacheEntry(key, entry);
  if (entry.found) await localSet(key, entry.value);
  else await localDel(key);
}

async function bootstrap(): Promise<void> {
  if (!canSync()) return;
  try {
    const migrated = await localGet<boolean>(MIGRATION_KEY);
    let projects = await requestEntry('projects');
    if (!migrated || !projects.found) {
      const local = await localEntries();
      const snapshot = await requestSnapshot('/merge', {
        method: 'POST',
        body: JSON.stringify({ entries: local }),
      });
      projects = 'projects' in snapshot.entries
        ? { found: true, value: snapshot.entries.projects }
        : { found: false };
    }
    remoteCache = {};
    remoteKnown.clear();
    cacheEntry('projects', projects);
    if (projects.found) await localSet('projects', projects.value);
    else await localDel('projects');
    await localSet(MIGRATION_KEY, true);
  } catch {
    remoteCache = null;
    remoteKnown.clear();
  }
}

async function ready(): Promise<void> {
  readyPromise ??= bootstrap();
  await readyPromise;
}

async function disableRemote(): Promise<void> {
  remoteCache = null;
  remoteKnown.clear();
  try {
    await localDel(MIGRATION_KEY);
  } catch {
    // Local writes remain usable; the next successful page load can retry migration.
  }
}

export async function kvGet<T>(key: string): Promise<T | undefined> {
  await ready();
  if (remoteCache) {
    try {
      if (key === 'projects' || !remoteKnown.has(key)) await fetchRemoteEntry(key);
    } catch {
      await disableRemote();
    }
  }
  if (remoteCache) return remoteCache[key] as T | undefined;
  return localGet<T>(key);
}

export async function kvSet(key: string, value: unknown): Promise<void> {
  await ready();
  await localSet(key, value);
  if (!remoteCache) return;
  remoteKnown.add(key);
  remoteCache = { ...remoteCache, [key]: value };
  try {
    const response = await fetch(`${API_PATH}/entry`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key, value }),
    });
    if (!response.ok) throw new Error(`project store write failed: ${response.status}`);
  } catch {
    await disableRemote();
  }
}

export async function kvDel(key: string): Promise<void> {
  await ready();
  const requireSharedDelete = canSync() && isProjectDocumentKey(key);
  if (!remoteCache) {
    if (requireSharedDelete) throw new Error('共享工程数据库暂时不可用，工程未删除');
    await localDel(key);
    return;
  }
  try {
    const response = await fetch(`${API_PATH}/entry?key=${encodeURIComponent(key)}`, { method: 'DELETE' });
    if (!response.ok) throw new Error(`project store delete failed: ${response.status}`);
  } catch (error) {
    await disableRemote();
    if (requireSharedDelete) throw error;
    await localDel(key);
    return;
  }
  await localDel(key);
  remoteKnown.add(key);
  remoteCache = Object.fromEntries(Object.entries(remoteCache).filter(([name]) => name !== key));
}

export async function kvKeys(): Promise<string[]> {
  await ready();
  if (remoteCache) {
    try {
      const snapshot = await requestSnapshot();
      remoteCache = snapshot.entries;
      remoteKnown.clear();
      for (const key of Object.keys(snapshot.entries)) remoteKnown.add(key);
      return Object.keys(snapshot.entries);
    } catch {
      await disableRemote();
    }
  }
  return (await localKeys()).filter((key) => key !== MIGRATION_KEY);
}

/** Test helper: reset the Node fallback shared by all persistence modules. */
export function resetSharedKvMemory(): void {
  memoryStore.clear();
  remoteCache = null;
  remoteKnown.clear();
  readyPromise = undefined;
}
