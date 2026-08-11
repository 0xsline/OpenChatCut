// SQLite-backed project-store lifecycle and primitives.
//
// Backend activation requires a phase-2 marker committed in the same SQLite
// transaction as every required import. The environment variable requests
// migration; neither a partial database nor a phase-1 marker becomes active.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { projectIdFromProjectStoreKey } from '../../shared/project-store-validation.ts';
import { runtimeProfile } from '../runtime-profile.ts';
import {
  DELETED_PROJECTS_KV_KEY,
  GENERATION_JOBS_KV_KEY,
  RECEIPT_PHASE,
  ensureJsonImported,
  readAuthoritativeImportReceipt,
  synchronizeImportReceiptSidecar,
  type ImportReceipt,
  type ImportSummary,
} from './sqlite-migration.ts';

export interface StoredEntryValue {
  found: boolean;
  value?: unknown;
}

export const SQLITE_STORE_ENV = 'OPENCHATCUT_SQLITE_STORE';

export type SQLiteMigrationPhase = 'legacy' | 'migrating' | 'complete' | 'failed';

export interface SQLiteMigrationStatus {
  enabled: boolean;
  phase: SQLiteMigrationPhase;
  receipt: { count: number; importedAt: string } | null;
  jsonKeyCount: number;
  sqliteKeyCount: number;
  error?: string;
}

let database: DatabaseSync | null = null;
let databaseHadKvTableAtOpen = false;
let migrationTail: Promise<void> = Promise.resolve();
let processPhase: SQLiteMigrationPhase = 'legacy';
let migrationError: string | undefined;

type MigrationBarrierRelease = () => void | Promise<void>;
type MigrationBarrier = () => void | MigrationBarrierRelease | Promise<void | MigrationBarrierRelease>;
const migrationBarriers = new Set<MigrationBarrier>();

/**
 * Register persistence that must drain (and may remain locked) while the
 * authoritative legacy snapshot is captured. Registration is process-wide.
 */
export function registerStorageMigrationBarrier(barrier: MigrationBarrier): () => void {
  migrationBarriers.add(barrier);
  return () => migrationBarriers.delete(barrier);
}

export function storePath(): string {
  const profile = runtimeProfile();
  // Sits next to project-store-v1/ (never inside it: the JSON store scans its
  // own directory and must not see foreign files).
  return join(profile.rootDir, 'project-store-v1.sqlite3');
}

function openDatabase(): DatabaseSync {
  if (database) return database;
  const path = storePath();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA busy_timeout = 5000;');
  const existingKvTable = db.prepare(`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'kv'
  `).get() as { name?: string } | undefined;
  databaseHadKvTableAtOpen = existingKvTable?.name === 'kv';
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = FULL;
    CREATE TABLE IF NOT EXISTS kv (
      k TEXT PRIMARY KEY,
      v TEXT NOT NULL
    );
  `);
  database = db;
  return db;
}

function authoritativeReceipt(): ImportReceipt | null {
  if (!existsSync(storePath())) return null;
  try {
    return readAuthoritativeImportReceipt(openDatabase());
  } catch {
    return null;
  }
}

/**
 * Synchronous hot-path authority check. OPENCHATCUT_SQLITE_STORE=1 requests
 * initialization but cannot expose an incomplete database.
 */
export function sqliteStoreEnabled(): boolean {
  const env = process.env[SQLITE_STORE_ENV];
  if (env !== undefined && env !== '1') return false;
  const receipt = authoritativeReceipt();
  return receipt !== null && receipt.phase >= RECEIPT_PHASE;
}

async function withMigrationLease<T>(task: () => T | Promise<T>): Promise<T> {
  const predecessor = migrationTail;
  let release!: () => void;
  migrationTail = new Promise<void>((resolve) => {
    release = resolve;
  });
  await predecessor.catch(() => undefined);
  try {
    return await task();
  } finally {
    release();
  }
}

async function migrateUnderLease(): Promise<ImportSummary> {
  processPhase = 'migrating';
  migrationError = undefined;
  const releases: MigrationBarrierRelease[] = [];
  try {
    for (const barrier of migrationBarriers) {
      const release = await barrier();
      if (release) releases.push(release);
    }
    // Receipt-less imports re-read every live source after registered writers
    // drain. Phase-1 authority upgrades only missing auxiliary rows and never
    // replays project/chat JSON.
    const db = openDatabase();
    const summary = ensureJsonImported(db, runtimeProfile(), databaseHadKvTableAtOpen);
    const receipt = synchronizeImportReceiptSidecar(db, runtimeProfile());
    if (!receipt || receipt.phase < RECEIPT_PHASE) {
      throw new Error('SQLite migration completed without a phase-2 authoritative receipt');
    }
    processPhase = 'complete';
    return summary;
  } catch (error) {
    processPhase = 'failed';
    migrationError = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    for (const release of releases.reverse()) {
      try {
        await release();
      } catch {
        // The authoritative SQLite state is already decided. A release error
        // cannot safely roll it back or switch authority.
      }
    }
  }
}

/** User-initiated migration. Concurrent calls share one process-wide lease. */
export function runStorageMigration(): Promise<ImportSummary> {
  return withMigrationLease(migrateUnderLease);
}

/**
 * Startup migration/recovery.
 *
 * A requested migration, a receipt-less interrupted database, and a phase-1
 * authoritative database resume automatically. Explicit non-'1' values force
 * legacy mode.
 */
export function initializeSqliteProjectStore(): Promise<SQLiteMigrationStatus> {
  return withMigrationLease(async () => {
    const env = process.env[SQLITE_STORE_ENV];
    if (env !== undefined && env !== '1') {
      processPhase = 'legacy';
      migrationError = undefined;
      return sqliteMigrationStatus();
    }
    const receipt = authoritativeReceipt();
    if (receipt && receipt.phase >= RECEIPT_PHASE) {
      processPhase = 'complete';
      migrationError = undefined;
      synchronizeImportReceiptSidecar(openDatabase(), runtimeProfile());
      return sqliteMigrationStatus();
    }
    // Existing DB = interrupted/incomplete migration, including phase 1.
    // Env '1' requests a first migration; a new unrequested profile stays legacy.
    if (env === '1' || existsSync(storePath())) {
      try {
        await migrateUnderLease();
      } catch {
        // Startup recovery is fail-open to the still-authoritative legacy
        // backend. Manual runStorageMigration continues to reject failures.
      }
    }
    return sqliteMigrationStatus();
  });
}

export interface CleanupResult {
  removed: number;
  jsonKeyCount: number;
}

/**
 * Delete only legacy files whose exact path and current hash match the
 * authoritative receipt. Files created or changed after migration are retained.
 */
export function cleanupLegacyJson(): CleanupResult {
  if (!sqliteStoreEnabled()) throw new Error('migration not completed');
  const receipt = authoritativeReceipt();
  if (!receipt) throw new Error('authoritative migration receipt missing');
  const profile = runtimeProfile();
  if (receipt.source !== profile.projectStore.directory) {
    throw new Error('migration receipt belongs to a different runtime profile');
  }

  let removed = 0;
  for (const [key, source] of Object.entries(receipt.sources)) {
    let expectedPath: string | null = null;
    if (source.kind === 'project-store-entry') {
      expectedPath = join(profile.projectStore.directory, `${encodeURIComponent(key)}.json`);
    } else if (source.kind === 'generation-jobs' && key === GENERATION_JOBS_KV_KEY) {
      expectedPath = profile.generationJobStore;
    } else if (source.kind === 'deleted-projects' && key === DELETED_PROJECTS_KV_KEY) {
      expectedPath = profile.projectStore.tombstonePath;
    }
    // A receipt row is never authority to delete an arbitrary path.
    if (!expectedPath || source.path !== expectedPath || !existsSync(expectedPath)) continue;
    try {
      const currentHash = createHash('sha256').update(readFileSync(expectedPath)).digest('hex');
      if (currentHash !== source.sha256) continue;
      rmSync(expectedPath);
      removed += 1;
    } catch {
      // Best effort per verified source; unreadable/changed files remain intact.
    }
  }

  let jsonKeyCount = 0;
  try {
    jsonKeyCount = readdirSync(profile.projectStore.directory)
      .filter((name) => name.endsWith('.json')).length;
  } catch {
    // No legacy directory remains.
  }
  return { removed, jsonKeyCount };
}

/** Migration status for the UI. Receipt/state comes from SQLite, not sidecar. */
export function sqliteMigrationStatus(): SQLiteMigrationStatus {
  const receipt = authoritativeReceipt();
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
  const complete = receipt !== null && receipt.phase >= RECEIPT_PHASE;
  const phase: SQLiteMigrationPhase = complete
    ? 'complete'
    : processPhase === 'migrating' || processPhase === 'failed'
      ? processPhase
      : 'legacy';
  return {
    enabled: sqliteStoreEnabled(),
    phase,
    receipt: complete ? { count: receipt.count, importedAt: receipt.importedAt } : null,
    jsonKeyCount,
    sqliteKeyCount,
    ...(phase === 'failed' && migrationError ? { error: migrationError } : {}),
  };
}

/** Close the connection and reset process state (verifier/profile isolation). */
export function resetSqliteStoreForTests(): void {
  database?.close();
  database = null;
  databaseHadKvTableAtOpen = false;
  migrationTail = Promise.resolve();
  processPhase = 'legacy';
  migrationError = undefined;
}

const encode = (value: unknown): string => JSON.stringify(value);
const decode = (raw: string): unknown => JSON.parse(raw);

export interface SQLiteImmediateStore {
  readEntry(key: string): StoredEntryValue;
  writeEntry(key: string, value: unknown): void;
  deleteEntry(key: string): void;
}

function immediateStore(db: DatabaseSync): SQLiteImmediateStore {
  const read = db.prepare('SELECT v FROM kv WHERE k = ?');
  const write = db.prepare(
    'INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v',
  );
  const remove = db.prepare('DELETE FROM kv WHERE k = ?');
  return {
    readEntry: (key) => {
      const row = read.get(key) as { v: string } | undefined;
      return row ? { found: true, value: decode(row.v) } : { found: false };
    },
    writeEntry: (key, value) => { write.run(key, encode(value)); },
    deleteEntry: (key) => { remove.run(key); },
  };
}

/** Execute a synchronous read/validate/write state transition under SQLite's writer lock. */
export function sqliteImmediateTransaction<T>(work: (store: SQLiteImmediateStore) => T): T {
  const db = openDatabase();
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = work(immediateStore(db));
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

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

/** Remove every key whose parsed owning project id matches exactly. */
export async function sqliteDeleteProjectEntries(projectId: string): Promise<void> {
  const db = openDatabase();
  db.exec('BEGIN IMMEDIATE');
  try {
    const rows = db.prepare('SELECT k FROM kv').all() as Array<{ k: string }>;
    const remove = db.prepare('DELETE FROM kv WHERE k = ?');
    for (const row of rows) {
      if (projectIdFromProjectStoreKey(row.k) === projectId) remove.run(row.k);
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
