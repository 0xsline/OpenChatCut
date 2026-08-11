import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import type { RuntimeProfile } from '../runtime-profile.ts';
import type {
  ImportReceipt,
  ImportReceiptSource,
  ImportSummary,
} from './sqlite-migration.ts';

export const MIGRATION_ROW_ID = 1;

/** Phase 1 = JSON dir keys; phase 2 adds generation-jobs + deleted-projects. */
export const RECEIPT_PHASE = 2;
/** kv keys for the phase-2 auxiliary files (server-managed JSON files). */
export const GENERATION_JOBS_KV_KEY = 'generation-jobs:snapshot';
export const DELETED_PROJECTS_KV_KEY = 'deleted-projects:v1';

export interface LegacyRecord {
  key: string;
  raw: string;
  source: ImportReceiptSource;
}

export function readLegacyJsonRecord(
  key: string,
  path: string,
  kind: ImportReceiptSource['kind'],
): LegacyRecord {
  const buffer = readFileSync(path);
  JSON.parse(buffer.toString('utf8'));
  return {
    key,
    raw: buffer.toString('utf8'),
    source: {
      path,
      sha256: createHash('sha256').update(buffer).digest('hex'),
      kind,
    },
  };
}

export function collectAuxiliaryRecords(
  profile: RuntimeProfile,
  summary: ImportSummary,
): LegacyRecord[] {
  const records: LegacyRecord[] = [];
  const sources: Array<[string, string, ImportReceiptSource['kind']]> = [
    [GENERATION_JOBS_KV_KEY, profile.generationJobStore, 'generation-jobs'],
    [DELETED_PROJECTS_KV_KEY, profile.projectStore.tombstonePath, 'deleted-projects'],
  ];
  for (const [key, path, kind] of sources) {
    try {
      records.push(readLegacyJsonRecord(key, path, kind));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') summary.quarantined += 1;
    }
  }
  return records;
}

export function writeAuthoritativeReceipt(db: DatabaseSync, receipt: ImportReceipt): void {
  db.prepare(`
    INSERT INTO storage_migration_state (singleton, state, receipt)
    VALUES (?, 'complete', ?)
    ON CONFLICT(singleton) DO UPDATE SET state = excluded.state, receipt = excluded.receipt
  `).run(MIGRATION_ROW_ID, JSON.stringify(receipt));
}

export function upgradePhaseOne(
  db: DatabaseSync,
  profile: RuntimeProfile,
  completed: ImportReceipt,
  summary: ImportSummary,
): void {
  const records = collectAuxiliaryRecords(profile, summary);
  if (summary.quarantined !== 0) {
    throw new Error(
      `SQLite migration refused to upgrade with ${summary.quarantined} unreadable legacy record(s)`,
    );
  }
  const select = db.prepare('SELECT 1 FROM kv WHERE k = ?');
  const insert = db.prepare('INSERT INTO kv (k, v) VALUES (?, ?)');
  const keys = { ...completed.keys };
  const sources = { ...completed.sources };
  for (const record of records) {
    if (select.get(record.key)) {
      summary.skipped += 1;
      continue;
    }
    insert.run(record.key, record.raw);
    summary.imported += 1;
    keys[record.key] = record.source.sha256;
    sources[record.key] = record.source;
  }
  writeAuthoritativeReceipt(db, {
    source: completed.source,
    count: Object.keys(keys).length,
    importedAt: new Date().toISOString(),
    phase: RECEIPT_PHASE,
    keys,
    sources,
  });
}
