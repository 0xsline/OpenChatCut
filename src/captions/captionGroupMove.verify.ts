import assert from 'node:assert/strict';
import type { TimelineState } from '../editor/types';
import { appendManualCue, newManualCaptions } from './manualCaptions';
import { buildCues } from './captionCues';
import { resolveCaptionSelection } from './captionSelection';
import type { CaptionsData, CaptionSourceEntry } from './types';

const modulePath = './captionGroupMove';
const {
  captionDragMoveMode,
  clampTimelineSelectionDelta,
  moveTimelineSelectionByDelta,
  resolveCaptionDragSelection,
  selectionMovePreviewDeltaForCaption,
  selectionMovePreviewDeltaForItem,
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
const preview = { itemIds: ['clip-a'], captionSelections: selections, deltaFrames: 15 };
assert.equal(captionDragMoveMode(selections[0], { captionSelections: selections, itemIds: ['clip-a'] }), 'timeline-selection');
assert.equal(selectionMovePreviewDeltaForItem('clip-a', preview), 15);
assert.equal(selectionMovePreviewDeltaForCaption(selections[1], preview), 15);
assert.equal(selectionMovePreviewDeltaForItem('clip-a', null), 0, 'cancelled previews must clear clip offsets');
assert.equal(selectionMovePreviewDeltaForCaption(selections[1], null), 0, 'cancelled previews must clear cue offsets');
const soloManual = resolveCaptionDragSelection(selections[0], [selections[0]], []);
assert.equal(captionDragMoveMode(selections[0], soloManual), 'manual-cue', 'a single manual cue keeps vertical lane movement');
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

assert.equal(
  clampTimelineSelectionDelta(state, [], selections, 120),
  90,
  'manual caption groups must stop at the nearest unselected cue',
);
assert.equal(
  clampTimelineSelectionDelta(state, ['clip-a'], [selections[1]!], -120),
  -30,
  'mixed selections must stop a manual cue at the nearest unselected cue on the left',
);
const collisionClamped = moveTimelineSelectionByDelta(state, [], selections, 120);
assert.deepEqual(
  collisionClamped.captions?.sourceEntries?.[0]?.words?.map(
    (word: { text: string; start: number; end: number }) => [word.text, word.start, word.end],
  ),
  [
    ['First', 4_000, 5_000],
    ['Second', 6_000, 7_000],
    ['Outside', 7_000, 8_000],
  ],
  'group movement must preserve one shared delta without overlapping an unselected cue',
);

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

const linkedSourceCaptions: CaptionsData = {
  enabled: true,
  template: 'plain',
  pacing: 'phrase',
  sourceEntries: [
    {
      id: 'manual-a',
      itemId: 'manual:a',
      trackOrder: 0,
      words: [{ text: 'Manual A', start: 100, end: 200 }],
    },
    { id: 'automatic-linked', itemId: 'clip-linked', trackOrder: 1 },
    {
      id: 'manual-b',
      itemId: 'manual:b',
      trackOrder: 2,
      words: [{ text: 'Manual B', start: 2_000, end: 2_400 }],
    },
  ],
};
const linkedSourceState: TimelineState = {
  fps: 30,
  width: 1080,
  height: 1920,
  items: [
    { id: 'clip-seed', track: 'V1', startFrame: 60, durationInFrames: 60, kind: 'video', name: 'Seed', src: '/seed.mp4' },
    {
      id: 'clip-linked',
      track: 'V1',
      startFrame: 10,
      durationInFrames: 60,
      kind: 'video',
      name: 'Linked source',
      src: '/linked-source.mp4',
      transcript: [{ text: 'Linked automatic', start: 0, end: 400 }],
    },
  ],
  selectedId: 'clip-seed',
  selectedIds: ['clip-seed'],
  trackOrder: ['C1', 'V1'],
  tracks: { C1: { kind: 'caption', captions: linkedSourceCaptions }, V1: { kind: 'video' } },
  captions: linkedSourceCaptions,
  linkGroups: [{
    id: 'linked-source-group',
    itemIds: ['clip-seed', 'clip-linked'],
    anchorItemId: 'clip-seed',
    mode: 'linked',
  }],
};
const automaticSelection = { trackId: 'C1', kind: 'single' as const, cueIndex: 0 };
const linkedSourceMoved = moveTimelineSelectionByDelta(
  linkedSourceState,
  ['clip-seed'],
  [automaticSelection, automaticSelection],
  15,
);
assert.deepEqual(
  linkedSourceMoved.items.map((item: { startFrame: number }) => item.startFrame),
  [75, 25],
  'linked source clips must move once from the expanded seed selection',
);
assert.ok(
  Math.abs((resolveCaptionSelection(linkedSourceMoved, automaticSelection)?.target.cue.start ?? Number.NaN) - ((25 * 1_000) / 30)) < 1e-9,
  'an automatic cue sourced from an indirectly selected linked clip must move by the shared delta once',
);
assert.deepEqual(
  linkedSourceMoved.captions?.wordOverrides ?? {},
  {},
  'linked source movement must not also persist a timing offset',
);

const duplicateAutomaticMoved = moveTimelineSelectionByDelta(
  linkedSourceState,
  [],
  [automaticSelection, automaticSelection, automaticSelection],
  15,
);
assert.ok(
  Math.abs((resolveCaptionSelection(duplicateAutomaticMoved, automaticSelection)?.target.cue.start ?? Number.NaN) - ((25 * 1_000) / 30)) < 1e-9,
  'duplicate automatic refs must apply one timing delta',
);
assert.equal(
  duplicateAutomaticMoved.captions?.wordOverrides?.[1]?.timingOffsetMs,
  500,
  'automatic offsets must use the full mixed-lane override index exactly once',
);
assert.equal(
  duplicateAutomaticMoved.captions?.sourceEntries?.[0]?.words?.[0]?.start,
  100,
  'automatic movement must not alter a neighboring manual lane',
);

const duplicateManualMoved = moveTimelineSelectionByDelta(
  linkedSourceState,
  [],
  [
    { trackId: 'C1', kind: 'manual', laneId: 'manual-b', cueIndex: 0 },
    { trackId: 'C1', kind: 'manual', laneId: 'manual-a', cueIndex: 0 },
    { trackId: 'C1', kind: 'manual', laneId: 'manual-a', cueIndex: 0 },
    { trackId: 'C1', kind: 'manual', laneId: 'manual-b', cueIndex: 0 },
  ],
  15,
);
assert.deepEqual(
  duplicateManualMoved.captions?.sourceEntries
    ?.filter((entry: CaptionSourceEntry) => entry.words)
    .map((entry: CaptionSourceEntry) => [entry.id, entry.words?.[0]?.start]),
  [['manual-a', 600], ['manual-b', 2_500]],
  'manual refs across lanes must be resolved and moved once per canonical cue',
);

const frameBoundaryCaptions: CaptionsData = {
  enabled: true,
  template: 'plain',
  pacing: 'phrase',
  words: [{ text: 'One frame', start: 33, end: 66 }],
};
const frameBoundaryState: TimelineState = {
  fps: 30,
  width: 1080,
  height: 1920,
  items: [],
  selectedId: null,
  trackOrder: ['C1'],
  tracks: { C1: { kind: 'caption', captions: frameBoundaryCaptions } },
  captions: frameBoundaryCaptions,
};
assert.equal(
  clampTimelineSelectionDelta(frameBoundaryState, [], [automaticSelection], -1),
  -1,
  'frame-zero clamp must use the same millisecond rounding as the persisted delta',
);
const frameBoundaryMoved = moveTimelineSelectionByDelta(
  frameBoundaryState,
  [],
  [automaticSelection],
  -1,
);
assert.equal(
  resolveCaptionSelection(frameBoundaryMoved, automaticSelection)?.target.cue.start,
  0,
  'a 33ms automatic cue at 30fps must land exactly on frame zero',
);

console.log('captionGroupMove.verify: unified caption selection movement OK');
