// Runnable check for the per-clip effect uniform logic (mirrors source gn()):
//   npx tsx src/gl/fx/fx.check.ts
import assert from 'node:assert';
import { fxUniform, fxUniforms, type FxDef } from './uniforms';

const luma: FxDef = {
  id: 'builtin:fx-luma-key', name: '', desc: '', frag: '',
  props: [
    { key: 'intensity', label: '', default: 1, min: 0, max: 3 },
    { key: 'threshold', label: '', default: 0.03, min: 0, max: 0.2 },
  ],
};

// default fallback when no override / non-finite
assert.strictEqual(fxUniform(luma.props[0]), 1, 'missing override → default');
assert.strictEqual(fxUniform(luma.props[0], {}), 1, 'empty override → default');
assert.strictEqual(fxUniform(luma.props[0], { intensity: Number.NaN }), 1, 'NaN override → default');

// clamp to [min,max]
assert.strictEqual(fxUniform(luma.props[0], { intensity: 5 }), 3, 'clamp above max');
assert.strictEqual(fxUniform(luma.props[0], { intensity: -2 }), 0, 'clamp below min');
assert.strictEqual(fxUniform(luma.props[1], { threshold: 0.1 }), 0.1, 'in-range passes through');

// uniforms map keys to u_<key>, clamped
const u = fxUniforms(luma, { intensity: 2, threshold: 99 });
assert.deepStrictEqual(u, { u_intensity: 2, u_threshold: 0.2 }, 'u_<key> map + clamp');
assert.ok(!('intensity' in u), 'raw key not emitted, only u_-prefixed');

// explicit uniform override (rect-mask width→u_rect_width)
const rect: FxDef = {
  id: 'builtin:fx-rect-mask', name: '', desc: '', frag: '',
  props: [{ key: 'width', label: '', default: 0.5, min: 0, max: 1, uniform: 'u_rect_width' }],
};
assert.deepStrictEqual(fxUniforms(rect, { width: 0.8 }), { u_rect_width: 0.8 }, 'uniform override wins over u_<key>');

console.log('fx.check: OK');
