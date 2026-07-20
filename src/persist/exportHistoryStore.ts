// Export history — an in-app action, not an agent tool.
// GLOBAL, single-user: one key holds every finished export, newest
// first. Same shared server-backed KV as projectStore/templateStore.
// Persisted data is untrusted → validated on read.
import { kvGet as idbGet, kvSet as idbSet } from './sharedKv';

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
