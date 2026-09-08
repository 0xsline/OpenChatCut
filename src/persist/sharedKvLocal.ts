import type { ProjectStoreMutationResponse, ProjectStoreRequest } from '../../shared/project-store-transport';

type AgentRuntimeWriteRequest = Extract<ProjectStoreRequest, { operation: 'agent-runtime-write' }>;
type AgentRunLeaseRequest = Extract<ProjectStoreRequest, { operation: 'agent-run-lease' }>;

export interface SharedKvBackend {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
  keys(): Promise<string[]>;
  writeAgentRuntime(input: AgentRuntimeWriteRequest): Promise<ProjectStoreMutationResponse>;
  updateAgentRunLease(input: AgentRunLeaseRequest): Promise<ProjectStoreMutationResponse>;
}

const DB_NAME = 'openchatcut';
const STORE = 'kv';
const memoryStore = new Map<string, unknown>();
export let injectedBackend: SharedKvBackend | undefined;
export const freshCache = new Map<string, { value: unknown; at: number }>();
export const hasIdb = (): boolean => typeof indexedDB !== 'undefined';

export function configureLocalKvBackend(backend: SharedKvBackend | undefined): void {
  injectedBackend = backend;
}

export function resetLocalKvMemory(): void {
  memoryStore.clear();
  freshCache.clear();
  injectedBackend = undefined;
}

// Reuse successful connections; a failed open must remain retryable.
let dbPromise: Promise<IDBDatabase> | undefined;
function openDb(): Promise<IDBDatabase> {
  dbPromise ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => { db.close(); dbPromise = undefined; };
      db.onclose = () => { dbPromise = undefined; };
      resolve(db);
    };
    request.onerror = () => reject(request.error);
  }).catch((error) => {
    dbPromise = undefined;
    throw error;
  });
  return dbPromise;
}

export async function localGet<T>(key: string): Promise<T | undefined> {
  if (injectedBackend) return injectedBackend.get<T>(key);
  if (!hasIdb()) return memoryStore.get(key) as T | undefined;
  const db = await openDb();
  return new Promise<T | undefined>((resolve, reject) => {
    const request = db.transaction(STORE, 'readonly').objectStore(STORE).get(key);
    request.onsuccess = () => resolve(request.result as T | undefined);
    request.onerror = () => reject(request.error);
  });
}

export async function localSet(key: string, value: unknown): Promise<void> {
  freshCache.delete(key);
  if (injectedBackend) return injectedBackend.set(key, value);
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

export async function localDel(key: string): Promise<void> {
  freshCache.delete(key);
  if (injectedBackend) return injectedBackend.delete(key);
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

export async function localKeys(): Promise<string[]> {
  if (injectedBackend) return injectedBackend.keys();
  if (!hasIdb()) return [...memoryStore.keys()];
  const db = await openDb();
  return new Promise<string[]>((resolve, reject) => {
    const request = db.transaction(STORE, 'readonly').objectStore(STORE).getAllKeys();
    request.onsuccess = () => resolve(request.result.filter((key): key is string => typeof key === 'string'));
    request.onerror = () => reject(request.error);
  });
}
