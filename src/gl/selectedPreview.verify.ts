import assert from 'node:assert/strict';
import {
  glPreviewFailureReason,
  glTransitionPresentation,
  selectEffectPreviewAdapter,
  selectTransitionPreviewAdapter,
} from './previewAdapter';
import { buildEffectShaderFrame, buildTransitionShaderFrame, GL_COLOR_PIPELINE, transitionProgress } from './shaderFrame';
import { disposeRuntimeSlot, ensureRuntimeSlot } from './runtimeSlot';
import type { FxDef } from './fx/uniforms';

const selectedPlayer = selectTransitionPreviewAdapter({
  mode: 'player', selected: true, type: 'page-curl', texturable: true, hasShader: true,
});
assert.deepEqual(selectedPlayer, { adapter: 'gl-transition', fidelity: 'exact', fallbackAdapter: 'css-transition' });
assert.deepEqual(selectTransitionPreviewAdapter({
  mode: 'render', selected: false, type: 'page-curl', texturable: true, hasShader: true,
}), selectedPlayer, 'selected Player and export must select the same GL adapter');
const unselectedPlayer = selectTransitionPreviewAdapter({
  mode: 'player', selected: false, type: 'page-curl', texturable: true, hasShader: true,
});
assert.deepEqual(unselectedPlayer, {
  adapter: 'css-transition', fidelity: 'approximate', fallbackAdapter: 'css-transition',
}, 'non-selected Player transitions retain the existing CSS adapter');
assert.deepEqual(selectTransitionPreviewAdapter({
  mode: 'player', selected: true, type: 'page-curl', texturable: false, hasShader: true,
}), { adapter: 'css-transition', fidelity: 'approximate', fallbackAdapter: 'css-transition', fallbackReason: 'unsupported-media' });
assert.deepEqual(selectTransitionPreviewAdapter({
  mode: 'player', selected: true, type: 'custom-shader', texturable: true, hasShader: false,
}), { adapter: 'css-transition', fidelity: 'approximate', fallbackAdapter: 'css-transition', fallbackReason: 'missing-shader' });
assert.deepEqual(glTransitionPresentation(false), { showFallback: true, showGl: false }, 'waiting/failure frames show only CSS fallback');
assert.deepEqual(glTransitionPresentation(true), { showFallback: false, showGl: true }, 'ready frames show only GL without fallback bleed');
assert.deepEqual(selectEffectPreviewAdapter({ declared: true, texturable: true }), {
  adapter: 'gl-effect', fidelity: 'exact',
});
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
