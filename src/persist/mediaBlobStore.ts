// Local durability for uploaded media: keep a copy of each /media/uploads/*
// blob in IndexedDB so a wiped public/ folder (or new machine clone of only
// ProjectDoc) can re-publish files. Paths stay the same so timeline src still
// works after restore.
// Local-first stand-in for cloud object storage.

const DB_NAME = 'openchatcut-media';
const STORE = 'blobs';
const DB_VERSION = 1;
/** Skip caching giant files to avoid quota thrash (still on disk via /upload). */
const MAX_CACHE_BYTES = 200 * 1024 * 1024;

export interface MediaBlobRecord {
  src: string;
  blob: Blob;
  name: string;
  mime: string;
  bytes: number;
  savedAt: number;
}

const memory = new Map<string, MediaBlobRecord>();
const hasIdb = (): boolean => typeof indexedDB !== 'undefined';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'src' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbPut(rec: MediaBlobRecord): Promise<void> {
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

async function idbGet(src: string): Promise<MediaBlobRecord | undefined> {
  if (!hasIdb()) return memory.get(src);
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(src);
    req.onsuccess = () => resolve(req.result as MediaBlobRecord | undefined);
    req.onerror = () => reject(req.error);
  });
}

async function idbDel(src: string): Promise<void> {
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

/** Test helper. */
export function resetMediaBlobMemory(): void {
  memory.clear();
}

/** Cache a blob under its public src path (best-effort; never throws to callers). */
export async function putMediaBlob(
  src: string,
  data: Blob | File,
  meta?: { name?: string; mime?: string },
): Promise<void> {
  if (!src.startsWith('/media/uploads/')) return;
  const bytes = data.size;
  if (bytes <= 0 || bytes > MAX_CACHE_BYTES) return;
  const name = meta?.name
    ?? (data instanceof File ? data.name : src.split('/').pop() ?? 'file');
  const mime = meta?.mime
    || (data instanceof File ? data.type : data.type)
    || 'application/octet-stream';
  try {
    await idbPut({
      src,
      blob: data,
      name,
      mime,
      bytes,
      savedAt: Date.now(),
    });
  } catch {
    /* quota / private mode — disk upload already succeeded */
  }
}

export async function getMediaBlob(src: string): Promise<MediaBlobRecord | undefined> {
  try {
    return await idbGet(src);
  } catch {
    return undefined;
  }
}

export async function deleteMediaBlob(src: string): Promise<void> {
  try {
    await idbDel(src);
  } catch {
    /* ignore */
  }
}

/** Vite dev of history Fallback will return any missing paths 200 + index.html——To the media path,
 * text/html of"success"Response equals file does not exist(2026-07-17 e2e Actual measurement and capture of disk deletion:false 200
 * cheat detection,Self-healing never triggers)。 */
const isSpaFallback = (res: Response): boolean =>
  (res.headers.get('content-type') ?? '').includes('text/html');

/** True when the same-origin path responds OK (file present on dev disk). */
export async function isMediaSrcReachable(src: string): Promise<boolean> {
  if (!src || src.startsWith('data:')) return true;
  if (src.startsWith('blob:')) {
    // blob: HEAD is prohibited by the specification and can only be verified through GET. Live blob (placeholder in this session's upload) = reachable;
    // The blob that is reopened after being persisted will die (it will become invalid upon refreshing) → fetch throws an error = it is really lost.
    try {
      const res = await fetch(src);
      void res.body?.cancel();
      return true;
    } catch {
      return false;
    }
  }
  if (!src.startsWith('/')) return true; // remote URL — not our job
  try {
    const res = await fetch(src, {
      method: 'GET',
      headers: { Range: 'bytes=0-0' },
      cache: 'no-store',
    });
    const reachable = (res.ok || res.status === 206) && !isSpaFallback(res);
    void res.body?.cancel();
    return reachable;
  } catch {
    return false;
  }
}

/** Parse `/media/uploads/<id>.ext` → assetId (filename stem) for deterministic re-upload. */
export function uploadAssetIdFromSrc(src: string): string | null {
  const m = src.match(/\/media\/uploads\/([^/]+?)(\.[A-Za-z0-9]+)?$/);
  if (!m) return null;
  return m[1].replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80) || null;
}

/**
 * Re-publish a cached blob to the same /media/uploads path (or best-effort same
 * name). Returns the path from the server (usually unchanged).
 */
export async function reuploadMediaBlob(rec: MediaBlobRecord): Promise<string> {
  const assetId = uploadAssetIdFromSrc(rec.src);
  const q = new URLSearchParams({ name: rec.name || 'file' });
  if (assetId) q.set('assetId', assetId);
  const res = await fetch(`/upload?${q.toString()}`, {
    method: 'POST',
    headers: { 'Content-Type': rec.mime || 'application/octet-stream' },
    body: rec.blob,
  });
  if (!res.ok) {
    const info = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(info?.error ?? `reupload failed (${res.status})`);
  }
  const path = (await res.json() as { path: string }).path;
  // If server minted a new name, re-key the cache.
  if (path !== rec.src) {
    await putMediaBlob(path, rec.blob, { name: rec.name, mime: rec.mime });
    await deleteMediaBlob(rec.src);
  }
  return path;
}

export interface EnsureMediaResult {
  ok: string[];
  restored: string[];
  missing: string[];
}

/**
 * For each /media/uploads src: if disk is missing but IDB has the blob, re-upload.
 * Non-upload srcs are skipped. Best-effort; never throws.
 */
export async function ensureMediaSrcs(srcs: string[]): Promise<EnsureMediaResult> {
  const result: EnsureMediaResult = { ok: [], restored: [], missing: [] };
  const unique = [...new Set(srcs.filter((s) => typeof s === 'string' && s.startsWith('/media/uploads/')))];
  for (const src of unique) {
    try {
      if (await isMediaSrcReachable(src)) {
        result.ok.push(src);
        continue;
      }
      const rec = await getMediaBlob(src);
      if (!rec) {
        result.missing.push(src);
        continue;
      }
      const path = await reuploadMediaBlob(rec);
      result.restored.push(path);
    } catch {
      result.missing.push(src);
    }
  }
  return result;
}
