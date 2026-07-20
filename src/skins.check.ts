// checks:皮肤注册表完整性 + 对比度门(impeccable colorize 纪律固化)。
// 改任何皮肤配色都要过这里:text/panel ≥ 7、textDim/panel ≥ 4.5、
// textMuted/panel ≥ 4.5、onAccent/accent ≥ 4.5(WCAG AA)。
// `npx tsx src/skins.check.ts`
import assert from 'node:assert/strict';
import { DEFAULT_SKIN, SKINS, buildSkinsCss } from './skins';

function luminance(hex: string): number {
  const f = (c: number): number => {
    const x = c / 255;
    return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(parseInt(hex.slice(1, 3), 16))
    + 0.7152 * f(parseInt(hex.slice(3, 5), 16))
    + 0.0722 * f(parseInt(hex.slice(5, 7), 16));
}

function contrast(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

// ── 注册表完整性 ──
assert.ok(SKINS.length >= 2, '至少默认 + 1 套');
assert.equal(new Set(SKINS.map((s) => s.id)).size, SKINS.length, '皮肤 id 唯一');
assert.ok(SKINS.some((s) => s.id === DEFAULT_SKIN), '默认皮肤必须在注册表里');
for (const s of SKINS) {
  assert.ok(/^[a-z]+$/.test(s.id), `${s.id}: id 小写字母`);
  assert.ok(s.nameZh.trim().length > 0, `${s.id}: 有中文名`);
  assert.match(s.tokens.accentRgb, /^\d{1,3},\d{1,3},\d{1,3}$/, `${s.id}: accentRgb 三元组`);
  assert.match(s.tokens.inkRgb, /^\d{1,3},\d{1,3},\d{1,3}$/, `${s.id}: inkRgb 三元组`);
  for (const [name, value] of Object.entries(s.tokens)) {
    if (name === 'accentRgb' || name === 'inkRgb' || name === 'colorScheme') continue;
    assert.match(value, /^#[0-9a-f]{6}$/, `${s.id}.${name}: 6 位小写 hex(得进对比度计算)`);
  }
}

// ── 对比度门(AA) ──
for (const s of SKINS) {
  const t = s.tokens;
  const gate = (label: string, ratio: number, min: number): void =>
    assert.ok(ratio >= min, `${s.id}: ${label} = ${ratio.toFixed(2)} < ${min}`);
  gate('text/panel', contrast(t.text, t.panel), 7);
  gate('text/panelAlt', contrast(t.text, t.panelAlt), 4.5);
  gate('textMuted/panel', contrast(t.textMuted, t.panel), 4.5);
  gate('textDim/panel', contrast(t.textDim, t.panel), 4.4);
  // onAccent 按 WCAG 组件/大字级(≥3):石墨白字压 coral=3.27。
  // (身份保留);粉彩皮肤(摩卡/北极/东京夜/拿铁)用深字,实际 ≥4.5。
  gate('onAccent/accent', contrast(t.onAccent, t.accent), 3);
  gate('textStrong/hover', contrast(t.textStrong, t.hover), 4.5);
}

// ── CSS 生成:默认皮肤进 :root,其余各有覆盖块,body 跟随 ──
const css = buildSkinsCss();
assert.ok(css.includes(':root {'), ':root 块');
for (const s of SKINS) {
  if (s.id === DEFAULT_SKIN) continue;
  assert.ok(css.includes(`html[data-cc-skin='${s.id}']`), `${s.id} 覆盖块`);
}
assert.ok(css.includes('--cc-on-accent:'), 'on-accent 变量输出');
assert.ok(css.includes('body { background: var(--cc-bg)'), 'body 跟随皮肤');

console.log(`skins.check: ok (${SKINS.length} skins, 对比度门全过)`);
