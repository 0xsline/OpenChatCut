// Runnable contract check: `npx tsx src/agent/design-tools.check.ts`.
// Covers manage_design_style: preset list/apply, custom designSpec (array +
// legacy role-keyed object normalizers), update patch, clear,
// AND the owned-style library ("我的风格": save/list/apply/delete), which
// persists through projectStore's IndexedDB helpers — hence the in-memory
// IndexedDB shim below (same pattern as src/persist/chat-persist.check.ts),
// installed BEFORE anything that touches the store is imported.
import assert from 'node:assert';
import type { TimelineState } from '../../editor/types';
import type { AgentContext } from '../context';

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

const { makeDraft } = await import('../../editor/store');
const { docFromTimeline } = await import('../../persist/projectStore');
const { execDesignTool } = await import('./design-tools');
const { DESIGN_STYLE_PRESETS } = await import('../../editor/design-presets');

const state: TimelineState = { fps: 30, width: 1920, height: 1080, selectedId: null, items: [] };
const draft = makeDraft(docFromTimeline(state));
const ctx: AgentContext = { commands: draft.commands, getState: draft.getState, getDoc: draft.getDoc, getCreativeMode: () => null, templates: [], audio: [] };

// list returns { catalog, owned } — catalog is the built-in preset library, owned starts empty
const list0 = await execDesignTool('manage_design_style', { action: 'list' }, ctx) as { catalog: { presetId: string }[]; owned: unknown[] };
assert.strictEqual(list0.catalog.length, DESIGN_STYLE_PRESETS.length);
assert.deepStrictEqual(list0.owned, []);

// get is empty before anything is applied
assert.deepStrictEqual(await execDesignTool('manage_design_style', { action: 'get' }, ctx), { designStyle: null });

// Apply a real catalog preset and verify the project brand.
await execDesignTool('manage_design_style', { action: 'apply', presetId: DESIGN_STYLE_PRESETS[0].id }, ctx);
assert.strictEqual(
  draft.getDoc().designStyle?.colors.find((c) => c.role === 'background')?.value,
  DESIGN_STYLE_PRESETS[0].style.colors.find((c) => c.role === 'background')?.value,
);

// Apply a legacy object-form designSpec and normalize it to arrays.
await execDesignTool('manage_design_style', {
  action: 'apply',
  designSpec: JSON.stringify({ colors: { primary: '#112233', text: '#ffffff' }, fonts: { heading: 'Sora' }, styleGuide: 'clean' }),
}, ctx);
const s1 = draft.getDoc().designStyle!;
assert.strictEqual(s1.colors.find((c) => c.role === 'primary')?.value, '#112233');
assert.strictEqual(s1.fonts.find((f) => f.role === 'heading')?.family, 'Sora');
assert.strictEqual(s1.styleGuide, 'clean');

// apply array form + applyToProject:false → returns style but does NOT mutate project
const dry = await execDesignTool('manage_design_style', {
  action: 'apply', applyToProject: false,
  designSpec: JSON.stringify({ colors: [{ role: 'accent', value: '#ff0000' }] }),
}, ctx) as { applied: boolean };
assert.strictEqual(dry.applied, false);
assert.strictEqual(draft.getDoc().designStyle?.colors.find((c) => c.role === 'accent')?.value, undefined);

// update patches only the named field
await execDesignTool('manage_design_style', { action: 'update', patch: JSON.stringify({ styleGuide: 'updated' }) }, ctx);
assert.strictEqual(draft.getDoc().designStyle?.styleGuide, 'updated');
assert.strictEqual(draft.getDoc().designStyle?.colors.find((c) => c.role === 'primary')?.value, '#112233', 'update keeps other fields');

// Free-form roles such as "accent copper" and "Chinese heading" are retained.
// Only blank role/value entries are dropped.
await execDesignTool('manage_design_style', {
  action: 'apply', designSpec: JSON.stringify({ colors: [
    { role: 'accent copper', value: '#D4763A' },
    { role: 'text secondary', value: 'rgba(255,255,255,0.7)' },
    { role: '', value: '#000' }, // blank role → dropped
  ], fonts: [{ role: 'Chinese heading', family: 'Noto Sans SC' }] }),
}, ctx);
const free = draft.getDoc().designStyle!;
assert.deepStrictEqual(free.colors.map((c) => c.role), ['accent copper', 'text secondary']);
assert.strictEqual(free.colors.find((c) => c.role === 'text secondary')?.value, 'rgba(255,255,255,0.7)');
assert.strictEqual(free.fonts[0]?.role, 'Chinese heading');

// empty spec is rejected
assert.ok('error' in (await execDesignTool('manage_design_style', { action: 'apply', designSpec: '{}' }, ctx) as object));

// clear removes the brand
await execDesignTool('manage_design_style', { action: 'clear' }, ctx);
assert.strictEqual(draft.getDoc().designStyle, undefined);

// ── owned-style library ("我的风格"): save → list → apply by id → delete ──
// save requires a name
assert.ok('error' in (await execDesignTool('manage_design_style', { action: 'save', designSpec: '{}' }, ctx) as object));

const saveRes = await execDesignTool('manage_design_style', {
  action: 'save', name: '我的风格 1',
  designSpec: JSON.stringify({ colors: [{ role: 'primary', value: '#123456' }], fonts: [{ role: 'heading', family: 'Sora' }] }),
}, ctx) as { ok: boolean; saved: { id: string; name: string } };
assert.ok(saveRes.ok);
assert.strictEqual(saveRes.saved.name, '我的风格 1');

const list1 = await execDesignTool('manage_design_style', { action: 'list' }, ctx) as { owned: { presetId: string; name: string }[] };
assert.strictEqual(list1.owned.length, 1);
assert.strictEqual(list1.owned[0].presetId, saveRes.saved.id);
assert.strictEqual(list1.owned[0].name, '我的风格 1');

// saving again under the same name replaces (not duplicates) the entry
const resave = await execDesignTool('manage_design_style', {
  action: 'save', name: '我的风格 1', designSpec: JSON.stringify({ colors: [{ role: 'primary', value: '#abcdef' }] }),
}, ctx) as { saved: { id: string } };
assert.strictEqual(resave.saved.id, saveRes.saved.id, 'same-name save replaces the existing entry');
const list1b = await execDesignTool('manage_design_style', { action: 'list' }, ctx) as { owned: unknown[] };
assert.strictEqual(list1b.owned.length, 1);

// apply by owned id — owned styles apply exactly like catalog presets
await execDesignTool('manage_design_style', { action: 'apply', presetId: saveRes.saved.id }, ctx);
assert.strictEqual(draft.getDoc().designStyle?.colors.find((c) => c.role === 'primary')?.value, '#abcdef');

// deleting a catalog id is rejected — only owned styles can be deleted
const delCatalog = await execDesignTool('manage_design_style', { action: 'delete', presetId: DESIGN_STYLE_PRESETS[0].id }, ctx) as { error?: string };
assert.ok(delCatalog.error?.includes("can't be deleted"));

// deleting an unknown id errors
const delUnknown = await execDesignTool('manage_design_style', { action: 'delete', presetId: 'nope' }, ctx) as { error?: string };
assert.ok(delUnknown.error);

// delete the owned style; it disappears from list
await execDesignTool('manage_design_style', { action: 'delete', presetId: saveRes.saved.id }, ctx);
const list2 = await execDesignTool('manage_design_style', { action: 'list' }, ctx) as { owned: unknown[] };
assert.deepStrictEqual(list2.owned, []);

console.log('design-tools.check: ok');
