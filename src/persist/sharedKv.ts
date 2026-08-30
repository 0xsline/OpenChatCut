import {
  advanceBrowserProjectOwnership,
  browserProjectOwnership,
  projectStoreRemoteAvailable,
  projectStoreWriteCredential,
  requestProjectStore,
  resetProjectStoreTransport,
  waitForBrowserProjectOwnership,
} from './projectStoreTransport';
import type {
  ProjectStoreMutationResponse,
  ProjectDocumentMutationResponse,
  ProjectStoreRequest,
} from '../../shared/project-store-transport';
import { projectIdFromProjectStoreKey } from '../../shared/project-store-validation';
type AgentRuntimeWriteRequest = Extract<ProjectStoreRequest, { operation: 'agent-runtime-write' }>;
type AgentRunLeaseRequest = Extract<ProjectStoreRequest, { operation: 'agent-run-lease' }>;
type ProjectDocumentWriteRequest = Extract<ProjectStoreRequest, { operation: 'project-document-write' }>;
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
const MIGRATION_KEY = '__openchatcut_shared_store_v1__';
const PENDING_KEYS_KEY = '__openchatcut_shared_pending_v1__';
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
// Keys whose last write could not reach the server (offline/read-only):
// remote reads must never purge their local copy, or the only data copy
// is silently deleted on the next load.
const locallyPendingKeys = new Set<string>();
const remoteKnown = new Set<string>();
let readyPromise: Promise<void> | undefined;
let projectMigrationPending = false;
const hasIdb = (): boolean => typeof indexedDB !== 'undefined';
const canSync = (): boolean => !injectedBackend && projectStoreRemoteAvailable();
const isProjectDocumentKey = (key: string): boolean => /^project:[a-zA-Z0-9_-]{1,160}$/.test(key);
const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
export function configureSharedKvBackend(backend: SharedKvBackend | undefined): void {
  injectedBackend = backend;
  remoteCache = null;
  remoteKnown.clear();
  locallyPendingKeys.clear();
  projectMigrationPending = false;
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
  freshCache.delete(key);
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
  freshCache.delete(key);
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
async function loadPendingKeys(): Promise<void> {
  locallyPendingKeys.clear();
  const saved = await localGet<unknown>(PENDING_KEYS_KEY);
  if (!Array.isArray(saved)) return;
  for (const key of saved) {
    if (typeof key === 'string' && key !== MIGRATION_KEY && key !== PENDING_KEYS_KEY) {
      locallyPendingKeys.add(key);
    }
  }
}
async function markPendingKey(key: string): Promise<void> {
  locallyPendingKeys.add(key);
  await localSet(PENDING_KEYS_KEY, [...locallyPendingKeys]);
}
async function clearPendingKeys(): Promise<void> {
  locallyPendingKeys.clear();
  await localDel(PENDING_KEYS_KEY);
}
async function clearPendingKey(key: string): Promise<void> {
  locallyPendingKeys.delete(key);
  if (locallyPendingKeys.size) await localSet(PENDING_KEYS_KEY, [...locallyPendingKeys]);
  else await localDel(PENDING_KEYS_KEY);
}
async function localEntries(): Promise<Record<string, unknown>> {
  const entries: Record<string, unknown> = {};
  for (const key of await localKeys()) {
    if (key !== MIGRATION_KEY && key !== PENDING_KEYS_KEY) entries[key] = await localGet(key);
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
  if (locallyPendingKeys.has(key) || (key === 'projects' && projectMigrationPending)) {
    const local = await localGet(key);
    remoteKnown.add(key);
    if (local === undefined) delete remoteCache?.[key];
    else if (remoteCache) remoteCache = { ...remoteCache, [key]: local };
    return;
  }
  cacheEntry(key, entry);
  if (entry.found) {
    await localSet(key, entry.value);
  } else {
    await localDel(key);
  }
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
  request: ProjectDocumentWriteRequest,
): Promise<ProjectDocumentMutationResponse> {
  const value = await requestProjectStore(request);
  if (!validProjectDocumentMutation(value)) {
    throw new Error('invalid project document mutation response');
  }
  return value;
}
async function requestMutation(
  request: AgentRuntimeWriteRequest | AgentRunLeaseRequest,
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
export async function kvWriteAgentRuntime(
  request: AgentRuntimeWriteRequest,
): Promise<ProjectStoreMutationResponse> {
  await ready();
  const remote = !injectedBackend && canSync();
  const result = injectedBackend
    ? await injectedBackend.writeAgentRuntime(request)
    : remote
      ? await requestMutation(request)
      : await localAgentRuntimeWrite(request);
  if (!validMutationResponse(result)) throw new Error('invalid agent runtime CAS response');
  if (remote) await cacheMutation(request.key, result);
  return result;
}
async function localAgentRuntimeWrite(
  request: AgentRuntimeWriteRequest,
): Promise<ProjectStoreMutationResponse> {
  // CAS removed: local writes are serialized by the caller's enqueue/lock;
  // the expected revision is no longer compared.
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
  let projects: EntryResponse;
  try {
    await loadPendingKeys();
    const migrated = await localGet<boolean>(MIGRATION_KEY);
    projects = await requestEntry('projects');
    const canWrite = projectStoreWriteCredential();
    let mergeFailed = false;
    if ((!migrated || !projects.found || locallyPendingKeys.size > 0) && canWrite) {
      try {
        const local = await localEntries();
        const snapshot = await requestMerge(local);
        projects = 'projects' in snapshot.entries
          ? { found: true, value: snapshot.entries.projects }
          : { found: false };
        await clearPendingKeys();
      } catch {
        // Merge failure (lease contention, transient 5xx, timeout): keep the
        // remote cache usable for reads and retry the merge on a later load.
        // When a local 'projects' entry exists it must stay authoritative —
        // a failed merge is never allowed to fall through to the sync-down
        // branch below, which would overwrite it (or, with an empty remote
        // library, delete the only copy of the local project index).
        mergeFailed = (await localGet<unknown>('projects')) !== undefined;
      }
    }
    projectMigrationPending = locallyPendingKeys.has('projects') || mergeFailed || (!canWrite
      && (!projects.found || (Array.isArray(projects.value) && projects.value.length === 0)));
  } catch {
    await disableRemote();
    return;
  }
  remoteCache = {};
  remoteKnown.clear();
  cacheEntry('projects', projects);
  if (projectMigrationPending) {
    await localDel(MIGRATION_KEY);
    return;
  }
  if (projects.found) await localSet('projects', projects.value);
  else await localDel('projects');
  await localSet(MIGRATION_KEY, true);
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

// Fresh reads hit the network, but a short TTL cache absorbs repeated reads
// within one hydration (currentAgentSessionGeneration is consulted by
// loadChat, the runtime sidecar and the recovery chain).
const FRESH_CACHE_TTL_MS = 2_000;
const freshCache = new Map<string, { value: unknown; at: number }>();
// kvGet serves known keys from the in-memory remote cache; re-verify them
// against the server on a short TTL so a second port/instance that wrote
// newer data is not hidden forever (read-modify-write flows would then
// overwrite the newer remote value).
const KV_REMOTE_VERIFY_TTL_MS = 5_000;
const remoteVerifiedAt = new Map<string, number>();

export async function kvGetFresh<T>(key: string): Promise<T | undefined> {
  await ready();
  // Session generation is the cross-port cutover fence. It must observe an
  // external clear before a new run writes, so never serve it from the TTL
  // cache. Other fresh reads retain the hydration round-trip optimization.
  const cacheGeneration = !key.startsWith('agent-session-generation:');
  const cached = cacheGeneration ? freshCache.get(key) : undefined;
  if (cached && Date.now() - cached.at < FRESH_CACHE_TTL_MS) {
    return cached.value as T | undefined;
  }
  if (!injectedBackend && projectStoreRemoteAvailable()) {
    try {
      await fetchRemoteEntry(key);
    } catch {
      // Remote momentarily unreachable (bootstrap may have failed the same
      // way): serve the local copy instead of failing hydration.
      await disableRemote();
    }
    if (remoteCache) {
      const value = remoteCache[key] as T | undefined;
      if (cacheGeneration) freshCache.set(key, { value, at: Date.now() });
      return value;
    }
  }
  const value = await localGet<T>(key);
  if (cacheGeneration) freshCache.set(key, { value, at: Date.now() });
  return value;
}
/** Local-first read for per-machine session data (chat history, agent
 *  runtime sidecar): return the local copy immediately and refresh the
 *  remote cache in the background. Cross-port consistency for these keys is
 *  best-effort — they are regenerated by the editor, not shared documents. */
export async function kvGetLocalFirst<T>(key: string): Promise<T | undefined> {
  await ready();
  const local = await localGet<T>(key);
  if (!injectedBackend && remoteCache && !remoteKnown.has(key)) {
    void fetchRemoteEntry(key).catch(() => undefined);
  }
  return local ?? (remoteCache?.[key] as T | undefined);
}

export async function kvAdoptAuthoritativeValue(key: string, value: unknown): Promise<void> {
  await localSet(key, value);
  remoteKnown.add(key);
  remoteCache = { ...(remoteCache ?? {}), [key]: value };
}

export function kvForgetCachedAgentSessionEntries(projectId: string): void {
  const isSessionEntry = (key: string): boolean =>
    projectIdFromProjectStoreKey(key) === projectId
    && /^(?:chat:|proposal:|agent-runtime:|agent-artifact:|agent-session-(?:chat|proposal|runtime|artifact):)/.test(key);
  for (const key of remoteKnown) {
    if (isSessionEntry(key)) remoteKnown.delete(key);
  }
  // Never turn a null remoteCache into an empty object: {} is truthy and
  // makes later kvSet/kvGet take the remote branch (and fail) in
  // environments that never bootstrapped a remote store.
  remoteCache = remoteCache === null
    ? null
    : Object.fromEntries(Object.entries(remoteCache).filter(([key]) => !isSessionEntry(key)));
  for (const key of [...freshCache.keys()]) {
    if (isSessionEntry(key)) freshCache.delete(key);
  }
}

export async function kvGet<T>(key: string): Promise<T | undefined> {
  await ready();
  if (remoteCache) {
    try {
      const lastVerified = remoteVerifiedAt.get(key) ?? 0;
      if (key === 'projects' || !remoteKnown.has(key)
        || Date.now() - lastVerified > KV_REMOTE_VERIFY_TTL_MS) {
        await fetchRemoteEntry(key);
        remoteVerifiedAt.set(key, Date.now());
      }
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
    if (!injectedBackend) await markPendingKey(key);
    return;
  }
  if (!remoteCache) {
    // The remote bootstrap failed (desktop IPC / server briefly unreachable).
    // Fall back to a local write marked as pending so a later successful
    // bootstrap merge carries it into the shared store — the same offline
    // semantics as kvGet's local read fallback. Never hard-fail the editor.
    await localSet(key, value);
    await markPendingKey(key);
    return;
  }
  const projectId = key.slice('project:'.length);
  let ownership = browserProjectOwnership(projectId);
  const local = await localGet<unknown>(key);
  if (!ownership && local !== undefined) {
    ownership = await waitForBrowserProjectOwnership(projectId);
    if (!ownership) throw new Error('工程编辑权尚未注册，工程未保存');
  }
  const request: ProjectDocumentWriteRequest = ownership
    ? {
      operation: 'project-document-write',
      key,
      expectedRevision: ownership.baseRevision,
      ownerId: ownership.ownerId,
      ownershipEpoch: ownership.epoch,
      value,
    }
    : { operation: 'project-document-write', key, expectedRevision: null, value };
  let result: ProjectDocumentMutationResponse;
  try {
    result = await requestProjectDocumentMutation(request);
  } catch (error) {
    await disableRemote();
    throw error;
  }
  if (!result.accepted) {
    await cacheMutation(key, result);
    throw new Error('工程已被其他编辑器更新，请手动刷新页面后重试');
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
  if (!remoteCache) {
    await localSet(key, value);
    if (!injectedBackend) await markPendingKey(key);
    return;
  }
  if (!projectStoreWriteCredential()) {
    throw new Error('共享工程库为只读模式（未连接编辑器会话），修改未同步');
  }
  try {
    await requestProjectStore({ operation: 'set', key, value });
  } catch (error) {
    if (isAuthError(error)) {
      throw new Error('共享工程库只读（编辑器会话失效），修改未同步');
    }
    await disableRemote();
    await localSet(key, value);
    await markPendingKey(key);
    return;
  }
  await localSet(key, value);
  await clearPendingKey(key);
  remoteKnown.add(key);
  remoteCache = { ...remoteCache, [key]: value };
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
  return (await localKeys()).filter((key) => key !== MIGRATION_KEY && key !== PENDING_KEYS_KEY);
}

/** Test helper: reset the Node fallback shared by all persistence modules. */
export function resetSharedKvMemory(): void {
  memoryStore.clear();
  remoteCache = null;
  remoteKnown.clear();
  locallyPendingKeys.clear();
  freshCache.clear();
  readyPromise = undefined;
  projectMigrationPending = false;
  injectedBackend = undefined;
  resetProjectStoreTransport();
}
