// SQLite project-store backend — phase 0 verification.
//
// Covers: default-off (JSON-file store unchanged), opt-in switch (single
// SQLite db, JSON dir untouched), full entry lifecycle, merge, purge, and
// reopen persistence. Runs against a temporary HOME so no real data is touched.
//
// IMPORTANT: every import of the store/profile modules must happen AFTER the
// temporary HOME is set — runtime-profile.ts caches activeProfile at module
// load, and a static import would freeze the real user profile.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'occ-sqlite-store-verify-'));
  const previousHome = process.env.HOME;
  process.env.HOME = root;

  try {
    const { SQLITE_STORE_ENV } = await import('./sqlite-store.ts');
    delete process.env[SQLITE_STORE_ENV];

    // Import AFTER HOME is set: runtimeProfile() freezes the profile at load.
    const store = await import('../plugins/project-store.ts');
    const {
      sqliteMigrationStatus,
      sqliteStoreEnabled,
      sqliteImportJson,
      resetSqliteStoreForTests,
    } = await import('./sqlite-store.ts');

    const storeDir = join(root, '.openchatcut', 'project-store-v1');
    const sqlitePath = join(root, '.openchatcut', 'project-store-v1.sqlite3');

    // ── Scenario A: default off → JSON-file store, byte-identical behavior ──
    assert.equal(sqliteStoreEnabled(), false, 'the SQLite backend must be off by default');
    await store.setStoredEntry('chat:test-a', { hello: 'file' });
    assert.equal(existsSync(join(storeDir, 'chat%3Atest-a.json')), true,
      'default mode must write the JSON file exactly as before');
    assert.deepEqual(await store.getStoredEntry('chat:test-a'), { found: true, value: { hello: 'file' } });
    const before = await store.readStore();
    assert.equal(before.entries['chat:test-a']?.hello, 'file');
    await store.deleteStoredEntry('chat:test-a');
    assert.deepEqual(await store.getStoredEntry('chat:test-a'), { found: false });

    // ── Scenario B: opt-in → SQLite backend, JSON dir untouched ──
    process.env[SQLITE_STORE_ENV] = '1';
    assert.equal(sqliteStoreEnabled(), true, 'the switch must enable the SQLite backend');

    await store.setStoredEntry('project:sqlite-b', { doc: { timeline: true } });
    await store.setStoredEntry('chat:sqlite-b', { message: 'hello' });
    await store.setStoredEntry('versions:sqlite-b', [{ v: 1 }]);
    await sleep(50);

    // Bug regression: writing the projects index in SQLite mode must keep
    // existing projects (the file-based existence probe must not run).
    // updatedAt:1 keeps the later merge (updatedAt:2) able to overwrite.
    await store.setStoredEntry('projects', [{ id: 'sqlite-b', updatedAt: 1 }]);
    const indexCheck = await store.getStoredEntry('projects');
    assert.equal(Array.isArray(indexCheck.value) && indexCheck.value.length === 1,
      true, 'SQLite mode must keep the project in the index');
    assert.equal(indexCheck.value?.[0]?.id, 'sqlite-b');
    assert.equal(existsSync(sqlitePath), true, 'the SQLite db file must be created');
    assert.equal(
      readdirSync(storeDir).some((f) => f.includes('sqlite-b')),
      false,
      'the JSON store directory must not receive new files in SQLite mode',
    );
    assert.deepEqual(await store.getStoredEntry('project:sqlite-b'),
      { found: true, value: { doc: { timeline: true } } });
    const snapshot = await store.readStore();
    assert.equal(snapshot.entries['chat:sqlite-b']?.message, 'hello');
    assert.equal(snapshot.entries['versions:sqlite-b']?.length, 1);

    // merge (full replace) must land in SQLite atomically; the projects
    // index drives updatedAt-based overwrite semantics for project keys.
    await store.mergeStoredEntries({
      projects: [{ id: 'sqlite-b', updatedAt: 2 }],
      'project:sqlite-b': { doc: { merged: true } },
      'chat:sqlite-b': { message: 'merged' },
    });
    assert.equal((await store.getStoredEntry('project:sqlite-b')).value?.doc.merged, true);

    // Bug regression: removeEntry (compareAndSwap/agent-session paths) must
    // delete SQLite rows, not just the (absent) JSON file.
    await store.withProjectStoreLock((locked) => locked.removeEntry('versions:sqlite-b'));
    assert.deepEqual(await store.getStoredEntry('versions:sqlite-b'), { found: false },
      'removeEntry must delete the SQLite row');

    // purge a project: document + chat + versions all removed, tombstone kept
    await store.deleteStoredEntry('project:sqlite-b');
    assert.deepEqual(await store.getStoredEntry('project:sqlite-b'), { found: false });
    assert.deepEqual(await store.getStoredEntry('chat:sqlite-b'), { found: false });
    assert.deepEqual(await store.getStoredEntry('versions:sqlite-b'), { found: false });

    // ── Reopen persistence: close the connection, data must survive ──
    await store.setStoredEntry('project:persist-c', { value: 42 });
    resetSqliteStoreForTests();
    assert.deepEqual(await store.getStoredEntry('project:persist-c'),
      { found: true, value: { value: 42 } },
      'data must survive a connection close (WAL checkpoint)');

    // ── Switch back off: SQLite file stays, JSON mode keeps working ──
    delete process.env[SQLITE_STORE_ENV];
    await store.setStoredEntry('chat:after-off', { ok: true });
    assert.equal(existsSync(join(storeDir, 'chat%3Aafter-off.json')), true,
      'turning the switch off must restore the JSON-file path immediately');

    // ── Scenario C: JSON→SQLite import (phase 1) ──
    // Seed legacy JSON data in file mode first.
    await store.setStoredEntry('project:import-p', { doc: { v: 1 }, updatedAt: 1 });
    await store.setStoredEntry('chat:import-1', { m: 'one' });
    await store.setStoredEntry('chat:import-2', { m: 'two' });
    await store.setStoredEntry('versions:import-p', [{ v: 1 }]);
    await store.setStoredEntry('thumb:import-p', { thumb: true });
    const jsonFilesBefore = readdirSync(storeDir).filter((f) => f.endsWith('.json')).sort();

    // Before migration: status reports JSON mode, no receipt, no SQLite file.
    const statusBefore = sqliteMigrationStatus();
    assert.equal(statusBefore.enabled, false, 'status must report JSON mode before migration');
    assert.equal(statusBefore.receipt, null);
    assert.equal(statusBefore.jsonKeyCount, 6);
    assert.equal(statusBefore.sqliteKeyCount, 3); // projects index + persist-c + tombstone from scenario B

    process.env[SQLITE_STORE_ENV] = '1';
    const first = sqliteImportJson();
    assert.equal(first.imported, 6, 'all six legacy keys (5 import + after-off) must be imported');
    assert.equal(first.quarantined, 0);
    assert.equal(first.receiptWritten, true, 'a completion receipt must be written');
    assert.deepEqual(await store.getStoredEntry('chat:import-1'),
      { found: true, value: { m: 'one' } },
      'imported keys must be readable through the SQLite store');
    assert.equal((await store.getStoredEntry('thumb:import-p')).value?.thumb, true);

    // The JSON directory must not be touched (no move, no delete, no rewrite).
    const jsonFilesAfter = readdirSync(storeDir).filter((f) => f.endsWith('.json')).sort();
    assert.deepEqual(jsonFilesAfter, jsonFilesBefore,
      'the JSON source directory must remain byte-untouched after import');
    assert.equal(existsSync(join(root, '.openchatcut', 'project-store-v1.sqlite3.receipt.json')), true,
      'the receipt must live next to the SQLite database');

    // Idempotent re-run: receipt present → no-op; forced re-scan → all skipped.
    const noop = sqliteImportJson();
    assert.equal(noop.imported, 0, 'a receipt must gate further imports');
    const receiptPath = join(root, '.openchatcut', 'project-store-v1.sqlite3.receipt.json');
    rmSync(receiptPath, { force: true }); // simulate crash-without-receipt
    const resume = sqliteImportJson();
    assert.equal(resume.imported, 0, 'resume must skip keys whose hash still matches');
    assert.equal(resume.skipped, 6);

    // Resume must refill a missing row (crash between batches).
    rmSync(receiptPath, { force: true });
    await store.deleteStoredEntry('chat:import-2');
    const refill = sqliteImportJson();
    assert.equal(refill.imported, 1, 'the deleted row must be refilled from the JSON source');
    assert.deepEqual(await store.getStoredEntry('chat:import-2'),
      { found: true, value: { m: 'two' } });

    // ── User-initiated switch: after migration, no env var is needed ──
    delete process.env[SQLITE_STORE_ENV];
    assert.equal(sqliteStoreEnabled(), true,
      'a completed migration must enable the SQLite backend without the env var');
    const after = sqliteMigrationStatus();
    assert.equal(after.enabled, true);
    assert.equal(after.receipt?.count, 6, 'the status must report the migrated key count');
    assert.equal(after.sqliteKeyCount, 9, 'the status must report SQLite row count (3 prior + 6 imported)');

    // ── Scenario D: auxiliary files (generation-operations + tombstone) ──
    // A user who migrated on an earlier build has a phase-1 receipt; the next
    // start must import the two server-managed files and upgrade the receipt.
    const auxGeneration = join(root, '.openchatcut', 'generation-operations-v1.json');
    const auxTombstone = join(root, '.openchatcut', 'deleted-projects-v1.json');
    writeFileSync(auxGeneration, JSON.stringify({
      version: 1,
      jobs: [{ id: 'gen-1', status: 'succeeded', progress: 1, params: {}, createdAt: 1, updatedAt: 1 }],
    }));
    writeFileSync(auxTombstone, JSON.stringify({ 'deleted-old-project': Date.now() }));
    const receiptPath2 = join(root, '.openchatcut', 'project-store-v1.sqlite3.receipt.json');
    const phase1Receipt = JSON.parse(readFileSync(receiptPath2, 'utf8'));
    delete phase1Receipt.phase; // simulate a receipt written by the earlier build
    writeFileSync(receiptPath2, JSON.stringify(phase1Receipt));

    const upgrade = sqliteImportJson();
    assert.equal(upgrade.imported, 1,
      'only the missing generation snapshot is imported (kv tombstone is authoritative)');
    assert.equal(upgrade.skipped, 1, 'the existing kv tombstone is skipped (dir keys are not rescanned)');
    const genRow = await store.getStoredEntry('generation-jobs:snapshot');
    assert.equal(genRow.found, true, 'generation operations must live in SQLite after the upgrade');
    assert.equal(genRow.value?.jobs?.[0]?.id, 'gen-1');
    const tombRow = await store.getStoredEntry('deleted-projects:v1');
    assert.equal(tombRow.found, true, 'the tombstone must live in SQLite after the upgrade');
    assert.equal(typeof tombRow.value?.['sqlite-b'], 'number',
      'the runtime tombstone (scenario B purge) must stay authoritative over the archived file');
    const upgradedReceipt = JSON.parse(readFileSync(receiptPath2, 'utf8'));
    assert.equal(upgradedReceipt.phase, 2, 'the receipt must be upgraded to phase 2');

    // Tombstone semantics over SQLite: a purged project stays deleted.
    process.env[SQLITE_STORE_ENV] = '1';
    await store.setStoredEntry('project:tomb-probe', { doc: {} });
    await store.deleteStoredEntry('project:tomb-probe');
    assert.deepEqual(await store.getStoredEntry('project:tomb-probe'), { found: false },
      'a purged project must stay deleted via the SQLite tombstone');

    // ── legacy JSON cleanup (user-confirmed deletion) ──
    const { cleanupLegacyJson } = await import('./sqlite-store.ts');
    const jsonDir = join(root, '.openchatcut', 'project-store-v1');
    const remainingJson = readdirSync(jsonDir).filter((name) => name.endsWith('.json'));
    assert.ok(remainingJson.length > 0, 'sanity: legacy JSON files still exist before cleanup');
    const cleanup = cleanupLegacyJson();
    assert.equal(cleanup.jsonKeyCount, 0, 'cleanup must remove every legacy JSON key');
    assert.ok(cleanup.removed >= remainingJson.length,
      'cleanup must report the removed count (JSON keys + aux files)');
    assert.ok(!existsSync(join(root, 'generation-operations-v1.json')), 'phase-2 aux file must be cleaned too');
    assert.ok(existsSync(jsonDir), 'the JSON directory itself must stay');

    console.log('✓ sqlite-store verify: import / receipt / source-untouched / idempotent / resume-refill / user-switch / aux-phase-upgrade / cleanup all passed');
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    rmSync(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
