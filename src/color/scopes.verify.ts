// Runnable check: `npx tsx src/color/scopes.verify.ts`.
// Verification: Oscilloscope statistics on synthetic RGBA patterns - grayscale (neutral/no dominant color), pure orange (main hue/warm bias),
// Overexposure (highlight overflow), teal-orange double cluster, segmented color cast with bluish shadows, and empty input.
import assert from 'node:assert/strict';
import { compareColorScopes } from '../agent/tools/color-scope-tools';
import { analyzeRgbaPixels, describeScopeStats } from './scopes';

const near = (a: number, b: number, eps: number): boolean => Math.abs(a - b) < eps;

/** Construct RGBA buffer: give [r,g,b](0..255) row by row, n pixels per color block. */
function rgba(blocks: Array<[r: number, g: number, b: number, n: number]>): Uint8Array {
  const total = blocks.reduce((a, [, , , n]) => a + n, 0);
  const out = new Uint8Array(total * 4);
  let at = 0;
  for (const [r, g, b, n] of blocks) {
    for (let i = 0; i < n; i++) {
      out[at] = r; out[at + 1] = g; out[at + 2] = b; out[at + 3] = 255;
      at += 4;
    }
  }
  return out;
}

// ── Grayscale gradient: black and white dots, no saturation, no main color, color shift ≈ 0 ──
{
  const blocks: Array<[number, number, number, number]> = [];
  for (let v = 0; v <= 255; v += 5) blocks.push([v, v, v, 40]);
  const s = analyzeRgbaPixels(rgba(blocks), 1);
  assert.ok(s.blackPoint < 0.03 && s.whitePoint > 0.97, '灰阶黑白点贴边');
  assert.ok(s.saturationMean < 0.01, '灰阶无饱和');
  assert.deepEqual(s.dominantHues, [], '灰阶无主色相');
  assert.ok(near(s.warmCool, 0, 1e-6) && near(s.greenMagenta, 0, 1e-6), '灰阶零色偏');
  assert.ok(describeScopeStats(s).some((line) => line.includes('near-neutral')), '判读提示中性');
}

// ── Pure orange picture: main hue orange, warm, high saturation ──
{
  const s = analyzeRgbaPixels(rgba([[255, 128, 0, 5000]]), 1);
  assert.equal(s.dominantHues[0], 'orange', '主色相 orange');
  assert.ok(s.warmCool > 0.5, '暖冷平衡明显偏暖');
  assert.ok(s.saturationMean > 0.9, '高饱和');
  assert.ok(near(s.hueHistogram.find((b) => b.label === 'orange')!.pct, 1, 1e-6), '直方图集中在 orange bin');
}

// ── Overexposure: 35% pure white → highlight bloom ratio ≈ 0.35, white point = 1 ──
{
  const s = analyzeRgbaPixels(rgba([[255, 255, 255, 3500], [120, 120, 120, 6500]]), 1);
  assert.ok(near(s.clippedHighlightsPct, 0.35, 0.01), `高光溢出≈35%(${s.clippedHighlightsPct})`);
  assert.ok(s.whitePoint > 0.99, '白点贴顶');
  assert.ok(s.clippedShadowsPct < 0.01, '暗部无溢出');
}

// ── teal-orange: Both main color clusters are recognized ──
{
  const s = analyzeRgbaPixels(rgba([[230, 140, 40, 4000], [20, 160, 180, 4000], [128, 128, 128, 2000]]), 1);
  assert.ok(s.dominantHues.includes('orange') && (s.dominantHues.includes('cyan') || s.dominantHues.includes('azure')),
    `teal-orange 双簇(${s.dominantHues.join(',')})`);
}

// ── Segmented color cast: dark parts are bluer, bright parts are warmer, and the segmented tilts should be different from each other ──
{
  const s = analyzeRgbaPixels(rgba([[20, 25, 60, 4000], [235, 210, 170, 4000]]), 1);
  assert.ok(s.tilt.shadows.warmCool < -0.05, `暗部偏蓝(${s.tilt.shadows.warmCool})`);
  assert.ok(s.tilt.highlights.warmCool > 0.05, `亮部偏暖(${s.tilt.highlights.warmCool})`);
}

// ── Empty input will not explode ──
{
  const s = analyzeRgbaPixels(new Uint8Array(0));
  assert.equal(s.sampledPixels, 0);
  assert.deepEqual(s.dominantHues, []);
}

// ── Reference shot comparison: signed difference + named knob suggestion after dead zone ──
{
  const target = analyzeRgbaPixels(rgba([[230, 135, 40, 5000]]), 1);
  const reference = analyzeRgbaPixels(rgba([[100, 100, 100, 5000]]), 1);
  const compared = compareColorScopes(target, reference);
  assert.ok(compared.targetMinusReference.meanLuma > 0, '目标比参考更亮时差值为正');
  assert.ok(compared.targetMinusReference.warmCool > 0, '目标比参考更暖时差值为正');
  assert.deepEqual(
    compared.suggestions.map((entry) => [entry.control, entry.direction]),
    [['brightness', 'decrease'], ['saturate', 'decrease'], ['temperature', 'cooler']],
  );
  assert.deepEqual(compareColorScopes(reference, reference).suggestions, [], '死区内不生成无意义建议');
}

console.log('scopes.verify: ok (灰阶/主色相/溢出/双簇/分段色偏/参考对比/空输入)');
