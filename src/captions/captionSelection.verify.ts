import assert from 'node:assert/strict';
import { appendManualCue, newManualCaptions } from './manualCaptions';
import type { TimelineState } from '../editor/types';

const modulePath = './captionSelection';
const {
  allCaptionSelections,
  captionSelectionKey,
  captionSelectionsInFrameRange,
  resolveCaptionSelection,
} = await import(modulePath).catch(() => {
  assert.fail('caption selection must have a caption-owned identity and resolution layer');
});

let captions = newManualCaptions();
const laneId = captions.sourceEntries![0]!.id;
captions = { ...captions, ...appendManualCue(captions, laneId, 'First', 1_000, 2_000) };
captions = { ...captions, ...appendManualCue(captions, laneId, 'Second', 3_000, 4_000) };

const state: TimelineState = {
  fps: 30,
  width: 1080,
  height: 1920,
  items: [],
  selectedId: null,
  trackOrder: ['C1', 'C2'],
  tracks: {
    C1: { kind: 'caption', captions },
    C2: { kind: 'caption', captions, locked: true },
  },
  captions,
};

const hits = captionSelectionsInFrameRange('C1', captions, [], 30, 29, 61);
assert.deepEqual(hits, [{ trackId: 'C1', kind: 'manual', laneId, cueIndex: 0 }]);
assert.equal(captionSelectionKey(hits[0]), `C1:manual:${laneId}:0`);
assert.equal(resolveCaptionSelection(state, hits[0])?.target.kind, 'manual');
assert.deepEqual(allCaptionSelections(state), [
  { trackId: 'C1', kind: 'manual', laneId, cueIndex: 0 },
  { trackId: 'C1', kind: 'manual', laneId, cueIndex: 1 },
], 'select-all should ignore locked caption tracks');

console.log('captionSelection.verify: caption selection identity and range rules OK');
