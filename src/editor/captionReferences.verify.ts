import assert from 'node:assert/strict';
import type { Timeline, TimelineState } from './types';
import { collectExportMediaPlan } from '../export/exportMediaPlan';
import { removeItemsWithGroups } from './linkGroups';
import { removeAssetFromTimeline } from './mediaAssetUsage';
import { applyOverwriteLaneAction } from './reducerOverwrite';
import { reduce } from './reducerTimeline';
import { resolveCaptionWords } from '../captions/resolve';

const staleEntries = Array.from({ length: 3 }, (_, index) => ({
  id: `stale-lane-${index}`,
  itemId: `removed-item-${index}`,
}));
const manualEntry = {
  id: 'manual-lane',
  itemId: 'manual:manual-lane',
  words: [{ text: '保留', start: 0, end: 500 }],
};
const captions = {
  enabled: true,
  sourceItemId: 'clip-to-remove',
  sources: ['clip-to-remove'],
  sourceEntries: [...staleEntries, manualEntry],
};
const state = {
  id: 'caption-reference-timeline',
  fps: 30,
  width: 640,
  height: 360,
  items: [{
    id: 'clip-to-remove',
    name: 'clip.mp4',
    kind: 'video',
    src: '/media/uploads/clip.mp4',
    track: 'V1',
    startFrame: 0,
    durationInFrames: 30,
  }],
  tracks: { C1: { kind: 'caption', captions } },
  captions,
  selectedId: 'clip-to-remove',
  selectedIds: ['clip-to-remove'],
} as unknown as TimelineState;

assert.ok(collectExportMediaPlan(state).issues.length >= 3, 'stale caption bindings must be visible to export preflight');

const afterRemove = removeItemsWithGroups(state, ['clip-to-remove']);
assert.equal(collectExportMediaPlan(afterRemove).issues.length, 0, 'removing clips must reconcile caption bindings');
assert.equal(afterRemove.captions?.sourceItemId, undefined);
assert.equal(afterRemove.captions?.sources, undefined);
assert.deepEqual(afterRemove.captions?.sourceEntries?.map((entry) => entry.itemId), ['manual:manual-lane']);
assert.deepEqual(afterRemove.tracks?.C1?.captions?.sourceEntries?.map((entry) => entry.itemId), ['manual:manual-lane']);

const afterClear = reduce(state, { type: 'clear' });
assert.equal(collectExportMediaPlan(afterClear).issues.length, 0, 'clearing a timeline must reconcile caption bindings');

const asset = { id: 'asset-to-remove', name: 'clip.mp4', kind: 'video', src: '/media/uploads/clip.mp4', durationInFrames: 30 } as const;
const timelineWithAsset: Timeline = {
  ...state,
  id: 'caption-reference-timeline-with-asset',
  name: 'Caption reference timeline',
  order: 0,
  items: [{ ...state.items[0]!, sourceAssetId: asset.id }],
};
const afterAssetRemoval = removeAssetFromTimeline(
  timelineWithAsset,
  asset,
  [asset],
);
assert.equal(collectExportMediaPlan(afterAssetRemoval).issues.length, 0, 'removing a pool asset must reconcile caption bindings');

const afterOverwriteRemoval = applyOverwriteLaneAction(
  timelineWithAsset,
  'V1',
  { type: 'remove', id: 'clip-to-remove' },
);
assert.ok(afterOverwriteRemoval, 'overwrite removal should produce a timeline');
assert.equal(
  collectExportMediaPlan(afterOverwriteRemoval!).issues.length,
  0,
  'overwrite removal must reconcile caption bindings',
);

const splitSourceCaptions = {
  enabled: true,
  template: 'plain' as const,
  pacing: 'phrase' as const,
  sourceItemId: 'voice-source',
};
const splitSourceState = {
  id: 'caption-split-timeline',
  fps: 30,
  width: 640,
  height: 360,
  items: [{
    id: 'voice-source',
    name: 'voice.wav',
    kind: 'audio',
    src: '/media/uploads/voice.wav',
    track: 'A1',
    startFrame: 0,
    durationInFrames: 60,
    transcript: [
      { text: 'left', start: 0, end: 500 },
      { text: 'right', start: 1_100, end: 1_500 },
    ],
  }],
  tracks: {
    A1: { kind: 'audio' },
    C1: {
      kind: 'caption',
      captions: {
        ...splitSourceCaptions,
        sourceItemId: undefined,
        sourceEntries: [{ id: 'voice-lane', itemId: 'voice-source' }],
        perSource: { 'voice-lane': { maxLines: 2 } },
      },
    },
  },
  captions: splitSourceCaptions,
  selectedId: null,
} as unknown as TimelineState;
const afterSplit = reduce(splitSourceState, {
  type: 'split', id: 'voice-source', atFrame: 30, newId: 'voice-right',
});
assert.deepEqual(afterSplit.captions?.sources, ['voice-source', 'voice-right']);
assert.deepEqual(
  resolveCaptionWords(afterSplit.captions!, afterSplit.items, afterSplit.fps).map((word) => word.text),
  ['left', 'right'],
  'single-source captions keep both transcript halves after a split',
);
const splitTrackCaptions = afterSplit.tracks?.C1?.captions;
assert.ok(splitTrackCaptions);
assert.deepEqual(splitTrackCaptions.sourceEntries?.map((entry) => entry.itemId),
  ['voice-source', 'voice-right']);
assert.deepEqual(splitTrackCaptions.perSource?.['voice-lane:split:voice-right'], { maxLines: 2 });
assert.deepEqual(
  resolveCaptionWords(splitTrackCaptions, afterSplit.items, afterSplit.fps).map((word) => word.text),
  ['left', 'right'],
  'multi-lane captions duplicate the automatic source binding for the right fragment',
);

console.log('caption references verify: removed and split-item bindings are reconciled');
