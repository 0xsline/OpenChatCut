import { SEMANTIC_MODEL_VERSION, type SemanticVectorRecord, type SemanticMatch } from './types';
import {
  projectStoreRemoteAvailable,
  projectStoreWriteCredential,
  requestProjectStore,
} from '../../persist/projectStoreTransport';
import { readSamplingConfig } from './samplingConfig';

const DATABASE_NAME = 'openchatcut-semantic-index';
const STORE_NAME = 'vectors';
const DATABASE_VERSION = 2;
const SCOPE_MODEL_INDEX = 'by-scope-model';
const SCOPE_ASSET_INDEX = 'by-scope-asset';
const SAMPLE_TIME_KEY_PRECISION = 3;
/** Session-level flag: once the server-side index proves unavailable, stay local. */
let remoteSemanticFailed = false;
type PromiseResolvers<T> = {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
};
const promiseConstructor = Promise as unknown as {
  withResolvers<T>(): PromiseResolvers<T>;
};
const mutationQueues = new Map<string, Promise<unknown>>();

function serializeScopeMutation<T>(scopeId: string, operation: () => Promise<T>): Promise<T> {
  const previous = mutationQueues.get(scopeId) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(operation);
  mutationQueues.set(scopeId, current);
  return current.finally(() => {
    if (mutationQueues.get(scopeId) === current) mutationQueues.delete(scopeId);
  });
}

interface StoredVector {
  key: string;
  modelVersion: string;
  scopeId?: string;
  assetId: string;
  sampleTime: number;
  sourceRevision?: string;
  sceneId?: string;
  sceneStart?: number;
  sceneEnd?: number;
  vector: Float32Array;
}

const recordKey = (record: SemanticVectorRecord) =>
  `${SEMANTIC_MODEL_VERSION}:${record.scopeId}:${record.assetId}:${record.sourceRevision ?? 'legacy'}:${record.sampleTime.toFixed(SAMPLE_TIME_KEY_PRECISION)}`;

function openDatabase(): Promise<IDBDatabase> {
  const { promise, resolve, reject } = promiseConstructor.withResolvers<IDBDatabase>();
  const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
  request.onupgradeneeded = () => {
    const database = request.result;
    const store = database.objectStoreNames.contains(STORE_NAME)
      ? request.transaction!.objectStore(STORE_NAME)
      : database.createObjectStore(STORE_NAME, { keyPath: 'key' });
    if (!store.indexNames.contains(SCOPE_MODEL_INDEX)) {
      store.createIndex(SCOPE_MODEL_INDEX, ['scopeId', 'modelVersion']);
    }
    if (!store.indexNames.contains(SCOPE_ASSET_INDEX)) {
      store.createIndex(SCOPE_ASSET_INDEX, ['scopeId', 'assetId']);
    }
  };
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error ?? new Error('Unable to open semantic index'));
  return promise;
}

async function withStore<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore, resolve: (value: T) => void, reject: (reason?: unknown) => void) => void,
): Promise<T> {
  const database = await openDatabase();
  const { promise, resolve, reject } = promiseConstructor.withResolvers<T>();
  const transaction = database.transaction(STORE_NAME, mode);
  const finish = (value: T) => { database.close(); resolve(value); };
  const fail = (reason?: unknown) => { database.close(); reject(reason); };
  transaction.onerror = () => fail(transaction.error);
  run(transaction.objectStore(STORE_NAME), finish, fail);
  return promise;
}

function remoteSemanticAvailable(): boolean {
  return !remoteSemanticFailed && projectStoreRemoteAvailable() && projectStoreWriteCredential();
}

function toWireVector(vector: ArrayLike<number>): number[] {
  return Array.from(vector);
}

/** Server-side TopK search (sqlite-vec); falls back to local ranking on failure. */
export async function searchSemanticVectorsRemote(
  scopeId: string,
  queryVector: ArrayLike<number>,
  limit?: number,
): Promise<SemanticMatch[] | null> {
  if (remoteSemanticFailed) return null;
  if (!projectStoreRemoteAvailable()) return null;
  const config = readSamplingConfig();
  try {
    const response = await requestProjectStore({
      operation: 'semantic-vectors-search',
      scopeId,
      queryVector: toWireVector(queryVector),
      limit: limit ?? config.resultLimit,
    });
    const hits = (response as { semanticVectors?: Array<{
      assetId: string;
      sampleTime: number;
      sourceRevision?: string | null;
      sceneId?: string | null;
      sceneStart?: number | null;
      sceneEnd?: number | null;
      distance: number;
    }> }).semanticVectors;
    if (!hits) return null;
    // Normalized vectors: cosine = 1 - d²/2. Scene-less rows carry '' defaults.
    return hits.map((hit) => ({
      assetId: hit.assetId,
      sampleTime: hit.sampleTime,
      sourceRevision: hit.sourceRevision ?? undefined,
      sceneId: hit.sceneId || undefined,
      sceneStart: hit.sceneStart != null && hit.sceneStart >= 0 ? hit.sceneStart : undefined,
      sceneEnd: hit.sceneEnd != null && hit.sceneEnd >= 0 ? hit.sceneEnd : undefined,
      score: Math.max(0, 1 - hit.distance * hit.distance / 2),
    }));
  } catch {
    remoteSemanticFailed = true; // e.g. server-side index unavailable (not migrated)
    return null;
  }
}

export async function readSemanticVectors(scopeId: string): Promise<SemanticVectorRecord[]> {
  return withStore('readonly', (store, resolve, reject) => {
    const request = store.index(SCOPE_MODEL_INDEX).getAll(IDBKeyRange.only([scopeId, SEMANTIC_MODEL_VERSION]));
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve((request.result as StoredVector[])
      .map((item) => ({
        scopeId,
        assetId: item.assetId,
        sourceRevision: item.sourceRevision,
        sampleTime: item.sampleTime,
        sceneId: item.sceneId,
        sceneStart: item.sceneStart,
        sceneEnd: item.sceneEnd,
        vector: item.vector,
      })));
  });
}

export function replaceAssetVectors(
  scopeId: string,
  assetId: string,
  records: SemanticVectorRecord[],
): Promise<void> {
  return serializeScopeMutation(scopeId, async () => {
    if (remoteSemanticAvailable()) {
      try {
        await requestProjectStore({
          operation: 'semantic-vectors-upsert',
          scopeId,
          assetId,
          samples: records.map((record) => ({
            assetId: record.assetId,
            sampleTime: record.sampleTime,
            sourceRevision: record.sourceRevision,
            sceneId: record.sceneId,
            sceneStart: record.sceneStart,
            sceneEnd: record.sceneEnd,
            vector: toWireVector(record.vector),
          })),
        });
      } catch {
        remoteSemanticFailed = true;
      }
    }
    // Local cache stays in sync either way (offline fallback + IDB cache);
    // a cache failure must never break indexing (server copy is authoritative).
    await withStore<void>('readwrite', (store, resolve, reject) => {
      const request = store.index(SCOPE_ASSET_INDEX).getAllKeys(IDBKeyRange.only([scopeId, assetId]));
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        for (const key of request.result) store.delete(key);
        for (const record of records) store.put(toStoredVector(record));
        store.transaction.oncomplete = () => resolve();
      };
    }).catch(() => undefined);
  });
}

export interface PruneSemanticResult {
  staleModelRemoved: boolean;
  staleSourceRemoved: boolean;
}

export async function pruneSemanticVectors(
  scopeId: string,
  validAssetIds: Set<string>,
  validSourceRevisions?: ReadonlyMap<string, string>,
): Promise<PruneSemanticResult> {
  return serializeScopeMutation(scopeId, async () => {
    if (remoteSemanticAvailable()) {
      try {
        await requestProjectStore({
          operation: 'semantic-vectors-prune',
          scopeId,
          validAssetIds: [...validAssetIds],
          validSourceRevisions: validSourceRevisions ? Object.fromEntries(validSourceRevisions) : undefined,
        });
      } catch {
        remoteSemanticFailed = true;
      }
    }
    const existing = await readStoredVectors();
    const staleModelRemoved = existing.some((item) => item.scopeId === scopeId
      && item.modelVersion !== SEMANTIC_MODEL_VERSION);
    const staleSourceRemoved = validSourceRevisions !== undefined && existing.some((item) => (
      item.scopeId === scopeId
      && item.modelVersion === SEMANTIC_MODEL_VERSION
      && validAssetIds.has(item.assetId)
      && item.sourceRevision !== validSourceRevisions.get(item.assetId)
    ));
    await withStore<void>('readwrite', (store, resolve) => {
      for (const item of existing) {
        if (shouldPruneVector(item, scopeId, validAssetIds, validSourceRevisions)) store.delete(item.key);
      }
      store.transaction.oncomplete = () => resolve();
    }).catch(() => undefined);
    return { staleModelRemoved, staleSourceRemoved };
  });
}

export function shouldPruneVector(
  item: Pick<StoredVector, 'scopeId' | 'modelVersion' | 'assetId' | 'sourceRevision'>,
  scopeId: string,
  validAssetIds: Set<string>,
  validSourceRevisions?: ReadonlyMap<string, string>,
): boolean {
  if (item.scopeId == null) return true;
  if (item.scopeId !== scopeId) return false;
  return item.modelVersion !== SEMANTIC_MODEL_VERSION
    || !validAssetIds.has(item.assetId)
    || (validSourceRevisions !== undefined
      && item.sourceRevision !== validSourceRevisions.get(item.assetId));
}

export async function clearSemanticVectors(scopeId: string): Promise<void> {
  return serializeScopeMutation(scopeId, async () => {
    if (remoteSemanticAvailable()) {
      try {
        await requestProjectStore({ operation: 'semantic-vectors-clear', scopeId });
      } catch {
        remoteSemanticFailed = true;
      }
    }
    const existing = await readStoredVectors();
    await withStore<void>('readwrite', (store, resolve) => {
      for (const item of existing) if (item.scopeId === scopeId) store.delete(item.key);
      store.transaction.oncomplete = () => resolve();
    }).catch(() => undefined);
  });
}

async function readStoredVectors(): Promise<StoredVector[]> {
  if (typeof indexedDB === 'undefined') return [];
  return withStore<StoredVector[]>('readonly', (store, resolve, reject) => {
    const request = store.getAll();
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result as StoredVector[]);
  }).catch(() => [] as StoredVector[]);
}

function toStoredVector(record: SemanticVectorRecord): StoredVector {
  return {
    key: recordKey(record),
    modelVersion: SEMANTIC_MODEL_VERSION,
    scopeId: record.scopeId,
    assetId: record.assetId,
    sourceRevision: record.sourceRevision,
    sceneId: record.sceneId,
    sceneStart: record.sceneStart,
    sceneEnd: record.sceneEnd,
    sampleTime: record.sampleTime,
    vector: new Float32Array(record.vector),
  };
}
