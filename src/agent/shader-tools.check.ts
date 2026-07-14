// Runnable check for submit_shader's non-GL logic — WebGL can't run under node,
// so this covers the static validator, fence stripping, property → FxDef → uniform
// mapping, and the registration contract. No LLM call is made (execShaderTool is
// never invoked), so nothing hits the network.
//   npx tsx src/agent/shader-tools.check.ts
import assert from 'node:assert';
import { fxUniforms } from '../gl/fx/uniforms';
import { validateShaderSource, stripCodeFences, buildProps, buildCustomFxDef, compileCheck } from './shader-tools';

const VALID = `#version 300 es
precision highp float;
uniform sampler2D u_input;
uniform float u_amount;
in vec2 v_texCoord;
out vec4 fragColor;
void main() {
  vec4 c = texture(u_input, v_texCoord);
  fragColor = vec4(c.rgb * u_amount, c.a);
}`;

// ── static validator: minimal valid frag passes ──
assert.strictEqual(validateShaderSource(VALID), null, 'minimal valid frag accepted');

// ── static validator: rejections ──
assert.ok(validateShaderSource(''), 'empty rejected');
assert.ok(validateShaderSource('   \n  '), 'whitespace-only rejected');
assert.ok(validateShaderSource(VALID + '\n#include "x"'), '#include rejected');
assert.ok(
  validateShaderSource('#version 300 es\nprecision highp float;\nout vec4 fragColor;\nvoid main(){ fragColor = vec4(1.0); }'),
  'missing u_input reference rejected',
);
assert.ok(
  validateShaderSource('uniform sampler2D u_input; void main(){ texture(u_input, vec2(0.0)); }'),
  'missing color output rejected',
);
assert.ok(validateShaderSource(VALID + '\nuniform sampler2D u_extra;'), 'unknown sampler rejected');
assert.ok(validateShaderSource(VALID.repeat(2000)), 'over-length rejected');

// ── fence stripping ──
assert.strictEqual(stripCodeFences('```glsl\n' + VALID + '\n```'), VALID, 'strips ```glsl fences');
assert.strictEqual(stripCodeFences(VALID), VALID, 'no-fence passthrough');

// ── raw properties → FxProperty[] ──
const props = buildProps([
  { key: 'amount', label: '强度', default: 5, min: 0, max: 2 }, // default out of range → clamped in
  { key: 'bad key!', default: 1 },                              // invalid GLSL ident → filtered
  { key: 'amount', default: 0 },                                // duplicate key → dropped
  { key: 'speed' },                                             // bare → sane defaults
]);
assert.strictEqual(props.length, 2, 'invalid identifier + duplicate filtered');
assert.strictEqual(props[0].key, 'amount', 'first surviving prop is amount');
assert.strictEqual(props[0].max, 2, 'max preserved');
assert.strictEqual(props[0].default, 2, 'default clamped into [min,max]');
assert.strictEqual(props[1].key, 'speed', 'second surviving prop is speed');
assert.strictEqual(props[1].min, 0, 'bare prop default min 0');
assert.strictEqual(props[1].max, 1, 'bare prop default max 1');
assert.strictEqual(props[1].step, 0.01, 'bare prop default step 0.01');

// ── FxDef construction + render-uniform contract (fxUniforms is the real render path) ──
const def = buildCustomFxDef('My Cool Glow', VALID, [{ key: 'amount', default: 1, min: 0, max: 2 }]);
assert.ok(def.id.startsWith('custom:fx-'), 'custom id namespace');
assert.ok(def.id.includes('my-cool-glow'), 'id carries a slug of the name');
assert.strictEqual(def.frag, VALID, 'frag embedded verbatim');
assert.strictEqual(def.name, 'My Cool Glow', 'display name kept');
assert.deepStrictEqual(fxUniforms(def, { amount: 99 }), { u_amount: 2 }, 'props render as u_<key>, clamped to max');
assert.deepStrictEqual(fxUniforms(def), { u_amount: 1 }, 'default uniform value used when no override');

// unique ids across calls (two effects with the same name must not collide)
assert.notStrictEqual(buildCustomFxDef('same', VALID).id, buildCustomFxDef('same', VALID).id, 'ids are unique');

// ── compile-check degrades gracefully with no WebGL (node) ──
assert.strictEqual(compileCheck(VALID), null, 'compileCheck skips (returns null) when document is absent');

// ── registration contract ──
// registerCustomFx (effects.ts) does exactly `CUSTOM_FX[def.id] = def; ALL_FX[def.id] = def`.
// effects.ts can't be imported under tsx (it pulls .frag?raw), so we assert the contract
// that manage_effects relies on: the built id is a stable string key discoverable via `in`.
const registry: Record<string, typeof def> = {};
registry[def.id] = def;
assert.ok(def.id in registry, 'registered effect discoverable by id (manage_effects `assetId in FX_EFFECTS`)');
assert.strictEqual(registry[def.id].name, 'My Cool Glow', 'lookup returns the registered def');

console.log('shader-tools.check: ok');
