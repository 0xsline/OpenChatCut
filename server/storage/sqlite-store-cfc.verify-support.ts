import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { RuntimeProfile } from '../runtime-profile.ts';
import type {
  CleanupResult,
  SQLiteMigrationStatus,
  StoredEntryValue,
} from './sqlite-store.ts';
import type { ImportReceipt, ImportSummary } from './sqlite-migration.ts';

interface SqliteStore {
  cleanupLegacyJson(): CleanupResult;
  initializeSqliteProjectStore(): Promise<SQLiteMigrationStatus>;
  resetSqliteStoreForTests(): void;
  runStorageMigration(): Promise<ImportSummary>;
  sqliteMigrationStatus(): SQLiteMigrationStatus;
  sqliteReadEntry(key: string): Promise<StoredEntryValue>;
}

interface SqliteMigration {
  GENERATION_JOBS_KV_KEY: string;
  importReceiptPath(profile: RuntimeProfile): string;
  readImportReceipt(profile: RuntimeProfile): ImportReceipt | null;
}

interface CfcMigrationCheckOptions {
  profile: RuntimeProfile;
  sqlitePath: string;
  jobs: unknown;
  store: SqliteStore;
  migration: SqliteMigration;
}

const sha256 = (value: Buffer): string => createHash('sha256').update(value).digest('hex');

function replaceSqlite(path: string, rows: Record<string, string>): void {
  rmSync(path, { force: true });
  rmSync(`${path}-wal`, { force: true });
  rmSync(`${path}-shm`, { force: true });
  const db = new DatabaseSync(path);
  db.exec('CREATE TABLE kv (k TEXT PRIMARY KEY, v TEXT NOT NULL)');
  const insert = db.prepare('INSERT INTO kv (k, v) VALUES (?, ?)');
  for (const [key, value] of Object.entries(rows)) insert.run(key, value);
  db.close();
}

export async function verifyCfcMigrationChecks({
  profile,
  sqlitePath,
  jobs,
  store,
  migration,
}: CfcMigrationCheckOptions): Promise<void> {
  const {
    cleanupLegacyJson,
    initializeSqliteProjectStore,
    resetSqliteStoreForTests,
    runStorageMigration,
    sqliteMigrationStatus,
    sqliteReadEntry,
  } = store;
  const {
    GENERATION_JOBS_KV_KEY,
    importReceiptPath,
    readImportReceipt,
  } = migration;

  // A legacy sidecar without its original SQLite file is not authority.
  resetSqliteStoreForTests();
  rmSync(sqlitePath, { force: true });
  rmSync(`${sqlitePath}-wal`, { force: true });
  rmSync(`${sqlitePath}-shm`, { force: true });
  const missingDatabaseValue = JSON.stringify({ title: 'recover-from-json' });
  const missingDatabaseSource = join(
    profile.projectStore.directory,
    'project%3Acfc-missing-database.json',
  );
  writeFileSync(missingDatabaseSource, missingDatabaseValue);
  writeFileSync(importReceiptPath(profile), JSON.stringify({
    source: profile.projectStore.directory,
    count: 1,
    importedAt: '2026-08-11T00:00:00.000Z',
    phase: 2,
    keys: {
      'project:cfc-missing-database': sha256(Buffer.from(missingDatabaseValue, 'utf8')),
    },
  }));
  const recoveredMissingDatabase = await runStorageMigration();
  assert.equal(recoveredMissingDatabase.receiptWritten, true);
  assert.equal(sqliteMigrationStatus().phase, 'complete');
  assert.deepEqual(await sqliteReadEntry('project:cfc-missing-database'), {
    found: true,
    value: { title: 'recover-from-json' },
  }, 'a sidecar cannot promote a newly created empty SQLite database');
  assert.equal(
    readImportReceipt(profile)?.sources['project:cfc-missing-database']?.path,
    missingDatabaseSource,
    'fresh recovery records the live JSON source imported into SQLite',
  );

  // A completed cfc sidecar proves SQLite authority; its hashes describe the
  // original migration inputs, not an immutable snapshot of today's rows.
  resetSqliteStoreForTests();
  const editedSnapshotValue = JSON.stringify({ title: 'before-sqlite-edit' });
  const deletedSnapshotValue = JSON.stringify({ mustNotResurrect: true });
  const cfcSnapshotRows: Record<string, string> = {
    'project:cfc-edited': editedSnapshotValue,
    'chat:cfc-deleted': deletedSnapshotValue,
    [GENERATION_JOBS_KV_KEY]: JSON.stringify(jobs),
  };
  replaceSqlite(sqlitePath, cfcSnapshotRows);
  const cfcKeys = Object.fromEntries(
    Object.entries(cfcSnapshotRows).map(([key, value]) => [
      key,
      sha256(Buffer.from(value, 'utf8')),
    ]),
  );
  writeFileSync(
    join(profile.projectStore.directory, 'project%3Acfc-edited.json'),
    editedSnapshotValue,
  );
  writeFileSync(
    join(profile.projectStore.directory, 'chat%3Acfc-deleted.json'),
    deletedSnapshotValue,
  );
  writeFileSync(importReceiptPath(profile), JSON.stringify({
    source: profile.projectStore.directory,
    count: Object.keys(cfcKeys).length,
    importedAt: '2026-08-11T00:00:00.000Z',
    phase: 2,
    keys: cfcKeys,
  }));
  const cfc = new DatabaseSync(sqlitePath);
  cfc.prepare('UPDATE kv SET v = ? WHERE k = ?')
    .run(JSON.stringify({ title: 'edited-in-sqlite' }), 'project:cfc-edited');
  cfc.prepare('DELETE FROM kv WHERE k = ?').run('chat:cfc-deleted');
  cfc.prepare('INSERT INTO kv (k, v) VALUES (?, ?)')
    .run('project:cfc-sqlite-only', JSON.stringify({ inserted: true }));
  cfc.close();
  const promoted = await initializeSqliteProjectStore();
  assert.equal(promoted.phase, 'complete',
    'a cfc candidate must promote without treating hashes as current row state');
  assert.deepEqual(await sqliteReadEntry('project:cfc-edited'), {
    found: true,
    value: { title: 'edited-in-sqlite' },
  }, 'a post-cfc SQLite edit survives promotion');
  assert.deepEqual(await sqliteReadEntry('chat:cfc-deleted'), { found: false },
    'a post-cfc SQLite deletion is not resurrected from the receipt');
  assert.deepEqual(await sqliteReadEntry('project:cfc-sqlite-only'), {
    found: true,
    value: { inserted: true },
  }, 'a post-cfc SQLite-only insert survives promotion');
  const promotedReceipt = readImportReceipt(profile);
  assert.equal(promotedReceipt?.count, 3,
    'promoted receipt count remains the cleanup-anchor count');
  assert.equal(promotedReceipt?.sources['project:cfc-edited']?.path,
    join(profile.projectStore.directory, 'project%3Acfc-edited.json'));
  assert.equal(promotedReceipt?.sources['project:cfc-sqlite-only'], undefined,
    'SQLite-only rows never become legacy cleanup anchors');
  const cfcCleanup = cleanupLegacyJson();
  assert.equal(cfcCleanup.removed, 2,
    'promotion hashes remain exact cleanup anchors for matching legacy files');

  // A fully cleaned candidate with no remaining JSON source still promotes.
  resetSqliteStoreForTests();
  const cleanedValue = JSON.stringify({ title: 'cleaned-candidate' });
  replaceSqlite(sqlitePath, { 'project:cfc-cleaned': cleanedValue });
  writeFileSync(importReceiptPath(profile), JSON.stringify({
    source: profile.projectStore.directory,
    count: 1,
    importedAt: '2026-08-11T00:00:00.000Z',
    phase: 2,
    keys: { 'project:cfc-cleaned': sha256(Buffer.from(cleanedValue, 'utf8')) },
  }));
  const cleanedPromotion = await initializeSqliteProjectStore();
  assert.equal(cleanedPromotion.phase, 'complete');
  assert.deepEqual(await sqliteReadEntry('project:cfc-cleaned'), {
    found: true,
    value: { title: 'cleaned-candidate' },
  });

  // A changed legacy source invalidates the candidate and must not get a
  // chance to overwrite an edited SQLite row through ordinary JSON import.
  resetSqliteStoreForTests();
  const currentValue = JSON.stringify({ title: 'current-sqlite-authority' });
  replaceSqlite(sqlitePath, { 'project:cfc-stale': currentValue });
  const staleSource = join(profile.projectStore.directory, 'project%3Acfc-stale.json');
  const migrationValue = JSON.stringify({ title: 'migration-time-json' });
  writeFileSync(staleSource, JSON.stringify({ title: 'stale-json-must-not-overwrite' }));
  writeFileSync(importReceiptPath(profile), JSON.stringify({
    source: profile.projectStore.directory,
    count: 1,
    importedAt: '2026-08-11T00:00:00.000Z',
    phase: 2,
    keys: { 'project:cfc-stale': sha256(Buffer.from(migrationValue, 'utf8')) },
  }));
  await assert.rejects(runStorageMigration(), /candidate source hash mismatch/);
  resetSqliteStoreForTests();
  let refused = new DatabaseSync(sqlitePath);
  const refusedRow = refused.prepare('SELECT v FROM kv WHERE k = ?')
    .get('project:cfc-stale') as { v: string } | undefined;
  assert.equal(refusedRow?.v, currentValue,
    'a bad source hash cannot overwrite current SQLite data');
  const refusedMarker = refused.prepare('SELECT count(*) AS n FROM storage_migration_state')
    .get() as { n: number };
  assert.equal(refusedMarker.n, 0, 'a bad source hash cannot commit authority');
  refused.close();
  rmSync(staleSource);

  // Valid-looking receipts for another profile and malformed cfc shapes are
  // rejected rather than falling through to a JSON import.
  writeFileSync(importReceiptPath(profile), JSON.stringify({
    source: `${profile.projectStore.directory}-other-profile`,
    count: 1,
    importedAt: '2026-08-11T00:00:00.000Z',
    phase: 2,
    keys: { 'project:cfc-stale': sha256(Buffer.from(migrationValue, 'utf8')) },
  }));
  await assert.rejects(runStorageMigration(), /candidate receipt from another profile/);
  resetSqliteStoreForTests();
  writeFileSync(importReceiptPath(profile), JSON.stringify({
    source: profile.projectStore.directory,
    count: 1,
    importedAt: '2026-08-11T00:00:00.000Z',
    phase: 2,
    keys: { 'project:cfc-stale': sha256(Buffer.from(migrationValue, 'utf8')) },
    unexpected: true,
  }));
  await assert.rejects(runStorageMigration(), /malformed cfc candidate receipt/);
  resetSqliteStoreForTests();
  refused = new DatabaseSync(sqlitePath);
  const invalidCandidateRow = refused.prepare('SELECT v FROM kv WHERE k = ?')
    .get('project:cfc-stale') as { v: string } | undefined;
  assert.equal(invalidCandidateRow?.v, currentValue,
    'invalid candidates leave the pre-existing SQLite rows untouched');
  const invalidCandidateMarker = refused
    .prepare('SELECT count(*) AS n FROM storage_migration_state')
    .get() as { n: number };
  assert.equal(invalidCandidateMarker.n, 0, 'invalid candidates never activate SQLite');
  refused.close();
}
