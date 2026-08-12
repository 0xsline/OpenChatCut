import assert from 'node:assert/strict';
import type { Timeline, TimelineState } from './types';
import { collectExportMediaPlan } from '../export/exportMediaPlan';
import { removeItemsWithGroups } from './linkGroups';
import { removeAssetFromTimeline } from './mediaAssetUsage';
import { reduce } from './reducerTimeline';

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

console.log('caption references verify: removed-item bindings are reconciled');
