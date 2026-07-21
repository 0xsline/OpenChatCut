import { SEMANTIC_MODEL_VERSION, type SemanticVectorRecord } from './types';

const DATABASE_NAME = 'openchatcut-semantic-index';
const STORE_NAME = 'vectors';
const DATABASE_VERSION = 1;
const SAMPLE_TIME_KEY_PRECISION = 3;

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
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE_NAME, { keyPath: 'key' });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Unable to open semantic index'));
  });
}

async function withStore<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore, resolve: (value: T) => void, reject: (reason?: unknown) => void) => void,
): Promise<T> {
  const database = await openDatabase();
  return new Promise<T>((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, mode);
    const finish = (value: T) => { database.close(); resolve(value); };
    transaction.onerror = () => { database.close(); reject(transaction.error); };
    run(transaction.objectStore(STORE_NAME), finish, reject);
  });
}

export async function readSemanticVectors(scopeId: string): Promise<SemanticVectorRecord[]> {
  return withStore('readonly', (store, resolve, reject) => {
    const request = store.getAll();
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve((request.result as StoredVector[])
      .filter((item) => item.modelVersion === SEMANTIC_MODEL_VERSION && item.scopeId === scopeId)
      .map((item) => ({ scopeId, assetId: item.assetId, sampleTime: item.sampleTime, vector: Array.from(item.vector) })));
  });
}

export async function replaceAssetVectors(scopeId: string, assetId: string, records: SemanticVectorRecord[]): Promise<void> {
  const existing = await readStoredVectors();
  await withStore<void>('readwrite', (store, resolve) => {
    for (const item of existing) {
      if (item.scopeId === scopeId && item.assetId === assetId) store.delete(item.key);
    }
    for (const record of records) store.put(toStoredVector(record));
    store.transaction.oncomplete = () => resolve();
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
