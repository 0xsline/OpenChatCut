// Focused SQLite migration lifecycle regression.
//
// Covers one process-wide migration lease, receipt-less partial recovery,
// cfc-sidecar authority promotion without row replay, safe candidate refusal,
// sidecar repair after restart, and custom generation-ledger migration.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { verifyCfcMigrationChecks } from './sqlite-store-cfc.verify-support.ts';

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

function writeMigrationReceipt(path: string, receipt: unknown): void {
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE IF NOT EXISTS storage_migration_state (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      state TEXT NOT NULL CHECK (state = 'complete'),
      receipt TEXT NOT NULL
    )
  `);
  db.prepare(
    'INSERT OR REPLACE INTO storage_migration_state (singleton, state, receipt) VALUES (1, ?, ?)',
  ).run('complete', JSON.stringify(receipt));
  db.close();
}

function readMigrationPhase(path: string): number | null {
  const db = new DatabaseSync(path);
  const row = db.prepare(
    'SELECT receipt FROM storage_migration_state WHERE singleton = 1 AND state = ?',
  ).get('complete') as { receipt: string } | undefined;
  db.close();
  if (!row) return null;
  const parsed: unknown = JSON.parse(row.receipt);
  if (!parsed || typeof parsed !== 'object' || !('phase' in parsed)
    || typeof parsed.phase !== 'number') return null;
  return parsed.phase;
}

async function main(): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), 'occ-sqlite-migration-'));
  const previousHome = process.env.HOME;
  const previousStore = process.env.OPENCHATCUT_GENERATION_JOB_STORE;
  const previousSwitch = process.env.OPENCHATCUT_SQLITE_STORE;
  const customJobsPath = join(home, 'custom-profile', 'jobs-ledger.json');
  process.env.HOME = home;
  process.env.OPENCHATCUT_GENERATION_JOB_STORE = customJobsPath;
  delete process.env.OPENCHATCUT_SQLITE_STORE;

  try {
    // Import only after profile variables are installed: runtimeProfile caches.
    const {
      cleanupLegacyJson,
      initializeSqliteProjectStore,
      registerStorageMigrationBarrier,
      resetSqliteStoreForTests,
      runStorageMigration,
      sqliteMigrationStatus,
      sqliteDeleteEntry,
      sqliteDeleteProjectEntries,
      sqliteReadEntry,
      sqliteStoreEnabled,
      sqliteWriteEntry,
    } = await import('./sqlite-store.ts');
    const {
      DELETED_PROJECTS_KV_KEY,
      GENERATION_JOBS_KV_KEY,
      importReceiptPath,
      readImportReceipt,
    } = await import('./sqlite-migration.ts');
    const { runtimeProfile } = await import('../runtime-profile.ts');

    const profile = runtimeProfile();
    assert.equal(profile.generationJobStore, customJobsPath,
      'the custom runtime-profile ledger must be authoritative');
    mkdirSync(profile.projectStore.directory, { recursive: true });
    const projectSource = join(profile.projectStore.directory, 'project%3Alegacy.json');
    writeFileSync(projectSource, JSON.stringify({ id: 'legacy', title: 'preserved' }));
    const concurrentSource = join(profile.projectStore.directory, 'chat%3Aconcurrent.json');
    writeFileSync(concurrentSource, JSON.stringify({ source: 'latest' }));
    const deletedLegacySource = join(profile.projectStore.directory, 'chat%3Adeleted-partial.json');
    writeFileSync(deletedLegacySource, JSON.stringify({ mustNotResurrect: true }));

    const jobs = {
      version: 1,
      jobs: [
        { id: 'queued', status: 'queued', progress: 0, params: {}, createdAt: 1, updatedAt: 1 },
        { id: 'running', status: 'running', progress: 0.5, params: {}, createdAt: 2, updatedAt: 3 },
        { id: 'completed', status: 'succeeded', progress: 1, params: {}, createdAt: 4, updatedAt: 5 },
      ],
    };
    mkdirSync(dirname(customJobsPath), { recursive: true });
    const jobsBytes = Buffer.from(JSON.stringify(jobs));
    writeFileSync(customJobsPath, jobsBytes);

    // Simulate an interrupted older attempt: SQLite contains partial imports,
    // including one key subsequently deleted from authoritative legacy storage.
    const sqlitePath = join(profile.rootDir, 'project-store-v1.sqlite3');
    mkdirSync(dirname(sqlitePath), { recursive: true });
    const partial = new DatabaseSync(sqlitePath);
    partial.exec('CREATE TABLE kv (k TEXT PRIMARY KEY, v TEXT NOT NULL)');
    partial.prepare('INSERT INTO kv (k, v) VALUES (?, ?)')
      .run('project:legacy', JSON.stringify({ stale: true }));
    partial.prepare('INSERT INTO kv (k, v) VALUES (?, ?)')
      .run('chat:concurrent', JSON.stringify({ stale: true }));
    partial.prepare('INSERT INTO kv (k, v) VALUES (?, ?)')
      .run('chat:deleted-partial', JSON.stringify({ mustNotResurrect: true }));
    partial.close();
    rmSync(deletedLegacySource);

    // A forged/independent sidecar cannot activate a receipt-less database.
    writeFileSync(importReceiptPath(profile), JSON.stringify({
      source: profile.projectStore.directory,
      count: 0,
      importedAt: new Date(0).toISOString(),
      phase: 2,
      keys: {},
      sources: {},
    }));
    assert.equal(sqliteStoreEnabled(), false,
      'only the SQLite completion row may switch backend authority');
    assert.throws(() => cleanupLegacyJson(), /migration not completed/);
    assert.equal(existsSync(customJobsPath), true,
      'configured legacy ledger must survive before confirmed import');

    const unreadableSource = join(profile.projectStore.directory, 'chat%3Abroken.json');
    writeFileSync(unreadableSource, '{not-json');
    await assert.rejects(runStorageMigration(), /refused to activate/);
    assert.equal(sqliteStoreEnabled(), false,
      'a partial source failure must keep the legacy backend authoritative');
    assert.equal(existsSync(customJobsPath), true,
      'a failed import must not delete the configured legacy ledger');
    rmSync(unreadableSource);

    await assert.rejects(
      runStorageMigration(),
      /target row\(s\) absent from authoritative legacy storage/,
    );
    assert.equal(sqliteStoreEnabled(), false,
      'a partial row deleted from legacy must block activation instead of resurfacing');
    assert.deepEqual(await sqliteReadEntry('chat:deleted-partial'), {
      found: true,
      value: { mustNotResurrect: true },
    }, 'unmatched target data is preserved for recovery, never cleared');
    await sqliteDeleteEntry('chat:deleted-partial');

    // Deterministic same-process race: both manual and startup paths share the
    // lease. Exactly one run writes the marker; queued callers observe it.
    const [first, initialized, second] = await Promise.all([
      runStorageMigration(),
      initializeSqliteProjectStore(),
      runStorageMigration(),
    ]);
    assert.equal([first, second].filter((summary) => summary.receiptWritten).length, 1,
      'concurrent starts must commit exactly one migration receipt');
    assert.equal(initialized.phase, 'complete');
    assert.equal(sqliteMigrationStatus().phase, 'complete');
    assert.equal(sqliteStoreEnabled(), true);

    assert.deepEqual(await sqliteReadEntry('project:legacy'), {
      found: true,
      value: { id: 'legacy', title: 'preserved' },
    }, 'restart recovery refreshes stale partial import from authoritative legacy data');
    assert.deepEqual(await sqliteReadEntry('chat:concurrent'), {
      found: true,
      value: { source: 'latest' },
    }, 'a populated target row with a live source is reconciled without clearing the database');
    assert.deepEqual((await sqliteReadEntry(GENERATION_JOBS_KV_KEY)).value, jobs,
      'queued/running/completed generation jobs survive custom-path migration');

    await sqliteWriteEntry('chat:abc', { exact: true });
    await sqliteWriteEntry('chat:abcdef', { prefix: true });
    await sqliteDeleteProjectEntries('abc');
    assert.deepEqual(await sqliteReadEntry('chat:abc'), { found: false });
    assert.deepEqual(await sqliteReadEntry('chat:abcdef'), {
      found: true,
      value: { prefix: true },
    }, 'purging abc must not delete the distinct abcdef project');

    const receipt = readImportReceipt(profile);
    assert.ok(receipt, 'the committed receipt sidecar must be materialized');
    assert.equal(receipt.sources[GENERATION_JOBS_KV_KEY]?.path, customJobsPath,
      'receipt records the exact configured generation source');
    assert.equal(receipt.sources[GENERATION_JOBS_KV_KEY]?.sha256, sha256(jobsBytes),
      'receipt records the exact configured generation source hash');

    // Crash window after SQLite commit but before/while writing the sidecar:
    // restart trusts the SQLite row, repairs the sidecar, and keeps all rows.
    rmSync(importReceiptPath(profile), { force: true });
    resetSqliteStoreForTests();
    const recovered = await initializeSqliteProjectStore();
    assert.equal(recovered.phase, 'complete');
    assert.equal(existsSync(importReceiptPath(profile)), true,
      'startup repairs a missing receipt sidecar from SQLite authority');
    assert.deepEqual((await sqliteReadEntry(GENERATION_JOBS_KV_KEY)).value, jobs);

    const cleanup = cleanupLegacyJson();
    assert.ok(cleanup.removed >= 2);
    assert.equal(existsSync(customJobsPath), false,
      'custom ledger cleanup occurs only after its exact hash was confirmed imported');

    // A phase-1 marker proves current SQLite project authority but is not yet a
    // usable phase-2 store. Startup imports only missing auxiliary snapshots.
    resetSqliteStoreForTests();
    const phaseOneProjectSource = join(
      profile.projectStore.directory,
      'project%3Aphase-one-edited.json',
    );
    const phaseOneDeletedSource = join(
      profile.projectStore.directory,
      'chat%3Aphase-one-deleted.json',
    );
    const phaseOneOriginalProject = JSON.stringify({ title: 'phase-one-original' });
    const phaseOneDeletedChat = JSON.stringify({ mustNotResurrect: true });
    writeFileSync(phaseOneProjectSource, phaseOneOriginalProject);
    writeFileSync(phaseOneDeletedSource, phaseOneDeletedChat);
    replaceSqlite(sqlitePath, {
      'project:phase-one-edited': phaseOneOriginalProject,
      'chat:phase-one-deleted': phaseOneDeletedChat,
    });
    const phaseOneKeys = {
      'project:phase-one-edited': sha256(Buffer.from(phaseOneOriginalProject)),
      'chat:phase-one-deleted': sha256(Buffer.from(phaseOneDeletedChat)),
    };
    const phaseOneReceipt = {
      source: profile.projectStore.directory,
      count: 2,
      importedAt: '2026-08-11T00:00:00.000Z',
      phase: 1,
      keys: phaseOneKeys,
      sources: {
        'project:phase-one-edited': {
          path: phaseOneProjectSource,
          sha256: phaseOneKeys['project:phase-one-edited'],
          kind: 'project-store-entry',
        },
        'chat:phase-one-deleted': {
          path: phaseOneDeletedSource,
          sha256: phaseOneKeys['chat:phase-one-deleted'],
          kind: 'project-store-entry',
        },
      },
    };
    writeMigrationReceipt(sqlitePath, phaseOneReceipt);
    const current = new DatabaseSync(sqlitePath);
    current.prepare('UPDATE kv SET v = ? WHERE k = ?')
      .run(JSON.stringify({ title: 'edited-in-phase-one-sqlite' }), 'project:phase-one-edited');
    current.prepare('DELETE FROM kv WHERE k = ?').run('chat:phase-one-deleted');
    current.prepare('INSERT INTO kv (k, v) VALUES (?, ?)')
      .run('project:phase-one-sqlite-only', JSON.stringify({ inserted: true }));
    current.close();

    const phaseOneJobs = { version: 1, jobs: [{ id: 'phase-one-job', status: 'queued' }] };
    const deletedProjects = { 'phase-one-deleted-project': 1_723_337_200_000 };
    writeFileSync(customJobsPath, JSON.stringify(phaseOneJobs));
    writeFileSync(profile.projectStore.tombstonePath, JSON.stringify(deletedProjects));
    assert.equal(sqliteStoreEnabled(), false,
      'a phase-1 marker must not enable the SQLite backend');
    assert.equal(sqliteMigrationStatus().phase, 'legacy',
      'a phase-1 marker must not report migration complete');

    let enteredBarrier!: () => void;
    const barrierEntered = new Promise<void>((resolve) => {
      enteredBarrier = resolve;
    });
    let allowUpgrade!: () => void;
    const upgradeAllowed = new Promise<void>((resolve) => {
      allowUpgrade = resolve;
    });
    const unregisterBarrier = registerStorageMigrationBarrier(async () => {
      enteredBarrier();
      await upgradeAllowed;
    });
    const upgrading = initializeSqliteProjectStore();
    await barrierEntered;
    assert.equal(sqliteStoreEnabled(), false,
      'phase 1 stays disabled while the upgrade is waiting under the migration lease');
    assert.equal(sqliteMigrationStatus().phase, 'migrating');
    assert.equal(sqliteMigrationStatus().receipt, null,
      'phase-1 receipt metadata must not be presented as completed phase 2');
    allowUpgrade();
    const upgraded = await upgrading;
    unregisterBarrier();
    assert.equal(upgraded.phase, 'complete');
    assert.equal(sqliteStoreEnabled(), true);
    assert.equal(readMigrationPhase(sqlitePath), 2);
    assert.deepEqual(await sqliteReadEntry('project:phase-one-edited'), {
      found: true,
      value: { title: 'edited-in-phase-one-sqlite' },
    }, 'phase-1 upgrade preserves current SQLite project edits');
    assert.deepEqual(await sqliteReadEntry('chat:phase-one-deleted'), { found: false },
      'phase-1 upgrade does not resurrect deleted chat JSON');
    assert.deepEqual(await sqliteReadEntry('project:phase-one-sqlite-only'), {
      found: true,
      value: { inserted: true },
    }, 'phase-1 upgrade preserves SQLite-only inserts');
    assert.deepEqual((await sqliteReadEntry(GENERATION_JOBS_KV_KEY)).value, phaseOneJobs);
    assert.deepEqual((await sqliteReadEntry(DELETED_PROJECTS_KV_KEY)).value, deletedProjects);

    // Auxiliary inserts and the phase-2 marker roll back together on failure.
    resetSqliteStoreForTests();
    replaceSqlite(sqlitePath, {
      'project:phase-one-edited': JSON.stringify({ title: 'still-authoritative' }),
    });
    writeMigrationReceipt(sqlitePath, phaseOneReceipt);
    writeFileSync(profile.projectStore.tombstonePath, JSON.stringify(deletedProjects));
    const failing = new DatabaseSync(sqlitePath);
    failing.exec(`
      CREATE TRIGGER fail_phase_two_auxiliary
      BEFORE INSERT ON kv
      WHEN NEW.k = '${DELETED_PROJECTS_KV_KEY}'
      BEGIN
        SELECT RAISE(ABORT, 'forced phase-2 marker failure');
      END
    `);
    failing.close();
    const failedUpgrade = await initializeSqliteProjectStore();
    assert.equal(failedUpgrade.phase, 'failed');
    assert.equal(failedUpgrade.enabled, false);
    assert.equal(failedUpgrade.receipt, null);
    assert.equal(readMigrationPhase(sqlitePath), 1,
      'a failed auxiliary import must leave the phase-1 marker authoritative');
    assert.deepEqual(await sqliteReadEntry(GENERATION_JOBS_KV_KEY), { found: false },
      'an auxiliary row inserted before failure must roll back with the marker');
    rmSync(profile.projectStore.tombstonePath);
    rmSync(customJobsPath);

    await verifyCfcMigrationChecks({
      profile,
      sqlitePath,
      jobs,
      store: {
        cleanupLegacyJson,
        initializeSqliteProjectStore,
        resetSqliteStoreForTests,
        runStorageMigration,
        sqliteMigrationStatus,
        sqliteReadEntry,
      },
      migration: {
        GENERATION_JOBS_KV_KEY,
        importReceiptPath,
        readImportReceipt,
      },
    });
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousStore === undefined) delete process.env.OPENCHATCUT_GENERATION_JOB_STORE;
    else process.env.OPENCHATCUT_GENERATION_JOB_STORE = previousStore;
    if (previousSwitch === undefined) delete process.env.OPENCHATCUT_SQLITE_STORE;
    else process.env.OPENCHATCUT_SQLITE_STORE = previousSwitch;
    rmSync(home, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
