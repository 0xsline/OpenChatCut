// JSON→SQLite import for the project store (RFC phase 1).
//
// Triggered once, when the SQLite backend is enabled and no completion
// receipt exists yet. Idempotent by construction: already-imported keys are
// skipped on hash match and refreshed on mismatch; batches commit every
// IMPORT_BATCH_SIZE keys so a crash keeps committed progress and the next
// start resumes (receipt-less state → resume).
//
// The JSON directory is only ever READ here — it is never modified, moved or
// deleted. Old-version software, rollbacks and rescue tools keep full access
// to the original data (see docs/storage-sqlite-rfc.md §12).
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { runtimeProfile } from '../runtime-profile.ts';

const IMPORT_BATCH_SIZE = 100;
const RECEIPT_FILE = 'project-store-v1.sqlite3.receipt.json';

/** Phase 1 = JSON dir keys; phase 2 adds generation-jobs + deleted-projects. */
export const RECEIPT_PHASE = 2;
/** kv keys for the phase-2 auxiliary files (server-managed JSON files). */
export const GENERATION_JOBS_KV_KEY = 'generation-jobs:snapshot';
export const DELETED_PROJECTS_KV_KEY = 'deleted-projects:v1';

const sha256 = (buf: Buffer): string => createHash('sha256').update(buf).digest('hex');

export interface ImportSummary {
  /** Newly inserted or refreshed (source file newer than the stored row). */
  imported: number;
  /** Already present with an identical content hash. */
  skipped: number;
  /** Unreadable / unparseable files; skipped, never blocking other keys. */
  quarantined: number;
  receiptWritten: boolean;
}

export interface ImportReceipt {
  source: string;
  count: number;
  importedAt: string;
  /** 1 = JSON dir only; 2 = + generation-jobs + deleted-projects. */
  phase?: number;
  /** key → sha256 of the ORIGINAL file bytes (verification anchor). */
  keys: Record<string, string>;
}

export function readImportReceipt(): ImportReceipt | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(receiptPath(), 'utf8'));
    if (!parsed || typeof parsed !== 'object') return null;
    const receipt = parsed as Partial<ImportReceipt>;
    if (typeof receipt.source !== 'string' || typeof receipt.count !== 'number') return null;
    if (!receipt.keys || typeof receipt.keys !== 'object') return null;
    return receipt as ImportReceipt;
  } catch {
    return null;
  }
}

function jsonStoreDir(): string {
  return runtimeProfile().projectStore.directory;
}

function receiptPath(): string {
  return join(runtimeProfile().rootDir, RECEIPT_FILE);
}

/**
 * Import (or resume importing) the JSON-file store into `db`.
 *
 * Receipt-gated and phase-versioned: phase 1 imports the JSON directory
 * (project/chat/versions/...), phase 2 additionally imports the two
 * server-managed auxiliary files (generation operations + deleted-projects
 * tombstone). An existing phase-1 receipt is upgraded in place, so users who
 * migrated on an earlier build get the auxiliary data on the next start
 * (without it, deleted projects would resurface from an empty tombstone).
 */
export function ensureJsonImported(db: DatabaseSync): ImportSummary {
  const summary: ImportSummary = { imported: 0, skipped: 0, quarantined: 0, receiptWritten: false };
  const existingReceipt = readImportReceipt();
  if (existingReceipt && (existingReceipt.phase ?? 1) >= RECEIPT_PHASE) return summary;

  const dir = jsonStoreDir();
  const keys: Record<string, string> = { ...existingReceipt?.keys };

  // Phase 1: the JSON directory (only when no receipt exists yet).
  if (!existingReceipt) {
    let files: string[];
    try {
      files = readdirSync(dir).filter((name) => name.endsWith('.json')).sort();
    } catch {
      files = [];
    }
    if (files.length > 0) {
      const select = db.prepare('SELECT v FROM kv WHERE k = ?');
      const upsert = db.prepare(
        'INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v',
      );
      db.exec('BEGIN');
      try {
        for (const [index, file] of files.entries()) {
          if (index > 0 && index % IMPORT_BATCH_SIZE === 0) {
            db.exec('COMMIT');
            db.exec('BEGIN');
          }
          let key: string;
          try {
            key = decodeURIComponent(file.slice(0, -'.json'.length));
          } catch {
            summary.quarantined++;
            continue;
          }
          let buf: Buffer;
          try {
            buf = readFileSync(join(dir, file));
          } catch {
            summary.quarantined++;
            continue;
          }
          try {
            JSON.parse(buf.toString('utf8')); // parse-check only; content is never interpreted
          } catch {
            summary.quarantined++;
            continue;
          }
          const existing = select.get(key) as { v: string } | undefined;
          const fileHash = sha256(buf);
          if (existing && sha256(Buffer.from(existing.v, 'utf8')) === fileHash) {
            summary.skipped++;
          } else {
            // Store the ORIGINAL text: byte-identical to the source file.
            upsert.run(key, buf.toString('utf8'));
            summary.imported++;
          }
          keys[key] = fileHash;
        }
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    }
  }

  // Phase 2: auxiliary server-managed files (also upgrades phase-1 receipts).
  if (!existingReceipt || (existingReceipt.phase ?? 1) < 2) {
    importAuxFile(db, join(runtimeProfile().rootDir, 'generation-operations-v1.json'), GENERATION_JOBS_KV_KEY, summary, keys);
    importAuxFile(db, join(runtimeProfile().rootDir, 'deleted-projects-v1.json'), DELETED_PROJECTS_KV_KEY, summary, keys);
  }

  if (!existingReceipt || (existingReceipt.phase ?? 1) < 2) {
    writeFileSync(receiptPath(), JSON.stringify({
      source: dir,
      count: Object.keys(keys).length,
      importedAt: new Date().toISOString(),
      phase: RECEIPT_PHASE,
      keys,
    } satisfies ImportReceipt, null, 2), { mode: 0o600 });
    summary.receiptWritten = true;
  }
  return summary;
}

/** Read one auxiliary file (absent → skip), hash-check and upsert into kv. */
function importAuxFile(
  db: DatabaseSync,
  path: string,
  kvKey: string,
  summary: ImportSummary,
  keys: Record<string, string>,
): void {
  let buf: Buffer;
  try {
    buf = readFileSync(path);
  } catch {
    return; // file absent on this machine — nothing to import
  }
  try {
    JSON.parse(buf.toString('utf8'));
  } catch {
    summary.quarantined++;
    return;
  }
  const select = db.prepare('SELECT v FROM kv WHERE k = ?');
  const upsert = db.prepare(
    'INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v',
  );
  const existing = select.get(kvKey) as { v: string } | undefined;
  if (existing) {
    // The kv row is authoritative once present: runtime writes (e.g. a newer
    // tombstone) must never be overwritten by the archived file.
    summary.skipped++;
    return;
  }
  const fileHash = sha256(buf);
  upsert.run(kvKey, buf.toString('utf8'));
  summary.imported++;
  keys[kvKey] = fileHash;
}
