import assert from 'node:assert/strict';
import type { TimelineState } from '../editor/types';
import { appendManualCue, newManualCaptions } from './manualCaptions';
import { buildCues } from './captionCues';

const modulePath = './captionGroupMove';
const {
  clampTimelineSelectionDelta,
  moveTimelineSelectionByDelta,
  resolveCaptionDragSelection,
} = await import(modulePath).catch(() => {
  assert.fail('caption group movement must have a shared state transformation');
});

let captions = newManualCaptions();
const laneId = captions.sourceEntries![0]!.id;
captions = { ...captions, ...appendManualCue(captions, laneId, 'First', 1_000, 2_000) };
captions = { ...captions, ...appendManualCue(captions, laneId, 'Second', 3_000, 4_000) };
captions = { ...captions, ...appendManualCue(captions, laneId, 'Outside', 7_000, 8_000) };

const selections = [
  { trackId: 'C1', kind: 'manual' as const, laneId, cueIndex: 0 },
  { trackId: 'C1', kind: 'manual' as const, laneId, cueIndex: 1 },
];
const state: TimelineState = {
  fps: 30,
  width: 1080,
  height: 1920,
  items: [{ id: 'clip-a', track: 'V1', startFrame: 60, durationInFrames: 90, kind: 'video', name: 'Video', src: '/a.mp4' }],
  selectedId: 'clip-a',
  selectedIds: ['clip-a'],
  trackOrder: ['C1', 'V1'],
  tracks: { C1: { kind: 'caption', captions }, V1: { kind: 'video' } },
  captions,
};

assert.deepEqual(resolveCaptionDragSelection(selections[0], selections, ['clip-a']), {
  captionSelections: selections,
  itemIds: ['clip-a'],
});
assert.equal(clampTimelineSelectionDelta(state, ['clip-a'], selections, -90), -30);

const moved = moveTimelineSelectionByDelta(state, ['clip-a'], selections, 15);
assert.equal(moved.items[0]?.startFrame, 75);
assert.deepEqual(moved.captions?.sourceEntries?.[0]?.words?.map((word: { text: string; start: number; end: number }) => [
  word.text,
  word.start,
  word.end,
]), [
  ['First', 1_500, 2_500],
  ['Second', 3_500, 4_500],
  ['Outside', 7_000, 8_000],
], 'mixed clip/caption selections should move with one shared delta');

const linkedState: TimelineState = {
  ...state,
  items: [
    state.items[0]!,
    { id: 'clip-linked', track: 'V1', startFrame: 10, durationInFrames: 30, kind: 'video', name: 'Linked', src: '/linked.mp4' },
  ],
  linkGroups: [{
    id: 'link-a',
    itemIds: ['clip-a', 'clip-linked'],
    anchorItemId: 'clip-a',
    mode: 'linked',
  }],
};
const linkedClamped = moveTimelineSelectionByDelta(linkedState, ['clip-a'], selections, -30);
assert.deepEqual(linkedClamped.items.map((item: { startFrame: number }) => item.startFrame), [50, 0]);
assert.equal(
  linkedClamped.captions?.sourceEntries?.[0]?.words?.[0]?.start,
  667,
  'linked clips and captions must use the same clamped delta at frame zero',
);

const automaticCaptions = {
  enabled: true,
  template: 'plain' as const,
  pacing: 'phrase' as const,
  words: [
    { text: 'Auto', start: 1_000, end: 1_400 },
    { text: 'caption', start: 1_450, end: 2_000 },
  ],
};
const automaticState: TimelineState = {
  fps: 30,
  width: 1080,
  height: 1920,
  items: [],
  selectedId: null,
  trackOrder: ['C1'],
  tracks: { C1: { kind: 'caption', captions: automaticCaptions } },
  captions: automaticCaptions,
};
const movedAutomatic = moveTimelineSelectionByDelta(
  automaticState,
  [],
  [{ trackId: 'C1', kind: 'single', cueIndex: 0 }],
  15,
);
assert.deepEqual(buildCues(movedAutomatic.captions!, [], 30).map(({ start, end }) => [start, end]), [
  [1_500, 2_500],
], 'automatic caption timing offsets must affect rendered cue timing');

console.log('captionGroupMove.verify: unified caption selection movement OK');
