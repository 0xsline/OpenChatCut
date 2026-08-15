import assert from 'node:assert/strict';
import {
  TRANSITION_DURATION_PRESETS,
  activeTransitionPreset,
  transitionPresetFrames,
} from './transitionDuration';

// Presets convert to frames at the timeline's own rate: the same menu entry means
// the same wall-clock duration on a 24, 25, 30 or 60 fps project.
assert.equal(transitionPresetFrames(0.5, 30), 15);
assert.equal(transitionPresetFrames(0.5, 24), 12);
assert.equal(transitionPresetFrames(1, 25), 25);
assert.equal(transitionPresetFrames(2, 60), 120);

// Rounding never yields a transition shorter than the store will keep. setTransition
// clamps to 2 frames, so a preset proposing 1 would be silently stored as 2 and the
// menu would then tick a different entry than the one just clicked.
assert.equal(transitionPresetFrames(0.2, 24), 5);
assert.equal(transitionPresetFrames(0.2, 5), 2, 'a slow timeline still reaches the store minimum');
assert.equal(transitionPresetFrames(0.001, 30), 2, 'never proposes below what the reducer keeps');
assert.equal(
  activeTransitionPreset(transitionPresetFrames(0.2, 5), 5),
  0.2,
  'a clamped preset still ticks itself rather than mislabelling',
);

// The menu ticks the preset that matches what is applied, so the current duration
// is readable without opening a numeric field.
assert.equal(activeTransitionPreset(15, 30), 0.5);
assert.equal(activeTransitionPreset(30, 30), 1);
assert.equal(activeTransitionPreset(12, 24), 0.5, 'matching follows the project rate');

// A duration set elsewhere (agent, dragged edge, imported project) ticks nothing
// rather than mislabelling itself as the nearest preset.
assert.equal(activeTransitionPreset(17, 30), null);
assert.equal(activeTransitionPreset(0, 30), null);

// Every preset round-trips, so no menu entry can ever look unselected right after
// being clicked.
for (const seconds of TRANSITION_DURATION_PRESETS) {
  for (const fps of [24, 25, 30, 50, 60]) {
    assert.equal(
      activeTransitionPreset(transitionPresetFrames(seconds, fps), fps),
      seconds,
      `preset ${seconds}s round-trips at ${fps} fps`,
    );
  }
}

console.log('transition-context-menu.verify OK');
