import {
  advanceBrowserProjectOwnership,
  browserProjectOwnership,
  projectStoreRemoteAvailable,
  projectStoreWriteCredential,
  requestProjectStore,
  resetProjectStoreTransport,
} from './projectStoreTransport';
import type {
  ProjectStoreMutationResponse,
  ProjectDocumentMutationResponse,
  ProjectStoreRequest,
} from '../../shared/project-store-transport';
import { projectIdFromProjectStoreKey } from '../../shared/project-store-validation';

type AgentRuntimeCasRequest = Extract<ProjectStoreRequest, { operation: 'agent-runtime-cas' }>;
type AgentRunLeaseRequest = Extract<ProjectStoreRequest, { operation: 'agent-run-lease' }>;
type ProjectDocumentCasRequest = Extract<ProjectStoreRequest, { operation: 'project-document-cas' }>;

export interface SharedKvBackend {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
  keys(): Promise<string[]>;
  compareAndSwapAgentRuntime(input: AgentRuntimeCasRequest): Promise<ProjectStoreMutationResponse>;
  updateAgentRunLease(input: AgentRunLeaseRequest): Promise<ProjectStoreMutationResponse>;
}
const DB_NAME = 'openchatcut';
const STORE = 'kv';
const MIGRATION_KEY = '__openchatcut_shared_store_v1__';
const memoryStore = new Map<string, unknown>();
let injectedBackend: SharedKvBackend | undefined;

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
const canSync = (): boolean => !injectedBackend && projectStoreRemoteAvailable();
const isProjectDocumentKey = (key: string): boolean => /^project:[a-zA-Z0-9_-]{1,160}$/.test(key);
const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

export function configureSharedKvBackend(backend: SharedKvBackend | undefined): void {
  injectedBackend = backend;
  remoteCache = null;
  remoteKnown.clear();
  readyPromise = undefined;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function localGet<T>(key: string): Promise<T | undefined> {
  if (injectedBackend) return injectedBackend.get<T>(key);
  if (!hasIdb()) return memoryStore.get(key) as T | undefined;
  const db = await openDb();
  return new Promise<T | undefined>((resolve, reject) => {
    const request = db.transaction(STORE, 'readonly').objectStore(STORE).get(key);
    request.onsuccess = () => resolve(request.result as T | undefined);
    request.onerror = () => reject(request.error);
  });
}

async function localSet(key: string, value: unknown): Promise<void> {
  if (injectedBackend) {
    await injectedBackend.set(key, value);
    return;
  }
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
  if (injectedBackend) {
    await injectedBackend.delete(key);
    return;
  }
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
  if (injectedBackend) return injectedBackend.keys();
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

async function requestSnapshot(): Promise<StoreSnapshot> {
  const value = await requestProjectStore({ operation: 'snapshot' });
  if (!validSnapshot(value)) throw new Error('invalid project store response');
  return value;
}

async function requestMerge(entries: Record<string, unknown>): Promise<StoreSnapshot> {
  const value = await requestProjectStore({ operation: 'merge', entries });
  if (!validSnapshot(value)) throw new Error('invalid project store response');
  return value;
}

async function requestEntry(key: string): Promise<EntryResponse> {
  const value = await requestProjectStore({ operation: 'entry', key });
  if (!('found' in value) || typeof value.found !== 'boolean') {
    throw new Error('invalid project index response');
  }
  return value;
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

function validMutationResponse(value: unknown): value is ProjectStoreMutationResponse {
  return isRecord(value)
    && typeof value.accepted === 'boolean'
    && typeof value.found === 'boolean'
    && (!value.found || Object.hasOwn(value, 'value'));
}

function validProjectDocumentMutation(
  value: unknown,
): value is ProjectDocumentMutationResponse {
  if (!isRecord(value) || !validMutationResponse(value)) return false;
  const currentRevision = value.currentRevision;
  const ownershipEpoch = value.ownershipEpoch;
  return (currentRevision === undefined || typeof currentRevision === 'string')
    && (ownershipEpoch === undefined
      || (typeof ownershipEpoch === 'number'
        && Number.isSafeInteger(ownershipEpoch)
        && ownershipEpoch >= 1));
}

async function requestProjectDocumentMutation(
  request: ProjectDocumentCasRequest,
): Promise<ProjectDocumentMutationResponse> {
  const value = await requestProjectStore(request);
  if (!validProjectDocumentMutation(value)) {
    throw new Error('invalid project document mutation response');
  }
  return value;
}

async function requestMutation(
  request: AgentRuntimeCasRequest | AgentRunLeaseRequest,
): Promise<ProjectStoreMutationResponse> {
  const value = await requestProjectStore(request);
  if (!validMutationResponse(value)) throw new Error('invalid project store mutation response');
  return value;
}

async function cacheMutation(key: string, result: ProjectStoreMutationResponse): Promise<void> {
  cacheEntry(key, result);
  if (result.found) await localSet(key, result.value);
  else await localDel(key);
}

export async function kvCompareAndSwapAgentRuntime(
  request: AgentRuntimeCasRequest,
): Promise<ProjectStoreMutationResponse> {
  await ready();
  const remote = !injectedBackend && canSync();
  const result = injectedBackend
    ? await injectedBackend.compareAndSwapAgentRuntime(request)
    : remote
      ? await requestMutation(request)
      : await localAgentRuntimeCas(request);
  if (!validMutationResponse(result)) throw new Error('invalid agent runtime CAS response');
  if (remote) await cacheMutation(request.key, result);
  return result;
}

async function localAgentRuntimeCas(
  request: AgentRuntimeCasRequest,
): Promise<ProjectStoreMutationResponse> {
  const current = await localGet<unknown>(request.key);
  const revision = isRecord(current) && Number.isInteger(current.revision)
    ? Number(current.revision)
    : null;
  if (revision !== request.expectedRevision) {
    return { accepted: false, found: current !== undefined, ...(current === undefined ? {} : { value: current }) };
  }
  await localSet(request.key, request.value);
  return { accepted: true, found: true, value: request.value };
}

export async function kvUpdateAgentRunLease(
  request: AgentRunLeaseRequest,
): Promise<ProjectStoreMutationResponse | null> {
  await ready();
  if (!injectedBackend && !canSync()) return null;
  const result = injectedBackend
    ? await injectedBackend.updateAgentRunLease(request)
    : await requestMutation(request);
  if (!validMutationResponse(result)) throw new Error('invalid agent run lease response');
  if (!injectedBackend) await cacheMutation(request.key, result);
  return result;
}

async function bootstrap(): Promise<void> {
  if (!canSync()) return;
  try {
    const migrated = await localGet<boolean>(MIGRATION_KEY);
    let projects = await requestEntry('projects');
    if (!migrated || !projects.found) {
      if (projectStoreWriteCredential()) {
        // First migration / empty server index: upload local entries. A
        // sessionless tab skips this (writes are not allowed) and simply
        // adopts the server snapshot as authoritative.
        const local = await localEntries();
        const snapshot = await requestMerge(local);
        projects = 'projects' in snapshot.entries
          ? { found: true, value: snapshot.entries.projects }
          : { found: false };
      }
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

async function setProjectDocument(key: string, value: unknown): Promise<void> {
  if (injectedBackend || !canSync()) {
    await localSet(key, value);
    return;
  }
  if (!remoteCache) throw new Error('共享工程数据库暂时不可用，工程未保存');
  const projectId = key.slice('project:'.length);
  const ownership = browserProjectOwnership(projectId);
  const local = await localGet<unknown>(key);
  if (!ownership && local !== undefined) {
    throw new Error('工程编辑权尚未注册，工程未保存');
  }
  const request: ProjectDocumentCasRequest = ownership
    ? {
      operation: 'project-document-cas',
      key,
      expectedRevision: ownership.baseRevision,
      ownerId: ownership.ownerId,
      ownershipEpoch: ownership.epoch,
      value,
    }
    : { operation: 'project-document-cas', key, expectedRevision: null, value };
  let result: ProjectDocumentMutationResponse;
  try {
    result = await requestProjectDocumentMutation(request);
  } catch (error) {
    await disableRemote();
    throw error;
  }
  if (!result.accepted) {
    await cacheMutation(key, result);
    if (typeof window !== 'undefined') window.location.reload();
    throw new Error('工程已被其他编辑器更新，请重新加载');
  }
  if (!result.found || typeof result.currentRevision !== 'string') {
    throw new Error('invalid successful project document CAS response');
  }
  if (ownership) {
    if (result.ownershipEpoch !== ownership.epoch) {
      throw new Error('project ownership epoch changed during save');
    }
    advanceBrowserProjectOwnership(ownership, result.currentRevision);
  }
  await cacheMutation(key, result);
}

export async function kvSet(key: string, value: unknown): Promise<void> {
  await ready();
  if (isProjectDocumentKey(key)) {
    await setProjectDocument(key, value);
    return;
  }
  await localSet(key, value);
  if (!remoteCache) return;
  // A browser tab without an editor session can READ the shared library but
  // must not silently pretend a write succeeded: fail loudly instead of
  // dropping into offline mode (reads stay consistent across ports).
  if (!projectStoreWriteCredential()) {
    throw new Error('共享工程库为只读模式（未连接编辑器会话），修改未同步');
  }
  remoteKnown.add(key);
  remoteCache = { ...remoteCache, [key]: value };
  try {
    await requestProjectStore({ operation: 'set', key, value });
  } catch (error) {
    if (isAuthError(error)) {
      throw new Error('共享工程库只读（编辑器会话失效），修改未同步');
    }
    await disableRemote();
  }
}

export async function kvDel(key: string): Promise<void> {
  await ready();
  // Deleting a project document must always go through the shared store: a
  // silent local-only delete is what let deleted projects "resurrect" on
  // other ports (their server copy + other ports' caches stayed intact).
  // Node memory fallback (no IndexedDB) keeps local semantics for checks.
  const requireSharedDelete = isProjectDocumentKey(key) && (canSync() || hasIdb());
  if (!remoteCache) {
    if (requireSharedDelete) throw new Error('共享工程数据库暂时不可用，工程未删除');
    await localDel(key);
    return;
  }
  if (isProjectDocumentKey(key) && !projectStoreWriteCredential()) {
    throw new Error('共享工程库为只读模式（未连接编辑器会话），工程未删除');
  }
  try {
    await requestProjectStore({ operation: 'delete', key });
  } catch (error) {
    if (isAuthError(error) && isProjectDocumentKey(key)) {
      throw new Error('共享工程库只读（编辑器会话失效），工程未删除');
    }
    await disableRemote();
    if (requireSharedDelete) throw error;
    await localDel(key);
    return;
  }
  await localDel(key);
  remoteKnown.add(key);
  remoteCache = Object.fromEntries(Object.entries(remoteCache).filter(([name]) => name !== key));
}

async function purgeLocalProjectEntries(projectId: string): Promise<void> {
  for (const key of await localKeys()) {
    if (projectIdFromProjectStoreKey(key) === projectId) await localDel(key);
  }
}

function forgetRemoteProjectEntries(projectId: string): void {
  remoteCache = Object.fromEntries(
    Object.entries(remoteCache ?? {}).filter(([key]) =>
      projectIdFromProjectStoreKey(key) !== projectId),
  );
  for (const key of remoteKnown) {
    if (projectIdFromProjectStoreKey(key) === projectId) remoteKnown.delete(key);
  }
}

export async function kvPurgeProject(projectId: string): Promise<void> {
  await ready();
  const requireSharedDelete = canSync();
  if (!remoteCache) {
    if (requireSharedDelete) throw new Error('共享工程数据库暂时不可用，工程未删除');
    await purgeLocalProjectEntries(projectId);
    return;
  }
  try {
    await requestProjectStore({ operation: 'purge-project', projectId });
  } catch (error) {
    await disableRemote();
    if (requireSharedDelete) throw error;
    await purgeLocalProjectEntries(projectId);
    return;
  }
  await purgeLocalProjectEntries(projectId);
  forgetRemoteProjectEntries(projectId);
}

/** Read/write/offline mode of the shared KV for UI hints. */
export function kvRemoteMode(): 'remote' | 'local' {
  return remoteCache ? 'remote' : 'local';
}

function isAuthError(error: unknown): error is Error & { status: number } {
  if (!(error instanceof Error)) return false;
  const status = Reflect.get(error, 'status');
  return typeof status === 'number' && status >= 400 && status < 500;
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
  injectedBackend = undefined;
  resetProjectStoreTransport();
}
