// 插件包校验 + def 映射 + zoom 包络求值。npx tsx src/plugins/validate.check.ts
import assert from 'node:assert/strict';
import { validatePack, validateItem } from './validate';
import { fxDefOf, lutDefOf, transitionDefOf } from './store';
import { PLUGIN_FORMAT, PLUGIN_LIMITS, pluginAssetId, type PluginPack } from './types';
import { sampleEnvelope, zoomAt } from '../editor/zoom';
import { reduce } from '../editor/reduce';
import type { TimelineItem, TimelineState } from '../editor/types';

const FX_FRAG = 'uniform sampler2D u_input;\nvoid main(){ /* … */ }';
const TR_FRAG = 'uniform sampler2D u_outgoing;\nuniform sampler2D u_incoming;\nuniform float u_progress;\nvoid main(){}';
const CUBE_2 = ['LUT_3D_SIZE 2', '0 0 0', '1 0 0', '0 1 0', '1 1 0', '0 0 1', '1 0 1', '0 1 1', '1 1 1'].join('\n');

const goodPack: PluginPack = {
  format: PLUGIN_FORMAT,
  id: 'demo-pack',
  name: '示例包',
  version: '1.0.0',
  author: 'tester',
  items: [
    { type: 'mg-template', id: 'title-card', name: '标题卡', width: 1920, height: 1080, code: 'const T = () => null;' },
    { type: 'transition', id: 'ink', name: '水墨', frag: TR_FRAG, props: [{ key: 'softness', label: '柔和', default: 0.3, min: 0, max: 1 }] },
    { type: 'fx', id: 'vhs', name: 'VHS', frag: FX_FRAG },
    { type: 'lut', id: 'moody', name: 'Moody', cube: CUBE_2 },
    { type: 'zoom', id: 'elastic', name: '弹力', envelope: [0, 0.6, 1.1, 1], magnification: 1.6 },
  ],
};

// ── 良性包全过 ────────────────────────────────────────────────────────────────
{
  const res = validatePack(goodPack);
  assert.ok(res.ok, `良性包应通过:${res.ok ? '' : res.errors.join('; ')}`);
}

// ── 恶意/坏包逐类拒绝 ────────────────────────────────────────────────────────
const rejects: Array<[string, unknown]> = [
  ['非对象', 'not-an-object'],
  ['错 format', { ...goodPack, format: 'evil@9' }],
  ['坏包 id', { ...goodPack, id: 'Bad_ID!' }],
  ['坏版本', { ...goodPack, version: 'v1' }],
  ['空 items', { ...goodPack, items: [] }],
  ['条目超限', { ...goodPack, items: Array.from({ length: PLUGIN_LIMITS.maxItems + 1 }, (_, i) => ({ type: 'zoom', id: `z-${i}`, name: 'z', envelope: [0, 1] })) }],
  ['条目 id 重复', { ...goodPack, items: [goodPack.items[4], goodPack.items[4]] }],
  ['未知 type', { ...goodPack, items: [{ type: 'malware', id: 'x', name: 'x' }] }],
  ['fx 缺 u_input', { ...goodPack, items: [{ type: 'fx', id: 'x', name: 'x', frag: 'void main(){}' }] }],
  ['fx frag 超限', { ...goodPack, items: [{ type: 'fx', id: 'x', name: 'x', frag: `uniform sampler2D u_input;${'/*x*/'.repeat(20000)}` }] }],
  ['转场缺 u_progress', { ...goodPack, items: [{ type: 'transition', id: 'x', name: 'x', frag: 'uniform sampler2D u_outgoing; uniform sampler2D u_incoming;' }] }],
  ['prop key 非法', { ...goodPack, items: [{ type: 'fx', id: 'x', name: 'x', frag: FX_FRAG, props: [{ key: 'bad key', label: 'x', default: 0, min: 0, max: 1 }] }] }],
  ['prop 超数量', { ...goodPack, items: [{ type: 'fx', id: 'x', name: 'x', frag: FX_FRAG, props: Array.from({ length: PLUGIN_LIMITS.maxProps + 1 }, (_, i) => ({ key: `k${i}`, label: 'x', default: 0, min: 0, max: 1 })) }] }],
  ['1D LUT', { ...goodPack, items: [{ type: 'lut', id: 'x', name: 'x', cube: 'LUT_1D_SIZE 2\n0 0 0\n1 1 1' }] }],
  ['坏 cube 数据', { ...goodPack, items: [{ type: 'lut', id: 'x', name: 'x', cube: 'LUT_3D_SIZE 2\n0 0' }] }],
  ['envelope 点太少', { ...goodPack, items: [{ type: 'zoom', id: 'x', name: 'x', envelope: [1] }] }],
  ['envelope 值越界', { ...goodPack, items: [{ type: 'zoom', id: 'x', name: 'x', envelope: [0, 99] }] }],
  ['zoom magnification 越界', { ...goodPack, items: [{ type: 'zoom', id: 'x', name: 'x', envelope: [0, 1], magnification: 99 }] }],
  ['mg code 缺失', { ...goodPack, items: [{ type: 'mg-template', id: 'x', name: 'x', code: '' }] }],
  ['thumb 非法 scheme', { ...goodPack, items: [{ type: 'zoom', id: 'x', name: 'x', envelope: [0, 1], thumb: 'javascript:alert(1)' }] }],
  ['thumb 超限', { ...goodPack, items: [{ type: 'zoom', id: 'x', name: 'x', envelope: [0, 1], thumb: `data:image/jpeg;base64,${'A'.repeat(PLUGIN_LIMITS.maxThumbBytes + 64)}` }] }],
];
{
  const withThumb = validatePack({ ...goodPack, items: [{ type: 'zoom', id: 'zx', name: 'x', envelope: [0, 1], thumb: 'data:image/jpeg;base64,AAAA' }, { type: 'fx', id: 'fy', name: 'y', frag: FX_FRAG, thumb: '/plugins/t.jpg' }] });
  assert.ok(withThumb.ok, `data/URL thumb 应通过:${withThumb.ok ? '' : withThumb.errors.join(';')}`);
}
for (const [label, bad] of rejects) {
  const res = validatePack(bad);
  assert.ok(!res.ok, `${label} 应被拒`);
}
assert.ok(validateItem({ type: 'fx', id: 'ok', name: 'ok', frag: FX_FRAG }).length === 0, 'validateItem 良性单条通过');
console.log(`validatePack: 良性通过 + ${rejects.length} 类坏包全拒 OK`);

// ── def 映射:资产 id 命名空间 + 形状 ─────────────────────────────────────────
{
  const fx = fxDefOf(goodPack, goodPack.items[2] as never);
  assert.equal(fx.id, 'plugin:demo-pack/vhs');
  assert.equal(fx.frag, FX_FRAG);
  const lut = lutDefOf(goodPack, goodPack.items[3] as never, '/media/uploads/demo-pack-moody.cube', 'LUTFRAG');
  assert.equal(lut.id, 'plugin:demo-pack/moody');
  assert.equal(lut.cube, '/media/uploads/demo-pack-moody.cube');
  assert.equal(lut.frag, 'LUTFRAG');
  assert.equal(lut.props[0].key, 'intensity');
  const tr = transitionDefOf(goodPack, goodPack.items[1] as never);
  assert.equal(tr.id, 'plugin:demo-pack/ink');
  assert.equal(tr.label, '水墨');
  assert.equal(pluginAssetId('a', 'b'), 'plugin:a/b');
  console.log('def 映射 OK');
}

// ── zoom 包络求值:线性采样 + 过冲 + 优先级 ──────────────────────────────────
{
  assert.equal(sampleEnvelope([0, 1], 0.5), 0.5, '两点线性中值');
  assert.equal(sampleEnvelope([0, 1, 0], 0.25), 0.5, '三点第一段中值');
  assert.equal(sampleEnvelope([0.4], 0.9), 0.4, '单点即常量');
  const z = { envelope: [0, 1], magnification: 2 };
  assert.equal(zoomAt(z, 0, 61).magnification, 1, '包络起点 = 无缩放');
  assert.equal(zoomAt(z, 60, 61).magnification, 2, '包络终点 = 满倍率');
  const over = zoomAt({ envelope: [0, 1.5], magnification: 2 }, 60, 61).magnification;
  assert.ok(Math.abs(over - 2.5) < 1e-9, `过冲包络放大到 2.5,实得 ${over}`);
  // shape 与 envelope 并存时 envelope 赢(插件曲线是显式选择)
  const both = zoomAt({ envelope: [1, 1], shape: 'zoom-out', magnification: 2 }, 0, 61).magnification;
  assert.equal(both, 2, 'envelope 覆盖 shape');
  console.log('zoom 包络 OK');
}

// ── reduce setEffects: defs 快照进 state.fxDefs,撤销链共享引用 ───────────────
{
  const base: TimelineState = {
    fps: 30, width: 1920, height: 1080, selectedId: null,
    items: [{ id: 'a', track: 'V1', startFrame: 0, durationInFrames: 60, kind: 'video', name: 'a', src: '/a.mp4' } as TimelineItem],
  };
  const def = { id: 'plugin:demo-pack/vhs', name: 'VHS', desc: 'x', frag: FX_FRAG, props: [] };
  const s1 = reduce(base, { type: 'setEffects', id: 'a', effects: [{ id: 'e1', assetId: def.id }], defs: [def] });
  assert.equal(s1.fxDefs?.[def.id]?.frag, FX_FRAG, 'def 进 state.fxDefs');
  assert.equal(s1.items[0].effects?.[0]?.assetId, def.id);
  const s2 = reduce(s1, { type: 'setEffects', id: 'a', effects: [] });
  assert.equal(s2.fxDefs?.[def.id]?.frag, FX_FRAG, '移除特效不清 defs(撤销/重挂安全)');
  assert.equal(s2.items[0].effects, undefined);
  console.log('reduce fxDefs OK');
}

// ── 导出为插件:候选采集(前缀/去重)+ 组包重排 id + 整包过校验 ────────────────
{
  const { fxCandidates, transitionCandidates, mgCandidates, buildExportPack } = await import('./export');
  const fx = fxCandidates([
    { id: 'custom:fx-a', name: '甲', desc: 'x', frag: FX_FRAG, props: [] },
    { id: 'plugin:other/b', name: '他人', desc: 'x', frag: FX_FRAG, props: [] },   // 不导他人内容
    { id: 'builtin:fx-invert', name: '内置', desc: 'x', frag: FX_FRAG, props: [] }, // 不导内置
    { id: 'custom:fx-a', name: '甲', desc: 'x', frag: FX_FRAG, props: [] },        // 去重
  ]);
  assert.equal(fx.length, 1, 'fx 候选只收 custom: 且去重');
  const trs = transitionCandidates(
    [{ id: 'custom:tr-x', label: '注册表转场', frag: TR_FRAG, props: [] }],
    [
      { id: 't1', type: 'custom-shader', durationInFrames: 30, outgoingItemId: 'a', incomingItemId: 'b', trackId: 'V1', customFrag: TR_FRAG, customLabel: '同frag' },
      { id: 't2', type: 'custom-shader', durationInFrames: 30, outgoingItemId: 'b', incomingItemId: 'c', trackId: 'V1', customFrag: TR_FRAG + '\n// v2', customUniforms: { u_soft: 0.3 }, customLabel: '时间线转场' },
      { id: 't3', type: 'cross-dissolve', durationInFrames: 30, outgoingItemId: 'c', incomingItemId: 'd', trackId: 'V1' },
    ],
  );
  assert.equal(trs.length, 2, '注册表 + 时间线孤儿 frag,同 frag 去重,内置转场不收');
  const mgs = mgCandidates([
    { id: 'm1', track: 'V1', startFrame: 0, durationInFrames: 60, name: '卡片', kind: 'motion-graphic', code: 'const A = () => null;' },
    { id: 'm2', track: 'V1', startFrame: 60, durationInFrames: 60, name: '卡片', kind: 'motion-graphic', code: 'const A = () => null;' },
    { id: 'v1', track: 'V1', startFrame: 120, durationInFrames: 60, name: '视频', kind: 'video', src: '/a.mp4' },
  ] as TimelineItem[]);
  assert.equal(mgs.length, 1, 'MG 按 code 去重,非 MG 不收');
  const built = buildExportPack({ id: 'my-pack', name: '我的包' }, [fx[0].item, trs[0].item, trs[1].item, mgs[0].item]);
  assert.ok(built.ok, `组包应过校验:${built.ok ? '' : built.errors.join(';')}`);
  if (built.ok) {
    assert.deepEqual(built.pack.items.map((i) => i.id), ['fx-1', 'tr-1', 'tr-2', 'mg-1'], 'id 按类型重排唯一');
    assert.equal(built.pack.version, '1.0.0');
  }
  const badId = buildExportPack({ id: 'Bad Id!', name: 'x' }, [fx[0].item]);
  assert.ok(!badId.ok, '坏包 id 被拒');
  console.log('export 组包 OK');
}

// ── propSchema 校验 + sha256Hex + 反注册(纯注册表侧) ─────────────────────────
{
  const mg = (extra: Record<string, unknown>) => ({ ...goodPack, items: [{ type: 'mg-template', id: 'mg-x', name: 'x', code: 'const T = () => null;', ...extra }] });
  assert.ok(validatePack(mg({ propSchema: [{ key: 'title', type: 'text', label: '标题' }] })).ok, '良性 propSchema 通过');
  assert.ok(!validatePack(mg({ propSchema: 'nope' })).ok, '非数组 propSchema 拒');
  assert.ok(!validatePack(mg({ propSchema: [{ key: 1, type: 'text' }] })).ok, 'key 非字符串拒');
  assert.ok(!validatePack(mg({ propSchema: Array.from({ length: 33 }, (_, i) => ({ key: `k${i}`, type: 'text' })) })).ok, '>32 项拒');

  const { sha256Hex, installFromText } = await import('./install');
  const hex = await sha256Hex('openchatcut');
  assert.match(hex, /^[0-9a-f]{64}$/, 'sha256Hex 输出 64 位小写 hex');
  assert.equal(hex, await sha256Hex('openchatcut'), '同文本稳定');
  const mismatch = await installFromText('{}', { sha256: 'f'.repeat(64) });
  assert.ok(!mismatch.ok && mismatch.errors[0].includes('SHA-256'), '哈希不匹配在解析前拒装');

  const { registerCustomTransition, getCustomTransition, unregisterCustomTransition, __resetCustomTransitions } = await import('../gl/customTransitions');
  registerCustomTransition({ id: 'plugin:p/t', label: 't', frag: TR_FRAG, props: [] });
  assert.ok(getCustomTransition('plugin:p/t'), '注册可见');
  assert.equal(unregisterCustomTransition('plugin:p/t'), true, '反注册返回 true');
  assert.equal(getCustomTransition('plugin:p/t'), undefined, '反注册后不可见');
  assert.equal(unregisterCustomTransition('plugin:p/t'), false, '重复反注册返回 false');
  __resetCustomTransitions();

  const { registerCustomZoom, getCustomZoom, unregisterCustomZoom, __resetCustomZooms } = await import('../editor/customZooms');
  registerCustomZoom({ id: 'plugin:p/z', label: 'z', envelope: [0, 1] });
  assert.ok(getCustomZoom('plugin:p/z'));
  assert.equal(unregisterCustomZoom('plugin:p/z'), true);
  assert.equal(getCustomZoom('plugin:p/z'), undefined, 'zoom 反注册后不可见');
  __resetCustomZooms();
  console.log('propSchema/sha256/反注册 OK');
}

console.log('\nplugins/validate.check: ALL PASSED');
