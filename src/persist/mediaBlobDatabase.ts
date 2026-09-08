// Browser fallback durability for /media/uploads/* blobs. A local server can
// explicitly advertise that its filesystem path is authoritative; otherwise a
// bounded IndexedDB copy preserves pure-web/offline restore behavior. Paths stay
// stable so persisted projects can re-publish missing media after reopening.

const DB_NAME = 'openchatcut-media';
const STORE = 'blobs';
const DB_VERSION = 1;
export const MAX_FILE_CACHE_BYTES = 200 * 1024 * 1024;
export const MAX_TOTAL_CACHE_BYTES = 1024 * 1024 * 1024;
export interface MediaBlobRecord {
  src: string;
  blob: Blob;
  name: string;
  mime: string;
  bytes: number;
  savedAt: number;
  lastAccessedAt?: number;
  sourceRevision?: string;
  sourceSize?: number;
  sourceModifiedAt?: number;
  /** Internal CAS identity for one in-flight project-import publication. */
  importPublicationId?: string;
}

const memory = new Map<string, MediaBlobRecord>();
const hasIdb = (): boolean => typeof indexedDB !== 'undefined';
const writeQueues = new Map<string, Promise<void>>();
let capacityQueue: Promise<void> = Promise.resolve();

export interface MediaBlobWriteMeta {
  name?: string;
  mime?: string;
  sourceRevision?: string;
  sourceSize?: number;
  sourceModifiedAt?: number;
  /** Final guard supplied by a live asset owner for delayed cache commits. */
  isSourceRevisionCurrent?: (revision: string) => boolean;
}

function normalizeRecord(value: MediaBlobRecord): MediaBlobRecord | null {
  if (!value || typeof value.src !== 'string' || !(value.blob instanceof Blob)
    || typeof value.name !== 'string' || typeof value.mime !== 'string') return null;
  const savedAt = Number.isFinite(value.savedAt) ? value.savedAt : Date.now();
  const {
    sourceRevision,
    sourceSize,
    sourceModifiedAt,
    ...rest
  } = value;
  return {
    ...rest,
    bytes: value.blob.size,
    savedAt,
    lastAccessedAt: typeof value.lastAccessedAt === 'number' && Number.isFinite(value.lastAccessedAt) ? value.lastAccessedAt : savedAt,
    ...(typeof sourceRevision === 'string' && sourceRevision ? { sourceRevision } : {}),
    ...(typeof sourceSize === 'number' && Number.isFinite(sourceSize) ? { sourceSize } : {}),
    ...(typeof sourceModifiedAt === 'number' && Number.isFinite(sourceModifiedAt) ? { sourceModifiedAt } : {}),
  };
}

// Reuse successful connections; a failed open must remain retryable.
let dbPromise: Promise<IDBDatabase> | undefined;
function openDb(): Promise<IDBDatabase> {
  dbPromise ??= new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'src' });
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => { db.close(); dbPromise = undefined; };
      db.onclose = () => { dbPromise = undefined; };
      resolve(db);
    };
    req.onerror = () => reject(req.error);
  }).catch((error) => {
    dbPromise = undefined;
    throw error;
  });
  return dbPromise;
}
interface StoredBlobMeta { src: string; bytes: number; lastAccessedAt: number }

export async function idbMetadata(): Promise<StoredBlobMeta[]> {
  const metaOf = (value: MediaBlobRecord): StoredBlobMeta | null => {
    const record = normalizeRecord(value);
    return record ? {
      src: record.src,
      bytes: record.blob.size,
      lastAccessedAt: record.lastAccessedAt ?? record.savedAt,
    } : null;
  };
  if (!hasIdb()) {
    return [...memory.values()].map(metaOf).filter((value): value is StoredBlobMeta => value !== null);
  }
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const values: StoredBlobMeta[] = [];
    const request = db.transaction(STORE, 'readonly').objectStore(STORE).openCursor();
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) { resolve(values); return; }
      const meta = metaOf(cursor.value as MediaBlobRecord);
      if (meta) values.push(meta);
      cursor.continue();
    };
    request.onerror = () => reject(request.error);
  });
}
export function enqueueSourceWrite<T>(src: string, work: () => Promise<T>): Promise<T> {
  const previous = writeQueues.get(src) ?? Promise.resolve();
  const run = previous.catch(() => undefined).then(work);
  const settled = run.then(() => undefined, () => undefined);
  writeQueues.set(src, settled);
  void settled.finally(() => {
    if (writeQueues.get(src) === settled) writeQueues.delete(src);
  });
  return run;
}

export function enqueueCapacityWrite<T>(work: () => Promise<T>): Promise<T> {
  const run = capacityQueue.catch(() => undefined).then(work);
  capacityQueue = run.then(() => undefined, () => undefined);
  return run;
}

export async function idbPut(rec: MediaBlobRecord): Promise<void> {
  if (!hasIdb()) {
    memory.set(rec.src, rec);
    return;
  }
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(rec);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function idbGet(src: string): Promise<MediaBlobRecord | undefined> {
  if (!hasIdb()) return normalizeRecord(memory.get(src) as MediaBlobRecord) ?? undefined;
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(src);
    req.onsuccess = () => {
      resolve(normalizeRecord(req.result as MediaBlobRecord) ?? undefined);
    };
    req.onerror = () => reject(req.error);
  });
}

export async function idbDel(src: string): Promise<void> {
  if (!hasIdb()) {
    memory.delete(src);
    return;
  }
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(src);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
export async function idbDelPrefix(prefix: string): Promise<void> {
  if (!hasIdb()) {
    for (const src of memory.keys()) {
      if (src.startsWith(prefix)) memory.delete(src);
    }
    return;
  }
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    const request = tx.objectStore(STORE).openCursor();
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      if (typeof cursor.key === 'string' && cursor.key.startsWith(prefix)) cursor.delete();
      cursor.continue();
    };
    request.onerror = () => reject(request.error);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/** Test helper. */
export function resetMediaBlobMemory(): void {
  memory.clear();
  writeQueues.clear();
  capacityQueue = Promise.resolve();
}
