// Runnable check: `npx tsx src/persist/exportHistoryStore.check.ts`.
// Covers (1) export-history recordExport→listExportHistory ordering + clear via a
// minimal in-memory IndexedDB shim, and (2) the watermark reduce action's
// immutability + opacity clamp + default-fill (pure, no IDB).
import assert from 'node:assert';
import { reduce } from '../editor/reduce';
import { DEFAULT_WATERMARK, type TimelineState } from '../editor/types';

// ── tiny in-memory IndexedDB shim (get/put for the kv store) ──
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

const { recordExport, listExportHistory, clearExportHistory } = await import('./exportHistoryStore');

// ── (1) export history ──
assert.deepStrictEqual(await listExportHistory(), [], 'empty before any record');

await recordExport({ name: 'first.mp4', format: 'video', codec: 'h264', sizeBytes: 1000, createdAt: 1 });
await recordExport({ name: 'second.mp3', format: 'audio', codec: 'mp3', sizeBytes: 2000, createdAt: 2 });
await recordExport({ name: 'third.srt', format: 'subtitles', frameRange: { start: 0, end: 90 }, createdAt: 3 });

const listed = await listExportHistory();
assert.strictEqual(listed.length, 3, 'all three recorded');
assert.deepStrictEqual(listed.map((r) => r.name), ['third.srt', 'second.mp3', 'first.mp4'], 'newest-first order');
assert.ok(listed.every((r) => typeof r.id === 'string' && r.id.length > 0), 'each record gets an id');
assert.deepStrictEqual(listed[0].frameRange, { start: 0, end: 90 }, 'frameRange round-trips');

assert.strictEqual((await listExportHistory(2)).length, 2, 'limit caps the list');

// corrupt persisted entries are dropped on read
mem.set('export:history', [
  { id: 'ok', name: 'good.mp4', format: 'video', createdAt: 9 },
  { id: 'bad', name: 'no-format', createdAt: 10 }, // missing format
  'not-an-object',
]);
const afterCorrupt = await listExportHistory();
assert.strictEqual(afterCorrupt.length, 1, 'corrupt entries dropped');
assert.strictEqual(afterCorrupt[0].id, 'ok');

await clearExportHistory();
assert.deepStrictEqual(await listExportHistory(), [], 'clear empties the history');

// ── (2) watermark reduce (immutable, clamps opacity, fills defaults) ──
const base: TimelineState = { fps: 30, width: 1920, height: 1080, items: [], selectedId: null };

// first use fills from DEFAULT_WATERMARK
const enabled = reduce(base, { type: 'updateWatermark', patch: { enabled: true, text: 'DRAFT' } });
assert.notStrictEqual(enabled, base, 'returns a new state object');
assert.strictEqual(base.watermark, undefined, 'original state is not mutated');
assert.deepStrictEqual(enabled.watermark, { ...DEFAULT_WATERMARK, enabled: true, text: 'DRAFT' }, 'defaults filled on first use');

// opacity is clamped into 0..1
const overshoot = reduce(enabled, { type: 'updateWatermark', patch: { opacity: 5 } });
assert.strictEqual(overshoot.watermark!.opacity, 1, 'opacity clamped high');
const undershoot = reduce(enabled, { type: 'updateWatermark', patch: { opacity: -3 } });
assert.strictEqual(undershoot.watermark!.opacity, 0, 'opacity clamped low');
assert.notStrictEqual(overshoot.watermark, enabled.watermark, 'watermark object replaced, not mutated');
assert.strictEqual(enabled.watermark!.opacity, DEFAULT_WATERMARK.opacity, 'prior watermark untouched');

console.log('exportHistoryStore.check: ok');
