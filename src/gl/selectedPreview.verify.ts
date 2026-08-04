import assert from 'node:assert/strict';
import {
  glPreviewFailureReason,
  glTransitionPresentation,
  selectEffectPreviewAdapter,
  selectTransitionPreviewAdapter,
  staticEffectPreviewStatus,
  staticPreviewFallbackStatus,
} from './previewAdapter';
import { buildEffectShaderFrame, buildTransitionShaderFrame, GL_COLOR_PIPELINE, transitionProgress } from './shaderFrame';
import { disposeRuntimeSlot, ensureRuntimeSlot } from './runtimeSlot';
import type { FxDef } from './fx/uniforms';

const selectedPlayer = selectTransitionPreviewAdapter({
  mode: 'player', selected: true, type: 'page-curl', texturable: true, hasShader: true,
});
assert.deepEqual(selectedPlayer, { adapter: 'gl-transition', fidelity: 'exact', fallbackAdapter: 'css-transition' });
assert.equal(staticPreviewFallbackStatus({
  kind: 'transition',
  targetId: 'transition-exact',
  adapter: selectedPlayer.adapter,
  fallbackReason: selectedPlayer.fallbackReason,
}), null, 'an exact transition has no static status');
assert.deepEqual(selectTransitionPreviewAdapter({
  mode: 'render', selected: false, type: 'page-curl', texturable: true, hasShader: true,
}), selectedPlayer, 'selected Player and export must select the same GL adapter');
const unselectedPlayer = selectTransitionPreviewAdapter({
  mode: 'player', selected: false, type: 'page-curl', texturable: true, hasShader: true,
});
assert.deepEqual(unselectedPlayer, {
  adapter: 'css-transition', fidelity: 'approximate', fallbackAdapter: 'css-transition',
}, 'non-selected Player transitions retain the existing CSS adapter');
const unsupportedMediaPlayer = selectTransitionPreviewAdapter({
  mode: 'player', selected: true, type: 'page-curl', texturable: false, hasShader: true,
});
assert.deepEqual(unsupportedMediaPlayer, {
  adapter: 'css-transition', fidelity: 'approximate', fallbackAdapter: 'css-transition', fallbackReason: 'unsupported-media',
});
assert.deepEqual(staticPreviewFallbackStatus({
  kind: 'transition',
  targetId: 'transition-unsupported-media',
  adapter: unsupportedMediaPlayer.adapter,
  fallbackReason: unsupportedMediaPlayer.fallbackReason,
}), {
  kind: 'transition',
  targetId: 'transition-unsupported-media',
  adapter: 'css-transition',
  phase: 'fallback',
  fallbackReason: 'unsupported-media',
}, 'a declared fallback remains immediately reportable');
assert.deepEqual(selectTransitionPreviewAdapter({
  mode: 'player', selected: true, type: 'custom-shader', texturable: true, hasShader: false,
}), { adapter: 'css-transition', fidelity: 'approximate', fallbackAdapter: 'css-transition', fallbackReason: 'missing-shader' });
assert.deepEqual(glTransitionPresentation(false), { showFallback: true, showGl: false }, 'waiting/failure frames show only CSS fallback');
assert.deepEqual(glTransitionPresentation(true), { showFallback: false, showGl: true }, 'ready frames show only GL without fallback bleed');
const exactEffect = selectEffectPreviewAdapter({ declared: true, texturable: true });
assert.deepEqual(exactEffect, {
  adapter: 'gl-effect', fidelity: 'exact',
});
assert.equal(staticPreviewFallbackStatus({
  kind: 'effect',
  targetId: 'effect-exact',
  adapter: exactEffect.adapter,
  fallbackReason: exactEffect.fallbackReason,
}), null, 'an exact effect has no static status');

const registeredEffects = {
  'builtin:fx-a': {},
  'builtin:fx-b': {},
};
assert.equal(staticEffectPreviewStatus({
  targetId: 'effect-none',
  effects: [],
  registeredEffects,
  texturable: false,
}), null, 'a clip with no effects has no static effect status');
assert.equal(staticEffectPreviewStatus({
  targetId: 'effect-exact-stack',
  effects: [{ assetId: 'builtin:fx-a' }, { assetId: 'builtin:fx-b' }],
  registeredEffects,
  texturable: true,
}), null, 'a complete registered and texturable effect stack has no static status');
assert.deepEqual(staticEffectPreviewStatus({
  targetId: 'effect-missing-shader',
  effects: [{ assetId: 'builtin:fx-a' }, { assetId: 'custom:missing' }],
  registeredEffects,
  texturable: true,
}), {
  kind: 'effect',
  targetId: 'effect-missing-shader',
  adapter: 'source-fallback',
  phase: 'fallback',
  fallbackReason: 'missing-shader',
}, 'any unresolved effect shader produces a durable static fallback');
assert.deepEqual(staticEffectPreviewStatus({
  targetId: 'effect-unsupported-media',
  effects: [{ assetId: 'custom:missing' }],
  registeredEffects,
  texturable: false,
}), {
  kind: 'effect',
  targetId: 'effect-unsupported-media',
  adapter: 'source-fallback',
  phase: 'fallback',
  fallbackReason: 'unsupported-media',
}, 'unsupported media takes precedence over a missing shader');
assert.equal(glPreviewFailureReason(new Error('WebGL2 not available')), 'webgl-unavailable');
assert.equal(glPreviewFailureReason(new Error('WebGL context lost')), 'webgl-unavailable');
assert.equal(glPreviewFailureReason(new Error('fragment shader compile failed')), 'shader-error');

assert.equal(transitionProgress(0, 1), 1, 'a one-frame transition is the incoming endpoint');
assert.deepEqual([transitionProgress(0, 2), transitionProgress(1, 2)], [0, 1]);
const thirtyFrameProgress = Array.from({ length: 30 }, (_, frame) => transitionProgress(frame, 30));
assert.equal(thirtyFrameProgress[0], 0);
assert.equal(thirtyFrameProgress[29], 1);
for (let frame = 1; frame < thirtyFrameProgress.length; frame++) {
  assert.ok(thirtyFrameProgress[frame]! >= thirtyFrameProgress[frame - 1]!, 'transition progress must be monotonic');
}
assert.equal(transitionProgress(-1, 30), 0, 'progress clamps before the transition window');
assert.equal(transitionProgress(30, 30), 1, 'progress clamps after the transition window');
assert.equal(thirtyFrameProgress[29], 1, 'last transition frame matches the following ordinary incoming frame');

const transitionDefinition = {
  frag: 'transition-frag',
  uniforms: ({ time, aspect, direction }: { time: number; aspect: number; direction: 'left' | 'right' | 'up' | 'down' }) => ({
    u_seed: time * aspect,
    u_direction: direction === 'right' ? 1 : -1,
  }),
};
const comparableFrameInput = {
  sequenceFrame: 6,
  durationInFrames: 12,
  windowStartFrame: 90,
  fps: 30,
  width: 1920,
  height: 1080,
  direction: 'right' as const,
};
const playerFrame = buildTransitionShaderFrame(transitionDefinition, comparableFrameInput);
const exportFrame = buildTransitionShaderFrame(transitionDefinition, comparableFrameInput);
assert.deepEqual(playerFrame, exportFrame, 'Player and export must build byte-for-byte comparable frame parameters');
assert.equal(playerFrame.progress, 6 / 11);
assert.equal(playerFrame.time, 3.2);
assert.equal(playerFrame.aspect, 16 / 9);
assert.deepEqual(playerFrame.colorPipeline, GL_COLOR_PIPELINE);

const effectDefinition: FxDef = {
  id: 'verify:effect',
  name: 'Verify',
  desc: 'Verify',
  frag: 'effect-frag',
  props: [{ key: 'strength', label: 'Strength', default: 0.5, min: 0, max: 1 }],
};
const effectFrame = buildEffectShaderFrame([
  { def: effectDefinition, overrides: { strength: 4 } },
], 15, 30);
assert.equal(effectFrame.time, 0.5);
assert.equal(effectFrame.passes[0]?.uniforms?.u_strength, 1, 'shared builder clamps Inspector overrides');
assert.equal(effectFrame.passes[0]?.uniforms?.u_time, 0.5, 'shared builder uses seek-safe clip-local time');
assert.deepEqual(effectFrame.colorPipeline, GL_COLOR_PIPELINE);

let createCount = 0;
let disposeCount = 0;
const slot: { current: { dispose: () => void } | null } = { current: null };
const runtime = ensureRuntimeSlot(slot, () => {
  createCount += 1;
  return { dispose: () => { disposeCount += 1; } };
});
assert.equal(ensureRuntimeSlot(slot, () => { throw new Error('must reuse runtime'); }), runtime);
assert.equal(createCount, 1, 'parameter/frame updates reuse one context');
disposeRuntimeSlot(slot);
disposeRuntimeSlot(slot);
assert.equal(slot.current, null);
assert.equal(disposeCount, 1, 'selection cleanup disposes a context exactly once');

console.log('selectedPreview.verify: ok');
