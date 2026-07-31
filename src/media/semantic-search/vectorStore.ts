import { SEMANTIC_MODEL_VERSION, type SemanticVectorRecord } from './types';

const DATABASE_NAME = 'openchatcut-semantic-index';
const STORE_NAME = 'vectors';
const DATABASE_VERSION = 2;
const SCOPE_MODEL_INDEX = 'by-scope-model';
const SCOPE_ASSET_INDEX = 'by-scope-asset';
const SAMPLE_TIME_KEY_PRECISION = 3;
type PromiseResolvers<T> = {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
};
const promiseConstructor = Promise as unknown as {
  withResolvers<T>(): PromiseResolvers<T>;
};

interface StoredVector {
  key: string;
  modelVersion: string;
  scopeId?: string;
  assetId: string;
  sampleTime: number;
  vector: Float32Array;
}

const recordKey = (scopeId: string, assetId: string, sampleTime: number) =>
  `${SEMANTIC_MODEL_VERSION}:${scopeId}:${assetId}:${sampleTime.toFixed(SAMPLE_TIME_KEY_PRECISION)}`;

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

export async function readSemanticVectors(scopeId: string): Promise<SemanticVectorRecord[]> {
  return withStore('readonly', (store, resolve, reject) => {
    const request = store.index(SCOPE_MODEL_INDEX).getAll(IDBKeyRange.only([scopeId, SEMANTIC_MODEL_VERSION]));
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve((request.result as StoredVector[])
      .map((item) => ({ scopeId, assetId: item.assetId, sampleTime: item.sampleTime, vector: item.vector })));
  });
}

export async function replaceAssetVectors(scopeId: string, assetId: string, records: SemanticVectorRecord[]): Promise<void> {
  await withStore<void>('readwrite', (store, resolve, reject) => {
    const request = store.index(SCOPE_ASSET_INDEX).getAllKeys(IDBKeyRange.only([scopeId, assetId]));
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      for (const key of request.result) store.delete(key);
      for (const record of records) store.put(toStoredVector(record));
      store.transaction.oncomplete = () => resolve();
    };
  });
}

export interface PruneSemanticResult {
  staleModelRemoved: boolean;
}

export async function pruneSemanticVectors(scopeId: string, validAssetIds: Set<string>): Promise<PruneSemanticResult> {
  const existing = await readStoredVectors();
  const staleModelRemoved = existing.some((item) => item.scopeId === scopeId
    && item.modelVersion !== SEMANTIC_MODEL_VERSION);
  await withStore<void>('readwrite', (store, resolve) => {
    for (const item of existing) {
      if (shouldPruneVector(item, scopeId, validAssetIds)) store.delete(item.key);
    }
    store.transaction.oncomplete = () => resolve();
  });
  return { staleModelRemoved };
}

export function shouldPruneVector(
  item: Pick<StoredVector, 'scopeId' | 'modelVersion' | 'assetId'>,
  scopeId: string,
  validAssetIds: Set<string>,
): boolean {
  if (item.scopeId == null) return true;
  if (item.scopeId !== scopeId) return false;
  return item.modelVersion !== SEMANTIC_MODEL_VERSION || !validAssetIds.has(item.assetId);
}

export async function clearSemanticVectors(scopeId: string): Promise<void> {
  const existing = await readStoredVectors();
  await withStore<void>('readwrite', (store, resolve) => {
    for (const item of existing) if (item.scopeId === scopeId) store.delete(item.key);
    store.transaction.oncomplete = () => resolve();
  });
}

async function readStoredVectors(): Promise<StoredVector[]> {
  return withStore('readonly', (store, resolve, reject) => {
    const request = store.getAll();
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result as StoredVector[]);
  });
}

function toStoredVector(record: SemanticVectorRecord): StoredVector {
  return {
    key: recordKey(record.scopeId, record.assetId, record.sampleTime),
    modelVersion: SEMANTIC_MODEL_VERSION,
    scopeId: record.scopeId,
    assetId: record.assetId,
    sampleTime: record.sampleTime,
    vector: new Float32Array(record.vector),
  };
}
