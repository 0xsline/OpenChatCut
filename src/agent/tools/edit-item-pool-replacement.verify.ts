import assert from 'node:assert/strict';
import { docFromTimeline } from '../../persist/projectStore';
import type { MediaAsset, TimelineItem } from '../../editor/types';
import {
  replaceTimelineItemAsset,
  validatePoolAssetReplacement,
} from './edit-item-pool-replacement';

const doc = docFromTimeline({
  fps: 30,
  width: 1920,
  height: 1080,
  selectedId: null,
  trackOrder: ['V1'],
  tracks: { V1: { kind: 'video' } },
  items: [{
    id: 'clip',
    track: 'V1',
    startFrame: 45,
    durationInFrames: 90,
    srcInFrame: 12,
    name: 'old',
    kind: 'video',
    src: '/media/old.mp4',
    sourceAssetId: 'old',
    transcript: [{ text: 'old', start: 0, end: 1_000 }],
    transform: { scale: 1.25 },
    filters: { blur: 2 },
    volume: 0.6,
    fadeInFrames: 3,
  }],
});
const replacement = {
  id: 'new',
  name: 'new.mp4',
  kind: 'video',
  src: '/media/new.mp4',
  durationInFrames: 300,
  sourceFilename: 'new.mp4',
} as MediaAsset;
doc.assets.push(replacement);

const plan = validatePoolAssetReplacement(doc.timelines[0]!, doc.assets, {
  type: 'video',
  itemId: 'clip',
  assetId: 'new',
  sourceStartFrame: 30,
  sourceDurationInFrames: 120,
});
assert.equal(plan.ok, true);
assert.equal(plan.plan, 'replacePoolAsset');

const next = replaceTimelineItemAsset(doc, doc.activeTimelineId, 'clip', replacement, {
  durationInFrames: Number(plan.durationInFrames),
  srcInFrame: Number(plan.srcInFrame),
});
const item = next.timelines[0]!.items[0] as TimelineItem;
assert.deepEqual(
  {
    id: item.id,
    track: item.track,
    startFrame: item.startFrame,
    durationInFrames: item.durationInFrames,
    srcInFrame: item.srcInFrame,
    sourceAssetId: item.sourceAssetId,
    src: item.src,
  },
  {
    id: 'clip',
    track: doc.timelines[0]!.items[0]!.track,
    startFrame: 45,
    durationInFrames: 120,
    srcInFrame: 30,
    sourceAssetId: 'new',
    src: '/media/new.mp4',
  },
  'replacement changes source identity while preserving the timeline slot',
);
assert.deepEqual(item.transform, { scale: 1.25 });
assert.deepEqual(item.filters, { blur: 2 });
assert.equal(item.volume, 0.6);
assert.equal(item.fadeInFrames, 3);
assert.equal(item.transcript, undefined, 'old source transcript identity is cleared');

const incompatible = validatePoolAssetReplacement(doc.timelines[0]!, [{
  id: 'audio', name: 'audio', kind: 'audio', src: '/media/audio.mp3', durationInFrames: 300,
} as MediaAsset], { type: 'video', itemId: 'clip', assetId: 'audio' });
assert.match(String(incompatible.error), /incompatible/);

console.log('edit-item-pool-replacement.verify: all assertions passed');
