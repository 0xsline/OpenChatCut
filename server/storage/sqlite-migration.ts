// Atomic JSON→SQLite project-store migration.
//
// The SQLite marker is authoritative. Imported rows and that marker commit in
// one transaction, so a crash exposes either the legacy backend or the complete
// import phase. A phase-1 marker preserves current SQLite project authority
// while phase 2 atomically adds missing auxiliary stores. A validated cfc-era
// completion sidecar may transactionally promote an already-authoritative
// SQLite database; modern sidecars are only repairable inspection copies.
import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { runtimeProfile, type RuntimeProfile } from '../runtime-profile.ts';
import {
  collectAuxiliaryRecords,
  DELETED_PROJECTS_KV_KEY,
  GENERATION_JOBS_KV_KEY,
  MIGRATION_ROW_ID,
  readLegacyJsonRecord,
  RECEIPT_PHASE,
  upgradePhaseOne,
  writeAuthoritativeReceipt,
  type LegacyRecord,
} from './sqlite-migration-phase-one.ts';

export {
  DELETED_PROJECTS_KV_KEY,
  GENERATION_JOBS_KV_KEY,
  RECEIPT_PHASE,
} from './sqlite-migration-phase-one.ts';

const RECEIPT_FILE = 'project-store-v1.sqlite3.receipt.json';

const sha256 = (buf: Buffer): string => createHash('sha256').update(buf).digest('hex');

export interface ImportSummary {
  /** Newly inserted or refreshed from the still-authoritative legacy source. */
  imported: number;
  /** Already present with an identical content hash. */
  skipped: number;
  /** Unreadable / unparseable files; skipped and retained in legacy storage. */
  quarantined: number;
  /** True only when the authoritative SQLite completion marker committed. */
  receiptWritten: boolean;
}

export interface ImportReceiptSource {
  /** Exact absolute source used for this imported record. */
  path: string;
  sha256: string;
  kind: 'project-store-entry' | 'generation-jobs' | 'deleted-projects';
}

export interface ImportReceipt {
  source: string;
  count: number;
  importedAt: string;
  /** 1 = JSON dir only; 2 = + generation-jobs + deleted-projects. */
  phase: number;
  /** kv key → sha256 of the ORIGINAL file bytes (compatibility anchor). */
  keys: Record<string, string>;
  /** kv key → exact source path/hash used by the completed transaction. */
  sources: Record<string, ImportReceiptSource>;
}

interface LegacySidecarReceipt {
  source: string;
  count: number;
  importedAt: string;
  phase: number;
  keys: Record<string, string>;
}


function parseReceipt(raw: string): ImportReceipt | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const receipt = parsed as Partial<ImportReceipt>;
    if (typeof receipt.source !== 'string'
      || typeof receipt.count !== 'number'
      || !Number.isSafeInteger(receipt.count)
      || receipt.count < 0
      || typeof receipt.importedAt !== 'string'
      || typeof receipt.phase !== 'number'
      || !Number.isSafeInteger(receipt.phase)
      || !receipt.keys
      || typeof receipt.keys !== 'object'
      || Array.isArray(receipt.keys)
      || !receipt.sources
      || typeof receipt.sources !== 'object'
      || Array.isArray(receipt.sources)) return null;
    for (const [key, value] of Object.entries(receipt.keys)) {
      if (!key || typeof value !== 'string') return null;
    }
    for (const [key, value] of Object.entries(receipt.sources)) {
      if (!key || !value || typeof value !== 'object' || Array.isArray(value)) return null;
      const source = value as Partial<ImportReceiptSource>;
      if (typeof source.path !== 'string'
        || typeof source.sha256 !== 'string'
        || (source.kind !== 'project-store-entry'
          && source.kind !== 'generation-jobs'
          && source.kind !== 'deleted-projects')) return null;
      if (receipt.keys[key] !== source.sha256) return null;
    }
    if (Object.keys(receipt.keys).length !== receipt.count
      || Object.keys(receipt.sources).length !== receipt.count) return null;
    return receipt as ImportReceipt;
  } catch {
    return null;
  }
}

/** Parse only the pre-authoritative candidate receipt shape (no sources map). */
function parseLegacySidecarReceipt(raw: string): LegacySidecarReceipt | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
      || Object.hasOwn(parsed, 'sources')) return null;
    const fields = Object.keys(parsed);
    if (fields.length !== 5
      || fields.some((field) => !['source', 'count', 'importedAt', 'phase', 'keys'].includes(field))) {
      return null;
    }
    const receipt = parsed as Partial<LegacySidecarReceipt>;
    if (typeof receipt.source !== 'string'
      || typeof receipt.count !== 'number'
      || !Number.isSafeInteger(receipt.count)
      || receipt.count < 0
      || typeof receipt.importedAt !== 'string'
      || typeof receipt.phase !== 'number'
      || receipt.phase !== RECEIPT_PHASE
      || !receipt.keys
      || typeof receipt.keys !== 'object'
      || Array.isArray(receipt.keys)) return null;
    const entries = Object.entries(receipt.keys);
    if (entries.length !== receipt.count
      || entries.some(([key, hash]) => !key || typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash))) {
      return null;
    }
    return receipt as LegacySidecarReceipt;
  } catch {
    return null;
  }
}

export function importReceiptPath(profile: RuntimeProfile = runtimeProfile()): string {
  return join(profile.rootDir, RECEIPT_FILE);
}

/** Read the modern inspection sidecar. This function never decides activation. */
export function readImportReceipt(profile: RuntimeProfile = runtimeProfile()): ImportReceipt | null {
  try {
    return parseReceipt(readFileSync(importReceiptPath(profile), 'utf8'));
  } catch {
    return null;
  }
}

export function ensureMigrationSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS storage_migration_state (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      state TEXT NOT NULL CHECK (state = 'complete'),
      receipt TEXT NOT NULL
    );
  `);
}

/** Read the committed marker; callers decide which receipt phase they require. */
export function readAuthoritativeImportReceipt(db: DatabaseSync): ImportReceipt | null {
  ensureMigrationSchema(db);
  const row = db.prepare(
    'SELECT receipt FROM storage_migration_state WHERE singleton = ? AND state = ?'
  ).get(MIGRATION_ROW_ID, 'complete') as { receipt: string } | undefined;
  return row ? parseReceipt(row.receipt) : null;
}

function expectedSource(
  key: string,
  hash: string,
  profile: RuntimeProfile,
): ImportReceiptSource {
  if (key === GENERATION_JOBS_KV_KEY) {
    return { path: profile.generationJobStore, sha256: hash, kind: 'generation-jobs' };
  }
  if (key === DELETED_PROJECTS_KV_KEY) {
    return { path: profile.projectStore.tombstonePath, sha256: hash, kind: 'deleted-projects' };
  }
  return {
    path: join(profile.projectStore.directory, `${encodeURIComponent(key)}.json`),
    sha256: hash,
    kind: 'project-store-entry',
  };
}

interface ValidatedLegacyCandidate {
  legacy: LegacySidecarReceipt;
  sources: Record<string, ImportReceiptSource>;
}

function readValidatedLegacyCandidate(profile: RuntimeProfile): ValidatedLegacyCandidate | null {
  let raw: string;
  try {
    raw = readFileSync(importReceiptPath(profile), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error('SQLite migration refused an unreadable candidate receipt');
  }
  // A modern sidecar remains an inspection copy and cannot activate SQLite.
  // It may legitimately predate an interrupted first authoritative import.
  if (parseReceipt(raw)) return null;
  const legacy = parseLegacySidecarReceipt(raw);
  if (!legacy) throw new Error('SQLite migration refused a malformed cfc candidate receipt');
  if (legacy.source !== profile.projectStore.directory) {
    throw new Error('SQLite migration refused a candidate receipt from another profile');
  }

  const sources: Record<string, ImportReceiptSource> = {};
  for (const [key, hash] of Object.entries(legacy.keys)) {
    const source = expectedSource(key, hash, profile);
    if (existsSync(source.path)) {
      let bytes: Buffer;
      try {
        bytes = readFileSync(source.path);
        JSON.parse(bytes.toString('utf8'));
      } catch {
        throw new Error(`SQLite migration refused unreadable candidate source ${source.path}`);
      }
      if (sha256(bytes) !== hash) {
        throw new Error(`SQLite migration refused candidate source hash mismatch for ${source.path}`);
      }
    }
    sources[key] = source;
  }
  return { legacy, sources };
}

/**
 * Promote a completed pre-marker candidate as proof that SQLite was already
 * authoritative, without treating its hashes as a current row snapshot.
 */
function promoteLegacySidecarReceipt(
  db: DatabaseSync,
  profile: RuntimeProfile,
): ImportReceipt | null {
  const candidate = readValidatedLegacyCandidate(profile);
  if (!candidate) return null;
  const receipt: ImportReceipt = {
    source: candidate.legacy.source,
    count: candidate.legacy.count,
    importedAt: candidate.legacy.importedAt,
    phase: candidate.legacy.phase,
    keys: candidate.legacy.keys,
    sources: candidate.sources,
  };
  db.prepare(`
    INSERT INTO storage_migration_state (singleton, state, receipt)
    VALUES (?, 'complete', ?)
    ON CONFLICT(singleton) DO UPDATE SET state = excluded.state, receipt = excluded.receipt
  `).run(MIGRATION_ROW_ID, JSON.stringify(receipt));
  return receipt;
}

function writeReceiptSidecar(receipt: ImportReceipt, profile: RuntimeProfile): void {
  const path = importReceiptPath(profile);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(receipt, null, 2), { mode: 0o600 });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

/** Repair the non-authoritative JSON copy from the committed SQLite marker. */
export function synchronizeImportReceiptSidecar(
  db: DatabaseSync,
  profile: RuntimeProfile = runtimeProfile(),
): ImportReceipt | null {
  const receipt = readAuthoritativeImportReceipt(db);
  if (!receipt) return null;
  const sidecar = readImportReceipt(profile);
  if (JSON.stringify(sidecar) !== JSON.stringify(receipt)) {
    try {
      writeReceiptSidecar(receipt, profile);
    } catch {
      // SQLite already contains the authoritative receipt. A later startup can
      // repair an unwritable/missing inspection sidecar without changing authority.
    }
  }
  return receipt;
}


/** Re-read every live legacy source while the process-wide migration lease is held. */
function collectLegacyRecords(profile: RuntimeProfile, summary: ImportSummary): LegacyRecord[] {
  const records = new Map<string, LegacyRecord>();
  let files: string[] = [];
  try {
    files = readdirSync(profile.projectStore.directory)
      .filter((name) => name.endsWith('.json'))
      .sort();
  } catch (error) {
    // A profile with no project-store directory has no project records to
    // import. Any other read failure blocks activation.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') summary.quarantined += 1;
  }
  for (const file of files) {
    let key: string;
    try {
      key = decodeURIComponent(file.slice(0, -'.json'.length));
    } catch {
      summary.quarantined += 1;
      continue;
    }
    try {
      const record = readLegacyJsonRecord(
        key,
        join(profile.projectStore.directory, file),
        'project-store-entry',
      );
      records.set(record.key, record);
    } catch {
      summary.quarantined += 1;
    }
  }
  for (const record of collectAuxiliaryRecords(profile, summary)) records.set(record.key, record);
  return [...records.values()];
}


function refuseQuarantined(summary: ImportSummary, action: string): void {
  if (summary.quarantined === 0) return;
  throw new Error(
    `SQLite migration refused to ${action} with ${summary.quarantined} unreadable legacy record(s)`,
  );
}


function refuseUnmatchedRows(db: DatabaseSync, records: LegacyRecord[]): void {
  const liveKeys = new Set(records.map((record) => record.key));
  const existingRows = db.prepare('SELECT k FROM kv').all() as Array<{ k: string }>;
  const unmatched = existingRows.filter((row) => !liveKeys.has(row.k));
  if (unmatched.length === 0) return;
  throw new Error(
    `SQLite migration refused to activate with ${unmatched.length} target row(s) absent from authoritative legacy storage`,
  );
}

function importLegacySnapshot(
  db: DatabaseSync,
  profile: RuntimeProfile,
  summary: ImportSummary,
): void {
  const records = collectLegacyRecords(profile, summary);
  refuseQuarantined(summary, 'activate');
  refuseUnmatchedRows(db, records);
  const select = db.prepare('SELECT v FROM kv WHERE k = ?');
  const upsert = db.prepare(
    'INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v',
  );
  const keys: Record<string, string> = {};
  const sources: Record<string, ImportReceiptSource> = {};
  for (const record of records) {
    const existing = select.get(record.key) as { v: string } | undefined;
    if (existing && sha256(Buffer.from(existing.v, 'utf8')) === record.source.sha256) {
      summary.skipped += 1;
    } else {
      upsert.run(record.key, record.raw);
      summary.imported += 1;
    }
    keys[record.key] = record.source.sha256;
    sources[record.key] = record.source;
  }
  writeAuthoritativeReceipt(db, {
    source: profile.projectStore.directory,
    count: records.length,
    importedAt: new Date().toISOString(),
    phase: RECEIPT_PHASE,
    keys,
    sources,
  });
}

/**
 * Import (or recover) the legacy backend in one SQLite transaction.
 *
 * Callers MUST hold the process-wide migration lease. A receipt-less database
 * is reconciled from the legacy snapshot. A phase-1 authoritative database is
 * upgraded only with missing auxiliary rows; project/chat JSON is never replayed.
 */
export function ensureJsonImported(
  db: DatabaseSync,
  profile: RuntimeProfile = runtimeProfile(),
  allowLegacySidecarPromotion = false,
): ImportSummary {
  const summary: ImportSummary = {
    imported: 0,
    skipped: 0,
    quarantined: 0,
    receiptWritten: false,
  };
  ensureMigrationSchema(db);
  let transactionOpen = true;
  db.exec('BEGIN IMMEDIATE');
  try {
    let completed = readAuthoritativeImportReceipt(db);
    if (!completed && allowLegacySidecarPromotion) {
      completed = promoteLegacySidecarReceipt(db, profile);
      if (completed) summary.receiptWritten = true;
    }
    if (!completed) {
      importLegacySnapshot(db, profile, summary);
      summary.receiptWritten = true;
    } else if (completed.phase < RECEIPT_PHASE) {
      upgradePhaseOne(db, profile, completed, summary);
      summary.receiptWritten = true;
    }
    db.exec('COMMIT');
    transactionOpen = false;
  } catch (error) {
    if (transactionOpen) db.exec('ROLLBACK');
    throw error;
  }
  synchronizeImportReceiptSidecar(db, profile);
  return summary;
}
