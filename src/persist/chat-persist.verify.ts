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

const { loadChat, loadChatResult, saveChat, clearChat, isPersistedChat, migrateProjectDoc, docFromTimeline } = await import('./projectStore');
const { configureSharedKvBackend, resetSharedKvMemory } = await import('./sharedKv');

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

// round-trip: save → load returns the same rows + llm history (+ stamped session generation)
const chat = { messages: [{ role: 'user', text: 'hi' }], llm: [{ role: 'user', content: 'hi' }] };
await saveChat('p1', chat);
const back = await loadChat('p1');
assert.deepStrictEqual(back?.messages, chat.messages);
assert.deepStrictEqual(back?.llm, chat.llm);
assert.ok(typeof back?.sessionGeneration === 'string', 'session generation is stamped on write');

// per-project isolation: another project is still empty
assert.strictEqual(await loadChat('p2'), null);

// clear removes it
await clearChat('p1');
assert.strictEqual(await loadChat('p1'), null);

configureSharedKvBackend({
  get: async () => undefined,
  set: async () => { throw new Error('forced chat write failure'); },
  delete: async () => undefined,
  keys: async () => [],
  writeAgentRuntime: async () => { throw new Error('unused'); },
  updateAgentRunLease: async () => { throw new Error('unused'); },
});
await assert.rejects(saveChat('p-fail', chat), /forced chat write failure/,
  'saveChat exposes persistence failures to awaited callers');
resetSharedKvMemory();

// ── load 三态:"读不出来" 必须与 "没有聊天" 区分开 ─────────────────────────
// 混淆两者会让 hydration 以空会话进入,随后一次常规持久化覆盖掉真实对话。
assert.strictEqual((await loadChatResult('p-absent')).status, 'missing',
  'no stored chat reads as missing (an empty chat is legitimate)');

await saveChat('p-ok', chat);
const okResult = await loadChatResult('p-ok');
assert.strictEqual(okResult.status, 'ok');
assert.deepStrictEqual(okResult.status === 'ok' ? okResult.chat.messages : null, chat.messages);

configureSharedKvBackend({
  get: async () => { throw new Error('forced chat read failure'); },
  set: async () => undefined,
  delete: async () => undefined,
  keys: async () => [],
  writeAgentRuntime: async () => { throw new Error('unused'); },
  updateAgentRunLease: async () => { throw new Error('unused'); },
});
assert.strictEqual((await loadChatResult('p-ok')).status, 'unreadable',
  'a transient read failure is unreadable, NOT missing');
assert.strictEqual(await loadChat('p-ok'), null,
  'the legacy loadChat wrapper still collapses both to null for its callers');
resetSharedKvMemory();

configureSharedKvBackend({
  get: async <T,>() => ({ garbage: true } as T),
  set: async () => undefined,
  delete: async () => undefined,
  keys: async () => [],
  writeAgentRuntime: async () => { throw new Error('unused'); },
  updateAgentRunLease: async () => { throw new Error('unused'); },
});
assert.strictEqual((await loadChatResult('p-corrupt')).status, 'unreadable',
  'stored bytes that fail shape validation are unreadable, not missing');
resetSharedKvMemory();

console.log('chat-persist.check: ok');
