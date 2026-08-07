import assert from 'node:assert/strict';

const modulePath = './captionSelectionInteraction';
const { captionContextMenuIntent, shouldClearCaptionSelectionFromPointer, updateCaptionSelections } = await import(modulePath).catch(() => {
  assert.fail('caption selection interaction rules must be independent of React event handlers');
});

const first = { trackId: 'C1', kind: 'single' as const, pageId: 'page-one' };
const second = { trackId: 'C1', kind: 'single' as const, pageId: 'page-two' };
assert.deepEqual(updateCaptionSelections([], first, 'add'), [first]);
assert.deepEqual(updateCaptionSelections([first], second, 'add'), [first, second]);
assert.deepEqual(updateCaptionSelections([first, second], first, 'toggle'), [second]);
assert.equal(captionContextMenuIntent(true), 'ignore-after-toggle');
assert.equal(captionContextMenuIntent(false), 'open-menu');

assert.equal(shouldClearCaptionSelectionFromPointer({
  insideTimelineClip: false,
  insideTimelineBlank: true,
  insideTimelineHead: false,
  additive: false,
}), true);
assert.equal(shouldClearCaptionSelectionFromPointer({
  insideTimelineClip: false,
  insideTimelineBlank: true,
  insideTimelineHead: true,
  additive: false,
}), false);
assert.equal(shouldClearCaptionSelectionFromPointer({
  insideTimelineClip: false,
  insideTimelineBlank: true,
  insideTimelineHead: false,
  additive: true,
}), false);

console.log('captionSelectionInteraction.verify: caption pointer selection rules OK');
