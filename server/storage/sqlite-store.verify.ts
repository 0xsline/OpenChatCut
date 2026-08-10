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
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
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
    const { sqliteStoreEnabled, resetSqliteStoreForTests } = await import('./sqlite-store.ts');

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

    console.log('✓ sqlite-store verify: default-off / opt-in / lifecycle / purge / reopen persistence / switch-back all passed');
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
