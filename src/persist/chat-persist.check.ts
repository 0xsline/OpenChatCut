// Runnable check: `npx tsx src/persist/chat-persist.check.ts`.
// Round-trip chat persistence through a minimal in-memory
// IndexedDB shim, and asserts the boundary validator rejects corrupt data.
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

const { loadChat, saveChat, clearChat, isPersistedChat, migrateProjectDoc, docFromTimeline } = await import('./projectStore');

// regression: migrateProjectDoc must PRESERVE designStyle (it rebuilds the doc
// field-by-field, so an omitted field is silently dropped on every load).
const withStyle = {
  ...docFromTimeline({ fps: 30, width: 1920, height: 1080, selectedId: null, items: [] } as any),
  designStyle: { colors: [{ role: 'primary', value: '#FF2D78' }], fonts: [{ family: 'Sora', role: 'heading' }], styleGuide: 'x' },
};
const migrated = migrateProjectDoc(withStyle);
assert.strictEqual(migrated?.designStyle?.colors?.[0]?.value, '#FF2D78', 'migration preserves designStyle');
// a corrupt designStyle shape is dropped, not trusted
const bad = migrateProjectDoc({ ...withStyle, designStyle: { colors: 'nope' } });
assert.strictEqual(bad?.designStyle, undefined, 'corrupt designStyle dropped');

// validator: rejects corrupt / partial shapes, accepts the real shape
assert.ok(!isPersistedChat(null));
assert.ok(!isPersistedChat({ messages: [] }), 'missing llm rejected');
assert.ok(!isPersistedChat({ messages: 'x', llm: [] }), 'non-array messages rejected');
assert.ok(isPersistedChat({ messages: [], llm: [] }));

// empty before any save
assert.strictEqual(await loadChat('p1'), null);

// round-trip: save → load returns the same rows + llm history
const chat = { messages: [{ role: 'user', text: 'hi' }], llm: [{ role: 'user', content: 'hi' }] };
await saveChat('p1', chat);
const back = await loadChat('p1');
assert.deepStrictEqual(back, chat);

// per-project isolation: another project is still empty
assert.strictEqual(await loadChat('p2'), null);

// clear removes it
await clearChat('p1');
assert.strictEqual(await loadChat('p1'), null);

console.log('chat-persist.check: ok');
