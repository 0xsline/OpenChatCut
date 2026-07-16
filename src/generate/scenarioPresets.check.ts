// Runnable check for the 19 scenario presets + asset/1:1 fs mapping:
// `npx tsx src/generate/scenarioPresets.check.ts`.
import assert from 'node:assert';
import { readdirSync } from 'node:fs';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { presetInitialMessage, SCENARIO_PRESETS, scenarioPresetById } from './scenarioPresets';

// ── 19 条齐、id 唯一、字段非空、组计数与源站一致 ──
assert.strictEqual(SCENARIO_PRESETS.length, 19, '19 presets');
assert.strictEqual(new Set(SCENARIO_PRESETS.map((p) => p.id)).size, 19, 'ids unique');
assert.strictEqual(SCENARIO_PRESETS.filter((p) => p.group === 'video-gen').length, 14, '14 video-gen');
assert.strictEqual(SCENARIO_PRESETS.filter((p) => p.group === 'app-promo').length, 5, '5 app-promo');
for (const p of SCENARIO_PRESETS) {
  for (const key of ['id', 'name', 'nameZh', 'prompt', 'agentGuidance'] as const) {
    assert.ok(p[key].trim().length > 0, `${p.id} has non-empty ${key}`);
  }
  assert.ok(p.coverUrl.startsWith(`/scenario-presets/${p.id}-cover.`), `${p.id} coverUrl`);
  assert.ok(p.previewUrl.startsWith(`/scenario-presets/${p.id}-preview.`), `${p.id} previewUrl`);
}
// 源站唯一免 PRO 的是 Product Launch Ad;其余 18 条 Seedance 2.0 门控。
assert.deepStrictEqual(
  SCENARIO_PRESETS.filter((p) => !p.pro).map((p) => p.id),
  ['d4404826-a3cd-4f72-ac0c-9875c26ba07d'],
  'pro flags match source proFeatureKey',
);

// ── 占位符转换(presetInitialMessage 接线缝) ──
const storyboard = presetInitialMessage('4d157b2c-9261-4a32-bfd2-0a7c0d04a2fe');
assert.ok(storyboard.includes('(请补充: 10-15s)'), 'placeholder becomes Chinese hint');
const hero = presetInitialMessage('44ce7ebb-4b37-435f-acb1-9fba31e9fb3d');
assert.ok(hero.includes('(请补充: describe your character — e.g. sleek twin ponytails, pale skin, calm expression)'));
assert.ok(hero.includes('(请补充: please avoid uploading real people)'), 'multiple placeholders all converted');
for (const p of SCENARIO_PRESETS) {
  const msg = presetInitialMessage(p.id);
  assert.ok(msg.trim().length > 0, `${p.id} message non-empty`);
  assert.ok(!msg.includes('{{field:'), `${p.id} no leftover placeholder`);
  if (!p.prompt.includes('{{field:')) assert.strictEqual(msg, p.prompt, `${p.id} placeholder-free prompt passes through verbatim`);
}
assert.strictEqual(presetInitialMessage('nope'), '', 'unknown id yields empty message');
assert.strictEqual(scenarioPresetById('nope'), undefined);

// ── 资产 1:1 fs 校验:每条 cover/preview 都在 public/,且目录里没有多余文件 ──
const assetDir = fileURLToPath(new URL('../../public/scenario-presets/', import.meta.url));
const actual = readdirSync(assetDir).filter((f) => !f.startsWith('.')).sort();
const expected = SCENARIO_PRESETS.flatMap((p) => [basename(p.coverUrl), basename(p.previewUrl)]).sort();
assert.strictEqual(expected.length, 38, '19 covers + 19 previews');
assert.deepStrictEqual(actual, expected, 'public/scenario-presets/ maps 1:1 to preset asset urls');

console.log('scenarioPresets.check: ok (19 presets, 38 assets, placeholders convert)');
