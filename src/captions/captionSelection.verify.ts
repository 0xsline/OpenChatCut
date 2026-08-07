import assert from 'node:assert/strict';
import { appendManualCue, newManualCaptions } from './manualCaptions';
import type { TimelineState } from '../editor/types';
import type { CaptionsData } from './types';

const modulePath = './captionSelection';
const {
  allCaptionSelections,
  captionSelectionKey,
  captionSelectionsInFrameRange,
  resolveCaptionSelection,
  resolveOrderedCaptionSelections,
} = await import(modulePath).catch(() => {
  assert.fail('caption selection must have a caption-owned identity and resolution layer');
});

let captions = newManualCaptions();
const laneId = captions.sourceEntries![0]!.id;
captions = { ...captions, ...appendManualCue(captions, laneId, 'First', 1_000, 2_000) };
captions = { ...captions, ...appendManualCue(captions, laneId, 'Second', 3_000, 4_000) };
const firstCueId = captions.sourceEntries![0]!.words![0]!.id!;
const secondCueId = captions.sourceEntries![0]!.words![1]!.id!;

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
assert.deepEqual(hits, [{ trackId: 'C1', kind: 'manual', laneId, cueId: firstCueId }]);
assert.equal(captionSelectionKey(hits[0]), `C1:manual:${laneId}:${firstCueId}`);
assert.equal(resolveCaptionSelection(state, hits[0])?.target.kind, 'manual');
assert.deepEqual(allCaptionSelections(state), [
  { trackId: 'C1', kind: 'manual', laneId, cueId: firstCueId },
  { trackId: 'C1', kind: 'manual', laneId, cueId: secondCueId },
], 'select-all should ignore locked caption tracks');

const mixedCaptions: CaptionsData = {
  enabled: true,
  template: 'plain',
  pacing: 'phrase',
  sourceEntries: [
    { id: 'auto-lane', itemId: 'source-a', trackOrder: 0 },
    {
      id: 'manual-late',
      itemId: 'manual:late',
      trackOrder: 1,
      words: [{ id: 'manual-late-cue', text: 'Manual late', start: 3_000, end: 3_500 }],
    },
    {
      id: 'manual-early',
      itemId: 'manual:early',
      trackOrder: 2,
      words: [{ id: 'manual-early-cue', text: 'Manual early', start: 500, end: 800 }],
    },
  ],
};
const sourceItem: TimelineState['items'][number] = {
  id: 'source-a',
  track: 'V1',
  startFrame: 0,
  durationInFrames: 120,
  kind: 'video',
  name: 'Source A',
  src: '/source-a.mp4',
  transcriptGenerationId: 'generation-a',
  transcript: [{ id: 'word-generated', text: 'Generated', start: 1_000, end: 1_500 }],
};
const mixedState: TimelineState = {
  fps: 30,
  width: 1080,
  height: 1920,
  items: [sourceItem],
  selectedId: null,
  trackOrder: ['C2', 'C1', 'V1'],
  tracks: {
    C1: { kind: 'caption', captions: mixedCaptions },
    C2: { kind: 'caption', captions: mixedCaptions },
    V1: { kind: 'video' },
  },
  captions: mixedCaptions,
};

const mixedHits = captionSelectionsInFrameRange('C1', mixedCaptions, [sourceItem], 30, 0, 120);
const generatedPageId = mixedHits.find((selection: { kind: string }) => selection.kind === 'single')!.pageId;
assert.deepEqual(mixedHits, [
  { trackId: 'C1', kind: 'manual', laneId: 'manual-early', cueId: 'manual-early-cue' },
  { trackId: 'C1', kind: 'single', pageId: generatedPageId },
  { trackId: 'C1', kind: 'manual', laneId: 'manual-late', cueId: 'manual-late-cue' },
], 'mixed automatic/manual range selection must preserve cue boundaries and canonical time order');

const duplicateMixedRefs = [
  { trackId: 'C1', kind: 'manual' as const, laneId: 'manual-early', cueId: 'manual-early-cue' },
  { trackId: 'C2', kind: 'manual' as const, laneId: 'manual-late', cueId: 'manual-late-cue' },
  { trackId: 'C2', kind: 'single' as const, pageId: generatedPageId },
  { trackId: 'C2', kind: 'single' as const, pageId: generatedPageId },
  { trackId: 'C1', kind: 'manual' as const, laneId: 'manual-late', cueId: 'manual-late-cue' },
  { trackId: 'C2', kind: 'manual' as const, laneId: 'manual-late', cueId: 'manual-late-cue' },
];
assert.deepEqual(
  resolveOrderedCaptionSelections(mixedState, duplicateMixedRefs).map(
    ({ selection }: { selection: unknown }) => selection,
  ),
  [
    { trackId: 'C2', kind: 'single', pageId: generatedPageId },
    { trackId: 'C2', kind: 'manual', laneId: 'manual-late', cueId: 'manual-late-cue' },
    { trackId: 'C1', kind: 'manual', laneId: 'manual-early', cueId: 'manual-early-cue' },
    { trackId: 'C1', kind: 'manual', laneId: 'manual-late', cueId: 'manual-late-cue' },
  ],
  'resolution must deduplicate refs and order each track by cue time in canonical track order',
);

console.log('captionSelection.verify: caption selection identity and range rules OK');
