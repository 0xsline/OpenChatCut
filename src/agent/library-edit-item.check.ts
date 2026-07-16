// Runnable smoke test for browse_library + edit_item (source-aligned path).
//   npx vite-node src/agent/library-edit-item.check.ts
import assert from 'node:assert';
import { makeDraft } from '../editor/store';
import type { ProjectDoc, Timeline, TimelineItem } from '../editor/types';
import type { AgentContext } from './context';
import { execLibraryTool } from './library-tools';
import { execEditItemTool } from './edit-item-tools';
import { execEffectTool } from './effect-tools';
import { FX_IDS, LUT_IDS } from '../gl/fx/effects';
import { TRANSITION_ORDER, ZOOM_SHAPE_ORDER } from '../editor/types';
import { TEMPLATES } from '../editor/initial';
import { SOUND_EFFECTS } from '../audio/soundLibrary';

const vid = (id: string, start: number, dur: number): TimelineItem => ({
  id,
  track: 'V1',
  startFrame: start,
  durationInFrames: dur,
  name: id,
  kind: 'video',
  src: '/media/uploads/testsrc-tc.mp4',
});

const tl: Timeline = {
  id: 'tl_test',
  name: 'test',
  order: 0,
  fps: 30,
  width: 1920,
  height: 1080,
  // two adjacent clips so transitions have a cut to straddle
  items: [vid('v_a', 0, 90), vid('v_b', 90, 90)],
  selectedId: null,
  trackOrder: ['V1', 'A1'],
  tracks: {
    V1: { kind: 'video', name: '视频 1' },
    A1: { kind: 'audio', name: '音频 1' },
  },
};

const base: ProjectDoc = {
  version: 2,
  assets: [],
  mediaFolders: [],
  timelines: [tl],
  activeTimelineId: 'tl_test',
};

function ctxOf(draft: ReturnType<typeof makeDraft>): AgentContext {
  return {
    commands: draft.commands,
    getState: draft.getState,
    getDoc: draft.getDoc,
    getCreativeMode: () => null,
    templates: TEMPLATES.slice(0, 20),
    audio: [],
  };
}

// ── 1. catalog sizes ───────────────────────────────────────────────────────
assert.ok(FX_IDS.length >= 20, `fx catalog too small: ${FX_IDS.length}`);
assert.ok(LUT_IDS.length >= 4, `lut catalog too small: ${LUT_IDS.length}`);
assert.ok(TRANSITION_ORDER.length >= 12, `video transitions too few: ${TRANSITION_ORDER.length}`);
assert.ok(ZOOM_SHAPE_ORDER.length >= 4, 'zoom shapes present');
console.log(`catalog: fx=${FX_IDS.length} lut=${LUT_IDS.length} tr=${TRANSITION_ORDER.length} zoom=${ZOOM_SHAPE_ORDER.length} sfx=${SOUND_EFFECTS.length} mg=${TEMPLATES.length}`);

// ── 2. browse_library modes ────────────────────────────────────────────────
{
  const d = makeDraft(base);
  const ctx = ctxOf(d);

  const root = await execLibraryTool('browse_library', {}, ctx) as { mode: string; categories: Record<string, number> };
  assert.strictEqual(root.mode, 'root');
  assert.ok(root.categories.fx >= 20, 'browse root lists fx');
  assert.ok(root.categories.transitions >= 12, `browse root transitions ≥12 builtin (got ${root.categories.transitions}; clone 扩展超集)`);
  assert.ok(root.categories.zoom >= 4, 'browse root zoom');
  assert.ok(root.categories.luts >= 4, 'browse root luts');

  const fxOv = await execLibraryTool('browse_library', { category: 'fx' }, ctx) as { mode: string; total: number };
  assert.strictEqual(fxOv.mode, 'overview');
  assert.ok(fxOv.total >= 20);

  const q = await execLibraryTool('browse_library', { category: 'fx', query: 'bloom' }, ctx) as {
    mode: string; results: { id: string; name: string }[];
  };
  assert.strictEqual(q.mode, 'list');
  assert.ok(q.results.some((r) => r.id.includes('bloom')), 'query finds bloom');

  // category-only returns overview; id mode returns usage guidance
  const zoomDetail = await execLibraryTool('browse_library', { id: 'library:zoom:punch' }, ctx) as {
    mode: string; item: { id: string; usage?: string };
  };
  assert.strictEqual(zoomDetail.mode, 'detail');
  assert.strictEqual(zoomDetail.item.id, 'library:zoom:punch');
  assert.ok(zoomDetail.item.usage?.includes('edit_item'), 'detail has usage guidance');

  const trDetail = await execLibraryTool('browse_library', { id: 'builtin:tr-cross-dissolve' }, ctx) as {
    item: { id: string };
  };
  assert.strictEqual(trDetail.item.id, 'builtin:tr-cross-dissolve');

  console.log('browse_library: OK');
}

// ── 3. edit_item effect + zoom ─────────────────────────────────────────────
{
  const d = makeDraft(base);
  const ctx = ctxOf(d);

  const r = await execEditItemTool('edit_item', {
    adds: [
      { type: 'effect', targetItemId: 'v_a', assetId: 'builtin:fx-bloom', propertyOverrides: { intensity: 1.2 } },
      { type: 'effect', targetItemId: 'v_a', assetId: 'library:zoom:punch' },
      { type: 'effect', targetItemId: 'v_b', assetId: 'builtin:look-teal-orange' },
    ],
  }, ctx) as { ok: boolean; results: { ok?: boolean; kind?: string }[] };

  assert.strictEqual(r.ok, true, `edit_item effects failed: ${JSON.stringify(r)}`);
  const a = ctx.getState().items.find((i) => i.id === 'v_a')!;
  assert.ok(a.effects?.some((e) => e.assetId === 'builtin:fx-bloom'), 'bloom applied');
  assert.strictEqual(a.zoom?.shape, 'punch', 'zoom punch applied');
  const b = ctx.getState().items.find((i) => i.id === 'v_b')!;
  assert.ok(b.effects?.some((e) => e.assetId === 'builtin:look-teal-orange'), 'lut look applied');
  console.log('edit_item effect+zoom+lut: OK');
}

// ── 4. edit_item transition ────────────────────────────────────────────────
{
  const d = makeDraft(base);
  const ctx = ctxOf(d);
  const r = await execEditItemTool('edit_item', {
    adds: [{ type: 'transition', assetId: 'builtin:tr-page-curl', incomingItemId: 'v_b', durationInFrames: 20 }],
  }, ctx) as { ok: boolean; results: { transition?: { type: string; durationInFrames: number } | null }[] };

  assert.strictEqual(r.ok, true, `transition failed: ${JSON.stringify(r)}`);
  const trs = ctx.getState().transitions ?? [];
  assert.strictEqual(trs.length, 1, 'one transition');
  assert.strictEqual(trs[0].type, 'page-curl');
  assert.strictEqual(trs[0].incomingItemId, 'v_b');
  assert.strictEqual(trs[0].outgoingItemId, 'v_a');
  assert.strictEqual(trs[0].durationInFrames, 20);
  console.log('edit_item transition: OK');
}

// ── 5. atomic batch — failure rolls back nothing ───────────────────────────
{
  const d = makeDraft(base);
  const ctx = ctxOf(d);
  const before = JSON.stringify(ctx.getState().items);
  const r = await execEditItemTool('edit_item', {
    adds: [
      { type: 'effect', targetItemId: 'v_a', assetId: 'builtin:fx-glitch' },
      { type: 'effect', targetItemId: 'v_a', assetId: 'builtin:fx-DOES-NOT-EXIST' },
    ],
  }, ctx) as { ok: boolean; aborted?: boolean; failed?: number };

  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.aborted, true);
  assert.ok((r.failed ?? 0) >= 1);
  assert.strictEqual(JSON.stringify(ctx.getState().items), before, 'atomic: no partial mutation');
  assert.ok(!(ctx.getState().items.find((i) => i.id === 'v_a')!.effects?.length), 'glitch not applied on abort');
  console.log('edit_item atomic abort: OK');
}

// ── 6. validateOnly dry-run ────────────────────────────────────────────────
{
  const d = makeDraft(base);
  const ctx = ctxOf(d);
  const r = await execEditItemTool('edit_item', {
    validateOnly: true,
    adds: [{ type: 'effect', targetItemId: 'v_a', assetId: 'builtin:fx-vignette' }],
  }, ctx) as { ok: boolean; validateOnly: boolean; wouldApply: number };

  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.validateOnly, true);
  assert.strictEqual(r.wouldApply, 1);
  assert.ok(!ctx.getState().items.find((i) => i.id === 'v_a')!.effects?.length, 'validateOnly no write');
  console.log('edit_item validateOnly: OK');
}

// ── 7. motion-graphic + sound ──────────────────────────────────────────────
{
  const d = makeDraft(base);
  const ctx = ctxOf(d);
  const tpl = TEMPLATES[0];
  assert.ok(tpl, 'need at least one template');

  const r = await execEditItemTool('edit_item', {
    adds: [
      { type: 'motion-graphic', assetId: `library:motion-graphic:${tpl.id}`, track: 'V1', startFrame: 200 },
      { type: 'audio', assetId: `library:sound:${SOUND_EFFECTS[0].id}`, fromFrame: 10 },
    ],
  }, ctx) as { ok: boolean; results: unknown[] };

  assert.strictEqual(r.ok, true, `mg/sfx failed: ${JSON.stringify(r)}`);
  const items = ctx.getState().items;
  assert.ok(items.some((i) => i.kind === 'motion-graphic' && i.templateId === tpl.id), 'MG placed');
  assert.ok(items.some((i) => i.kind === 'audio'), 'SFX placed');
  console.log('edit_item mg+sfx: OK');
}

// ── 8. manage_effects compat ───────────────────────────────────────────────
{
  const d = makeDraft(base);
  const ctx = ctxOf(d);
  const list = await execEffectTool('manage_effects', { action: 'list' }, ctx) as { effects: { assetId: string }[] };
  assert.ok(list.effects.length >= 20, 'manage_effects list has catalog');
  const add = await execEffectTool('manage_effects', {
    action: 'add',
    targetItemId: 'v_a',
    assetId: 'builtin:fx-rgb-split',
  }, ctx) as { ok: boolean };
  assert.strictEqual(add.ok, true);
  assert.ok(ctx.getState().items.find((i) => i.id === 'v_a')!.effects?.some((e) => e.assetId === 'builtin:fx-rgb-split'));
  console.log('manage_effects compat: OK');
}

// ── 9. transition replace same seam ────────────────────────────────────────
{
  const d = makeDraft(base);
  const ctx = ctxOf(d);
  await execEditItemTool('edit_item', {
    adds: [{ type: 'transition', assetId: 'builtin:tr-cross-dissolve', incomingItemId: 'v_b' }],
  }, ctx);
  await execEditItemTool('edit_item', {
    adds: [{ type: 'transition', assetId: 'builtin:tr-flash', incomingItemId: 'v_b', durationInFrames: 15 }],
  }, ctx);
  const trs = ctx.getState().transitions ?? [];
  assert.strictEqual(trs.length, 1, 'one in-transition per clip (replaced)');
  assert.strictEqual(trs[0].type, 'flash');
  assert.strictEqual(trs[0].durationInFrames, 15);
  console.log('transition replace: OK');
}

// ── 10. sample preview assets on disk ──────────────────────────────────────
{
  const { existsSync } = await import('node:fs');
  const { resolve } = await import('node:path');
  for (const f of ['sample-fx.jpg', 'sample-out.jpg', 'sample-in.jpg']) {
    const p = resolve('public/library-previews', f);
    assert.ok(existsSync(p), `missing preview asset ${f}`);
  }
  console.log('library-previews assets: OK');
}

// ── 11. extended zoom + effect update/delete ───────────────────────────────
{
  const d = makeDraft(base);
  const ctx = ctxOf(d);
  await execEditItemTool('edit_item', {
    adds: [
      { type: 'effect', targetItemId: 'v_a', assetId: 'library:zoom:zoom-out' },
      { type: 'effect', targetItemId: 'v_b', assetId: 'library:zoom:bounce', propertyOverrides: { magnification: 2 } },
      { type: 'effect', targetItemId: 'v_a', assetId: 'builtin:fx-film-grain' },
    ],
  }, ctx);
  assert.strictEqual(ctx.getState().items.find((i) => i.id === 'v_a')!.zoom?.shape, 'zoom-out');
  assert.strictEqual(ctx.getState().items.find((i) => i.id === 'v_b')!.zoom?.shape, 'bounce');
  assert.strictEqual(ctx.getState().items.find((i) => i.id === 'v_b')!.zoom?.magnification, 2);

  const eid = ctx.getState().items.find((i) => i.id === 'v_a')!.effects![0].id;
  await execEditItemTool('edit_item', {
    updates: [{ type: 'effect', id: eid, propertyOverrides: { amount: 0.4 } }],
  }, ctx);
  assert.strictEqual(
    (ctx.getState().items.find((i) => i.id === 'v_a')!.effects![0].overrides as { amount?: number }).amount,
    0.4,
  );

  await execEditItemTool('edit_item', { deletes: [{ type: 'effect', id: eid }] }, ctx);
  assert.strictEqual(ctx.getState().items.find((i) => i.id === 'v_a')!.effects?.length ?? 0, 0);

  await execEditItemTool('edit_item', {
    deletes: [{ type: 'effect', targetItemId: 'v_a', assetId: 'builtin:zoom' }],
  }, ctx);
  assert.ok(!ctx.getState().items.find((i) => i.id === 'v_a')!.zoom, 'zoom cleared');
  console.log('edit_item zoom variants + update/delete: OK');
}

console.log('\nlibrary-edit-item.check: ALL PASSED');
