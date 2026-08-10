// SQLite-backed project store backend — phase 0 skeleton (opt-in).
//
// OPENCHATCUT_SQLITE_STORE=1 switches the server-side project store from the
// JSON-file store (project-store-v1/) to a single SQLite database (WAL).
// Disabled by default: without the env var every code path behaves exactly as
// before (zero regression — the switch lives at the file-I/O primitives only).
//
// Phase 0 scope: interface-parity skeleton only. The JSON→SQLite import
// (receipt + idempotent re-import + crash recovery) is phase 1
// (see docs/storage-sqlite-rfc.md §5).
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { runtimeProfile } from '../runtime-profile.ts';
import { ensureJsonImported, readImportReceipt, type ImportSummary } from './sqlite-migration.ts';

export interface StoredEntryValue {
  found: boolean;
  value?: unknown;
}

export const SQLITE_STORE_ENV = 'OPENCHATCUT_SQLITE_STORE';

/**
 * Opt-in switch. Enabled when: the env var is '1', OR the user has explicitly
 * run the migration (receipt present + database file exists). An explicit
 * env value other than '1' (e.g. '0') forces the backend off — tests and
 * legacy verifiers rely on the JSON-file path. Without any env, every code
 * path behaves exactly as before the migration feature.
 */
export function sqliteStoreEnabled(): boolean {
  const env = process.env[SQLITE_STORE_ENV];
  if (env === '1') return true;
  if (env !== undefined) return false; // explicit override (e.g. '0')
  // User-initiated migration: receipt marks completion, the database file
  // guards against a receipt left behind after the file was removed.
  return readImportReceipt() !== null && existsSync(storePath());
}

export function storePath(): string {
  const profile = runtimeProfile();
  // Sits next to project-store-v1/ (never inside it: the JSON store scans its
  // own directory and must not see foreign files).
  return join(profile.rootDir, 'project-store-v1.sqlite3');
}

let database: DatabaseSync | null = null;

function openDatabase(): DatabaseSync {
  if (database) return database;
  const path = storePath();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS kv (
      k TEXT PRIMARY KEY,
      v TEXT NOT NULL
    );
  `);
  database = db;
  return db;
}

/**
 * Run the JSON→SQLite import (user-initiated migration; see
 * StorageMigrationDialog). Idempotent and receipt-gated.
 */
export function sqliteImportJson(): ImportSummary {
  return ensureJsonImported(openDatabase());
}

/** Migration status for the UI (never opens or mutates the store). */
export function sqliteMigrationStatus(): {
  enabled: boolean;
  receipt: { count: number; importedAt: string } | null;
  jsonKeyCount: number;
  sqliteKeyCount: number;
} {
  const receipt = readImportReceipt();
  const dir = runtimeProfile().projectStore.directory;
  let jsonKeyCount = 0;
  try {
    jsonKeyCount = readdirSync(dir).filter((name) => name.endsWith('.json')).length;
  } catch {
    // No JSON directory yet.
  }
  let sqliteKeyCount = 0;
  if (existsSync(storePath())) {
    try {
      const row = openDatabase().prepare('SELECT count(*) AS n FROM kv').get() as { n: number };
      sqliteKeyCount = row.n;
    } catch {
      // Read-only diagnostics; never throw for the UI.
    }
  }
  return {
    enabled: sqliteStoreEnabled(),
    receipt: receipt ? { count: receipt.count, importedAt: receipt.importedAt } : null,
    jsonKeyCount,
    sqliteKeyCount,
  };
}

/** Close the connection (verify isolation / profile switches). */
export function resetSqliteStoreForTests(): void {
  database?.close();
  database = null;
}

const encode = (value: unknown): string => JSON.stringify(value);
const decode = (raw: string): unknown => JSON.parse(raw);

/** Full snapshot (equivalent of readDirectoryEntries). */
export async function sqliteReadAll(): Promise<Record<string, unknown>> {
  const rows = openDatabase().prepare('SELECT k, v FROM kv').all() as Array<{
    k: string;
    v: string;
  }>;
  const entries: Record<string, unknown> = {};
  for (const row of rows) entries[row.k] = decode(row.v);
  return entries;
}

/** Single key read (equivalent of readEntryFile). */
export async function sqliteReadEntry(key: string): Promise<StoredEntryValue> {
  const row = openDatabase().prepare('SELECT v FROM kv WHERE k = ?').get(key) as
    | { v: string }
    | undefined;
  return row ? { found: true, value: decode(row.v) } : { found: false };
}

/** Single key write (equivalent of writeStoredEntry). */
export async function sqliteWriteEntry(key: string, value: unknown): Promise<void> {
  openDatabase()
    .prepare('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v')
    .run(key, encode(value));
}

/** Full replace in one transaction (equivalent of writeEntries). */
export async function sqliteWriteAll(entries: Record<string, unknown>): Promise<void> {
  const db = openDatabase();
  const stmt = db.prepare(
    'INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v',
  );
  db.exec('BEGIN');
  try {
    for (const [key, value] of Object.entries(entries)) stmt.run(key, encode(value));
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

/** Single key delete (equivalent of durableRemove(entryPath)). */
export async function sqliteDeleteEntry(key: string): Promise<void> {
  openDatabase().prepare('DELETE FROM kv WHERE k = ?').run(key);
}

/** Remove every key whose project id matches (equivalent of purge files). */
export async function sqliteDeleteProjectEntries(projectId: string): Promise<void> {
  // Escape LIKE wildcards: '_' is a legal project-id character.
  const escaped = projectId.replace(/[%_\\]/g, (c) => `\\${c}`);
  openDatabase()
    .prepare("DELETE FROM kv WHERE k LIKE ? ESCAPE '\\'")
    .run(`%:${escaped}%`);
}
