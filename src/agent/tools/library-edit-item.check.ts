// Runnable smoke test for browse_library + edit_item.
//   npx vite-node src/agent/library-edit-item.check.ts
import assert from 'node:assert';
import { makeDraft } from '../../editor/store';
import type { ProjectDoc, Timeline, TimelineItem } from '../../editor/types';
import type { AgentContext } from '../context';
import { execLibraryTool } from './library-tools';
import { execEditItemTool } from './edit-item-tools';
import { execEffectTool } from './effect-tools';
import { FX_IDS, LUT_IDS } from '../../gl/fx/effects';
import { TRANSITION_ORDER, ZOOM_SHAPE_ORDER } from '../../editor/types';
import { TEMPLATES } from '../../editor/initial';
import { SOUND_EFFECTS } from '../../audio/soundLibrary';

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
  trackOrder: ['V1', 'A1', 'A2'],
  tracks: {
    V1: { kind: 'video', name: '视频 1' },
    A1: { kind: 'audio', name: '音频 1' },
    A2: { kind: 'audio', name: '音频 2' },
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

  const trGroup = await execLibraryTool('browse_library', {
    category: 'transitions',
    group: 'transitions',
  }, ctx) as { mode: string; total: number; results: { id: string }[] };
  assert.strictEqual(trGroup.mode, 'list');
  assert.ok(trGroup.total >= 12, `transition group must not be empty (got ${trGroup.total})`);
  assert.ok(trGroup.results.some((item) => item.id === 'builtin:tr-cross-dissolve'));

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
  assert.strictEqual(r.results[0].transition?.type, 'page-curl', 'response contains the committed transition');
  assert.strictEqual(r.results[0].transition?.durationInFrames, 20, 'response contains transition duration');
  const trs = ctx.getState().transitions ?? [];
  assert.strictEqual(trs.length, 1, 'one transition');
  assert.strictEqual(trs[0].type, 'page-curl');
  assert.strictEqual(trs[0].incomingItemId, 'v_b');
  assert.strictEqual(trs[0].outgoingItemId, 'v_a');
  assert.strictEqual(trs[0].durationInFrames, 20);
  console.log('edit_item transition: OK');
}

// ── 4b. edit_item 引用 plugin: 转场 assetId(已装插件注册进 custom 注册表) ────
{
  const { registerCustomTransition, __resetCustomTransitions } = await import('../../gl/customTransitions');
  registerCustomTransition({
    id: 'plugin:demo/ink',
    label: '水墨',
    frag: 'uniform sampler2D u_outgoing; uniform sampler2D u_incoming; uniform float u_progress; void main(){}',
    props: [{ key: 'soft', label: '柔和', default: 0.3, min: 0, max: 1 }],
  });
  const d = makeDraft(base);
  const ctx = ctxOf(d);
  const r = await execEditItemTool('edit_item', {
    adds: [{ type: 'transition', assetId: 'plugin:demo/ink', incomingItemId: 'v_b' }],
  }, ctx) as { ok: boolean };
  assert.strictEqual(r.ok, true, `plugin transition failed: ${JSON.stringify(r)}`);
  const t = (ctx.getState().transitions ?? [])[0];
  assert.strictEqual(t.type, 'custom-shader');
  assert.ok(t.customFrag?.includes('u_progress'), 'frag 快照上 item');
  assert.strictEqual(t.customLabel, '水墨');
  assert.deepStrictEqual(t.customUniforms, { u_soft: 0.3 });
  // 未装/坏 id → 明确报错不落库
  const bad = await execEditItemTool('edit_item', {
    adds: [{ type: 'transition', assetId: 'plugin:ghost/nope', incomingItemId: 'v_b' }],
  }, ctxOf(makeDraft(base))) as { ok?: boolean; error?: string };
  assert.ok(!bad.ok, 'unknown plugin transition rejected');
  __resetCustomTransitions();
  console.log('edit_item plugin transition: OK');
}

// ── 4c. edit_item 缩放:插件曲线 assetId + raw envelope 入参 + shape/envelope 互斥 ──
{
  const { registerCustomZoom, __resetCustomZooms } = await import('../../editor/customZooms');
  registerCustomZoom({ id: 'plugin:demo/elastic', label: '弹力', envelope: [0, 1.1, 1], magnification: 1.6 });
  const d = makeDraft(base);
  const ctx = ctxOf(d);
  // 插件曲线直接引用(propertyOverrides.magnification 覆盖包内默认)
  let r = await execEditItemTool('edit_item', {
    adds: [{ type: 'effect', targetItemId: 'v_a', assetId: 'plugin:demo/elastic', propertyOverrides: { magnification: 2 } }],
  }, ctx) as { ok: boolean };
  assert.strictEqual(r.ok, true, `plugin zoom failed: ${JSON.stringify(r)}`);
  let z = ctx.getState().items.find((i) => i.id === 'v_a')?.zoom;
  assert.deepStrictEqual(z?.envelope, [0, 1.1, 1], '包络快照上 item');
  assert.strictEqual(z?.magnification, 2, 'overrides 覆盖倍率');
  assert.strictEqual(z?.label, '弹力');
  // agent 直接作曲线:builtin:zoom + envelope 入参(cleanOverrides 吞不掉)
  r = await execEditItemTool('edit_item', {
    adds: [{ type: 'effect', targetItemId: 'v_b', assetId: 'builtin:zoom', propertyOverrides: { envelope: [0, 0.4, 1, 0.9, 1], magnification: 1.8 } }],
  }, ctx) as { ok: boolean };
  assert.strictEqual(r.ok, true, `raw envelope failed: ${JSON.stringify(r)}`);
  z = ctx.getState().items.find((i) => i.id === 'v_b')?.zoom;
  assert.deepStrictEqual(z?.envelope, [0, 0.4, 1, 0.9, 1]);
  assert.strictEqual(z?.shape, undefined, 'envelope 入参不留 shape');
  // update 显式 shape → 曲线让位
  r = await execEditItemTool('edit_item', {
    updates: [{ type: 'effect', targetItemId: 'v_b', assetId: 'builtin:zoom', propertyOverrides: { shape: 'punch' } }],
  }, ctx) as { ok: boolean };
  assert.strictEqual(r.ok, true, `shape update failed: ${JSON.stringify(r)}`);
  z = ctx.getState().items.find((i) => i.id === 'v_b')?.zoom;
  assert.strictEqual(z?.shape, 'punch');
  assert.strictEqual(z?.envelope, undefined, '显式 shape 丢掉 envelope');
  // 越界包络被忽略(不带垃圾进 state)
  r = await execEditItemTool('edit_item', {
    adds: [{ type: 'effect', targetItemId: 'v_a', assetId: 'builtin:zoom', propertyOverrides: { envelope: [0, 99] } }],
  }, ctxOf(makeDraft(base))) as { ok: boolean };
  assert.strictEqual(r.ok, true);
  __resetCustomZooms();
  console.log('edit_item plugin/envelope zoom: OK');
}

// ── 4d. fx 注册/反注册(ALL_FX 原地写入/摘除;内置不可卸) ─────────────────────
{
  const { ALL_FX, registerCustomFx, unregisterCustomFx } = await import('../../gl/fx/effects');
  registerCustomFx({ id: 'plugin:p/f', name: 'f', desc: 'x', frag: 'uniform sampler2D u_input; void main(){}', props: [] });
  assert.ok('plugin:p/f' in ALL_FX, '注册进 ALL_FX');
  assert.strictEqual(unregisterCustomFx('plugin:p/f'), true);
  assert.ok(!('plugin:p/f' in ALL_FX), '反注册后 ALL_FX 摘除');
  assert.strictEqual(unregisterCustomFx('builtin:fx-invert'), false, '内置不可卸');
  assert.ok('builtin:fx-invert' in ALL_FX, '内置仍在');
  console.log('fx 注册/反注册: OK');
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
      { type: 'audio', assetId: `library:sound:${SOUND_EFFECTS[0].id}`, track: 'A2', fromFrame: 10 },
    ],
  }, ctx) as { ok: boolean; results: unknown[] };

  assert.strictEqual(r.ok, true, `mg/sfx failed: ${JSON.stringify(r)}`);
  const items = ctx.getState().items;
  assert.ok(items.some((i) => i.kind === 'motion-graphic' && i.templateId === tpl.id), 'MG placed');
  assert.ok(items.some((i) => i.kind === 'audio' && i.track === 'A2'), 'SFX placed on requested A2');

  const invalidDraft = makeDraft(base);
  const invalid = await execEditItemTool('edit_item', {
    adds: [
      { type: 'audio', assetId: `library:sound:${SOUND_EFFECTS[0].id}`, track: 'A9', fromFrame: 10 },
    ],
  }, ctxOf(invalidDraft)) as { ok: boolean; results?: { error?: string }[] };
  assert.strictEqual(invalid.ok, false, 'unknown requested SFX track must not fall back to A1');
  assert.match(invalid.results?.[0]?.error ?? '', /audio track "A9" not found/);
  assert.strictEqual(
    invalidDraft.getState().items.filter((item) => item.kind === 'audio').length,
    0,
    'invalid requested SFX track must not mutate the timeline',
  );
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
    const p = resolve('assets/library-previews', f);
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
