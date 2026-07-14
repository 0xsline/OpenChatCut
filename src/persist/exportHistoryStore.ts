// Export history (源站无据, 自定: export_history 不在 52 个 MCP 工具里, 是网页版
// 应用内行为). GLOBAL, single-user clone: one key holds every finished export, newest
// first. Same kv db as projectStore/templateStore; idb helper is module-private
// (不改 projectStore.ts). Persisted data is untrusted → validated on read.

const DB_NAME = 'chatcut-clone';
const STORE = 'kv';
const KEY = 'export:history';
// ponytail: cap so the list can't grow unbounded across a long session; a
// single-user clone won't realistically exceed this. Raise if it ever matters.
const MAX_RECORDS = 200;

export interface ExportRecord {
  id: string;
  /** download filename */
  name: string;
  /** 'video' | 'audio' | 'subtitles' | 'xml' */
  format: string;
  codec?: string;
  sizeBytes?: number;
  /** half-open [start, end) frame range for a partial export */
  frameRange?: { start: number; end: number };
  /** caller-supplied timestamp (ms epoch) */
  createdAt: number;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbGet<T>(key: string): Promise<T | undefined> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(key);
    req.onsuccess = () => resolve(req.result as T | undefined);
    req.onerror = () => reject(req.error);
  });
}

async function idbSet(key: string, val: unknown): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(val, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// Boundary validation: drop corrupt/partial persisted entries rather than trust them.
function toValidRecord(v: unknown): ExportRecord | null {
  if (!v || typeof v !== 'object') return null;
  const r = v as Partial<ExportRecord>;
  if (typeof r.id !== 'string' || typeof r.name !== 'string' || typeof r.format !== 'string' || typeof r.createdAt !== 'number') return null;
  const range = r.frameRange && typeof r.frameRange.start === 'number' && typeof r.frameRange.end === 'number'
    ? { start: r.frameRange.start, end: r.frameRange.end } : undefined;
  return {
    id: r.id, name: r.name, format: r.format, createdAt: r.createdAt,
    ...(typeof r.codec === 'string' ? { codec: r.codec } : {}),
    ...(typeof r.sizeBytes === 'number' ? { sizeBytes: r.sizeBytes } : {}),
    ...(range ? { frameRange: range } : {}),
  };
}

async function readAll(): Promise<ExportRecord[]> {
  const raw = await idbGet<unknown>(KEY);
  if (!Array.isArray(raw)) return [];
  return raw.map(toValidRecord).filter((r): r is ExportRecord => r !== null);
}

const newId = () =>
  (typeof crypto !== 'undefined' && crypto.randomUUID)
    ? crypto.randomUUID()
    : `exp_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;

/** Append one finished export (id generated here; caller passes createdAt).
 * Stored newest-first and capped; persist failures are swallowed (in-session UX unaffected). */
export async function recordExport(rec: Omit<ExportRecord, 'id'>): Promise<void> {
  try {
    const entry: ExportRecord = { ...rec, id: newId() };
    const next = [entry, ...await readAll()].slice(0, MAX_RECORDS);
    await idbSet(KEY, next);
  } catch {
    /* ignore persist failures */
  }
}

/** Recent exports, newest-first, capped to `limit` (default 50). */
export async function listExportHistory(limit = 50): Promise<ExportRecord[]> {
  try {
    const all = await readAll();
    return limit > 0 ? all.slice(0, limit) : all;
  } catch {
    return [];
  }
}

export async function clearExportHistory(): Promise<void> {
  try {
    await idbSet(KEY, []);
  } catch {
    /* ignore */
  }
}
