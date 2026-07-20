// Custom transition registry + reduce addTransition wiring. npx tsx src/gl/customTransitions.check.ts
import assert from 'node:assert/strict';
import { registerCustomTransition, getCustomTransition, customTransitionUniforms, __resetCustomTransitions } from './customTransitions';
import { reduce } from '../editor/reduce';
import type { TimelineItem, TimelineState } from '../editor/types';

// ── registry: register → get → default uniforms → reset ──────────────────────
__resetCustomTransitions();
assert.equal(getCustomTransition('custom:tr-nope'), undefined, 'unknown id → undefined');

const def = {
  id: 'custom:tr-swirl-ab12cd34',
  label: '漩涡转场',
  frag: '#version 300 es\nprecision highp float;\nuniform sampler2D u_outgoing;\nuniform sampler2D u_incoming;\nuniform float u_progress;\nin vec2 v_texCoord; out vec4 fragColor;\nvoid main(){ fragColor = mix(texture(u_outgoing,v_texCoord), texture(u_incoming,v_texCoord), u_progress); }',
  props: [{ key: 'swirl', label: '强度', default: 0.7, min: 0, max: 1, step: 0.01 }],
};
registerCustomTransition(def);
assert.deepEqual(getCustomTransition(def.id), def, 'registered def round-trips');
assert.deepEqual(customTransitionUniforms(def), { u_swirl: 0.7 }, 'default uniform map {u_<key>: default}');
assert.deepEqual(customTransitionUniforms({ ...def, props: [] }), {}, 'no props → empty uniforms');
__resetCustomTransitions();
assert.equal(getCustomTransition(def.id), undefined, 'reset clears the registry');

// ── reduce addTransition: custom fields land on the TransitionItem ────────────
const base: TimelineState = {
  fps: 30, width: 1920, height: 1080, selectedId: null,
  items: [
    { id: 'a', track: 'V1', startFrame: 0, durationInFrames: 60, kind: 'video', name: 'a', src: '/a.mp4' },
    { id: 'b', track: 'V1', startFrame: 60, durationInFrames: 60, kind: 'video', name: 'b', src: '/b.mp4' },
  ] as TimelineItem[],
};

const custom = reduce(base, { type: 'addTransition', id: 'tr1', incomingItemId: 'b', transType: 'custom-shader', durationInFrames: 20, custom: { frag: 'FRAG_SRC', uniforms: { u_swirl: 0.7 }, label: '漩涡转场' } });
const tr = custom.transitions![0]!;
assert.equal(tr.type, 'custom-shader');
assert.equal(tr.outgoingItemId, 'a', 'resolves adjacent prior clip as outgoing');
assert.equal(tr.incomingItemId, 'b');
assert.equal(tr.customFrag, 'FRAG_SRC', 'GLSL carried onto the item (persists + renders after reload)');
assert.deepEqual(tr.customUniforms, { u_swirl: 0.7 });
assert.equal(tr.customLabel, '漩涡转场');

// built-in transition → no custom fields
const builtin = reduce(base, { type: 'addTransition', id: 'tr2', incomingItemId: 'b', transType: 'cross-dissolve', durationInFrames: 20 });
const tr2 = builtin.transitions![0]!;
assert.equal(tr2.type, 'cross-dissolve');
assert.equal(tr2.customFrag, undefined, 'built-in carries no customFrag');

console.log('customTransitions.check: OK');
