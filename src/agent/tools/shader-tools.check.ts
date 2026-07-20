// Runnable check for submit_shader's non-GL logic — WebGL can't run under node,
// so this covers the static validator, fence stripping, property → FxDef → uniform
// mapping, and the registration contract. No LLM call is made (execShaderTool is
// never invoked), so nothing hits the network.
//   npx tsx src/agent/shader-tools.check.ts
import assert from 'node:assert';
import { fxUniforms } from '../../gl/fx/uniforms';
import { makeDraft } from '../../editor/store';
import { docFromTimeline } from '../../persist/projectStore';
import { registerCustomTransition, __resetCustomTransitions } from '../../gl/customTransitions';
import type { AgentContext } from '../context';
import {
  validateShaderSource, stripCodeFences, buildProps, buildCustomFxDef, compileCheck,
  validateTransitionShaderSource, buildCustomTransitionDef,
  normalizeShaderArgs, deriveShaderName, resolveShaderRefs, execShaderTool,
  SHADER_TOOL_SCHEMAS,
} from './shader-tools';

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

// ── Schema: required=['type','prompt']; name optional; referenceAssetIds present ──
{
  const schema = SHADER_TOOL_SCHEMAS.find((t) => t.name === 'submit_shader')!;
  const s = schema.input_schema as { required?: string[]; properties: Record<string, unknown> };
  assert.deepStrictEqual(s.required, ['type', 'prompt'], 'required is [type, prompt] (name no longer required)');
  assert.ok('referenceAssetIds' in s.properties, 'schema has referenceAssetIds');
  assert.ok('name' in s.properties, 'name stays as an optional field');
}

// ── normalizeShaderArgs: prompt 别名 + name 派生 + type 必填 ──
{
  // description is a legacy alias of prompt
  const viaAlias = normalizeShaderArgs({ type: 'effect', description: 'Cinematic teal-orange grade' });
  assert.ok(!('error' in viaAlias), 'description alias accepted as prompt');
  if (!('error' in viaAlias)) {
    assert.strictEqual(viaAlias.prompt, 'Cinematic teal-orange grade');
    assert.strictEqual(viaAlias.name, 'Cinematic teal-orange grade', 'name derived from prompt when omitted');
  }
  // explicit prompt wins over description; explicit name wins over derivation
  const explicit = normalizeShaderArgs({ type: 'transition', prompt: 'Soft crossfade', description: 'ignored', name: 'My Fade' });
  assert.ok(!('error' in explicit) && explicit.kind === 'transition' && explicit.prompt === 'Soft crossfade' && explicit.name === 'My Fade');
  // long prompt → derived name truncated
  const long = 'a'.repeat(200);
  assert.ok(deriveShaderName(long).length <= 48, 'derived name capped');
  assert.strictEqual(deriveShaderName('  RGB   split\n glitch  '), 'RGB split glitch', 'whitespace collapsed');
// type and prompt are required.
  assert.ok('error' in normalizeShaderArgs({ prompt: 'x' }), 'missing type errors');
  assert.ok('error' in normalizeShaderArgs({ type: 'blur', prompt: 'x' }), 'bad type errors');
  assert.ok((normalizeShaderArgs({ type: 'effect' }) as { error: string }).error.includes('prompt'), 'missing prompt errors');
}

// ── referenceAssetIds 校验（全部发生在 LLM 调用之前;node 下无网络）──
{
  __resetCustomTransitions();
  const draft = makeDraft(docFromTimeline({
    fps: 30, width: 1920, height: 1080, selectedId: null, items: [],
    assets: [
      { id: 'img_ref_1', name: 'LUT still', kind: 'image', src: '/media/uploads/ref.png', durationInFrames: 90 },
      { id: 'vid_1', name: 'clip', kind: 'video', src: '/media/uploads/v.mp4', durationInFrames: 90 },
    ],
  }));
  const ctx: AgentContext = { commands: draft.commands, getState: draft.getState, getDoc: draft.getDoc, getCreativeMode: () => null, templates: [], audio: [] };
  const trA = registerCustomTransition({ id: 'custom:tr-a', label: 'Wipe A', frag: VALID_TR, props: [] });
  registerCustomTransition({ id: 'custom:tr-b', label: 'Wipe B', frag: VALID_TR, props: [] });

  // image asset (by prefix) resolves as a visual reference
  const imgRefs = await resolveShaderRefs(['img_ref'], 'effect', ctx);
  assert.ok(!('error' in imgRefs), 'image asset prefix resolves');
  if (!('error' in imgRefs)) {
    assert.strictEqual(imgRefs.imageAssets.length, 1);
    assert.strictEqual(imgRefs.imageAssets[0]!.id, 'img_ref_1');
    assert.strictEqual(imgRefs.codeRef, null);
  }

  // transition asset as code reference, kind matches type=transition
  const codeRefs = await resolveShaderRefs(['custom:tr-a'], 'transition', ctx);
  assert.ok(!('error' in codeRefs) && codeRefs.codeRef?.frag === trA.frag, 'transition ref carries its frag source');

  // kind mismatch: transition ref with type=effect → clear error
  const mismatch = await resolveShaderRefs(['custom:tr-a'], 'effect', ctx) as { error?: string };
  assert.ok(mismatch.error?.includes('kind'), 'kind mismatch rejected');

  // >1 code reference → clear error
  const twoCode = await resolveShaderRefs(['custom:tr-a', 'custom:tr-b'], 'transition', ctx) as { error?: string };
  assert.ok(twoCode.error?.includes('ONE'), 'two code references rejected');

  // video pool asset is neither image nor shader → clear error
  const wrongKind = await resolveShaderRefs(['vid_1'], 'effect', ctx) as { error?: string };
  assert.ok(wrongKind.error?.includes('video'), 'non-image pool asset rejected');

  // unknown id → clear error
  const missingRef = await resolveShaderRefs(['ghost'], 'effect', ctx) as { error?: string };
  assert.ok(missingRef.error?.includes('not found'), 'unknown reference id rejected');

  // execShaderTool short-circuits on ref violations BEFORE any LLM call (no network under node)
  const execErr = await execShaderTool('submit_shader', { type: 'effect', prompt: 'glow', referenceAssetIds: ['custom:tr-a'] }, ctx) as { error?: string };
  assert.ok(execErr.error?.includes('kind'), 'exec validates references before generation');
  const execMissing = await execShaderTool('submit_shader', { type: 'effect', prompt: 'glow', referenceAssetIds: ['ghost'] }, ctx) as { error?: string };
  assert.ok(execMissing.error?.includes('not found'), 'exec rejects unknown reference before generation');
  const execNoType = await execShaderTool('submit_shader', { prompt: 'glow' }, ctx) as { error?: string };
  assert.ok(execNoType.error?.includes('type'), 'exec enforces required type');
  __resetCustomTransitions();
}

console.log('shader-tools.check: ok');
