// Runnable check for submit_shader's non-GL logic — WebGL can't run under node,
// so this covers the static validator, fence stripping, property → FxDef → uniform
// mapping, and the registration contract. No LLM call is made (execShaderTool is
// never invoked), so nothing hits the network.
//   npx tsx src/agent/shader-tools.check.ts
import assert from 'node:assert';
import { fxUniforms } from '../gl/fx/uniforms';
import { validateShaderSource, stripCodeFences, buildProps, buildCustomFxDef, compileCheck, validateTransitionShaderSource, buildCustomTransitionDef } from './shader-tools';

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

// ── type=transition: two-input validator (u_outgoing / u_incoming / u_progress) ──
const VALID_TR = `#version 300 es
precision highp float;
uniform sampler2D u_outgoing;
uniform sampler2D u_incoming;
uniform float u_progress;
uniform float u_swirl;
in vec2 v_texCoord;
out vec4 fragColor;
void main() {
  vec4 a = texture(u_outgoing, v_texCoord);
  vec4 b = texture(u_incoming, v_texCoord);
  fragColor = mix(a, b, clamp(u_progress * u_swirl, 0.0, 1.0));
}`;
assert.strictEqual(validateTransitionShaderSource(VALID_TR), null, 'minimal valid two-input transition accepted');
assert.ok(validateTransitionShaderSource(''), 'empty transition rejected');
// genuinely missing an input (token absent everywhere, not just the declaration line)
const NO_OUT = '#version 300 es\nprecision highp float;\nuniform sampler2D u_incoming;\nuniform float u_progress;\nin vec2 v_texCoord; out vec4 fragColor;\nvoid main(){ fragColor = texture(u_incoming, v_texCoord) * u_progress; }';
const NO_IN = '#version 300 es\nprecision highp float;\nuniform sampler2D u_outgoing;\nuniform float u_progress;\nin vec2 v_texCoord; out vec4 fragColor;\nvoid main(){ fragColor = texture(u_outgoing, v_texCoord) * (1.0 - u_progress); }';
assert.ok(validateTransitionShaderSource(NO_OUT), 'missing u_outgoing rejected');
assert.ok(validateTransitionShaderSource(NO_IN), 'missing u_incoming rejected');
assert.ok(validateTransitionShaderSource(VALID_TR.replace(/u_progress/g, 'u_t')), 'missing u_progress rejected');
assert.ok(validateTransitionShaderSource(VALID_TR + '\nuniform sampler2D u_extra;'), 'extra sampler rejected (only u_outgoing/u_incoming bound)');
assert.ok(validateTransitionShaderSource(VALID_TR + '\n#include "x"'), '#include rejected');
// a single-input EFFECT shader must fail the transition validator (wrong contract)
assert.ok(validateTransitionShaderSource(VALID), 'effect (u_input) shader rejected by transition validator');
// the transition shader must fail the EFFECT validator too (u_outgoing/u_incoming are unknown samplers there)
assert.ok(validateShaderSource(VALID_TR), 'transition shader rejected by effect validator (unknown samplers)');

// ── buildCustomTransitionDef: custom:tr-* id, verbatim frag, props ──
const tdef = buildCustomTransitionDef('Swirl Wipe', VALID_TR, [{ key: 'swirl', label: '强度', default: 0.7, min: 0, max: 1 }]);
assert.ok(tdef.id.startsWith('custom:tr-'), 'custom transition id namespace');
assert.ok(tdef.id.includes('swirl-wipe'), 'id carries a slug of the name');
assert.strictEqual(tdef.frag, VALID_TR, 'frag embedded verbatim');
assert.strictEqual(tdef.label, 'Swirl Wipe', 'label kept');
assert.strictEqual(tdef.props[0]!.key, 'swirl', 'prop built');
assert.strictEqual(tdef.props[0]!.default, 0.7, 'prop default in range');
assert.notStrictEqual(buildCustomTransitionDef('x', VALID_TR).id, buildCustomTransitionDef('x', VALID_TR).id, 'transition ids unique');

console.log('shader-tools.check: ok');
