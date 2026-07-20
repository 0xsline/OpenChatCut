// Runnable check: `npx tsx src/persist/version-store.check.ts`.
// Round-trip versionStore named project snapshots.
// through a minimal in-memory IndexedDB shim; asserts save→list (newest-first),
// restore-shape (migrateProjectDoc-clean doc), delete, and corrupt-entry drop.
import assert from 'node:assert';

// ── tiny in-memory IndexedDB shim (enough for the kv store's get/put/delete) ──
const mem = new Map<string, unknown>();
const fire = (req: { onsuccess?: () => void; onerror?: () => void }) => setTimeout(() => req.onsuccess?.(), 0);
function makeStore() {
  return {
    get: (k: string) => { const r: any = {}; r.result = mem.get(k); fire(r); return r; },
    put: (v: unknown, k: string) => { mem.set(k, v); const r: any = {}; fire(r); return r; },
    delete: (k: string) => { mem.delete(k); const r: any = {}; fire(r); return r; },
  };
}
(globalThis as any).indexedDB = {
  open: () => {
    const req: any = { result: { transaction: () => { const tx: any = { objectStore: makeStore }; setTimeout(() => tx.oncomplete?.(), 0); return tx; } } };
    setTimeout(() => req.onsuccess?.(), 0);
    return req;
  },
};

const { listVersions, saveVersion, deleteVersion } = await import('./versionStore');
const { docFromTimeline } = await import('./projectStore');

const doc = docFromTimeline({ fps: 30, width: 1920, height: 1080, selectedId: null, items: [] } as any);

// empty before any save
assert.deepStrictEqual(await listVersions('p1'), []);

// save → list (newest-first)
const v1 = await saveVersion('p1', '第一版', doc);
await new Promise((r) => setTimeout(r, 2)); // ensure createdAt strictly increases
const v2 = await saveVersion('p1', '第二版', doc);
const listed = await listVersions('p1');
assert.strictEqual(listed.length, 2);
assert.strictEqual(listed[0].id, v2.id, 'newest first');
assert.strictEqual(listed[1].id, v1.id);

// restore-shape: doc round-trips through migrateProjectDoc cleanly
assert.strictEqual(listed[0].doc.version, 2);
assert.strictEqual(listed[0].doc.activeTimelineId, doc.activeTimelineId);
assert.strictEqual(listed[0].doc.timelines.length, doc.timelines.length);

// per-project isolation
assert.deepStrictEqual(await listVersions('p2'), []);

// delete
await deleteVersion('p1', v2.id);
const afterDelete = await listVersions('p1');
assert.strictEqual(afterDelete.length, 1);
assert.strictEqual(afterDelete[0].id, v1.id);

// corrupt entry dropped on load (missing name, and a doc that fails migration)
mem.set('versions:p3', [
  { id: 'ok', name: '正常', createdAt: 1, doc },
  { id: 'bad1', createdAt: 2, doc }, // missing name
  { id: 'bad2', name: '坏文档', createdAt: 3, doc: { nope: true } }, // fails migrateProjectDoc
  'not-even-an-object',
]);
const p3 = await listVersions('p3');
assert.strictEqual(p3.length, 1);
assert.strictEqual(p3[0].id, 'ok');

console.log('version-store.check: ok');
