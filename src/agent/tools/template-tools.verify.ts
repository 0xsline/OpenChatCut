import assert from 'node:assert/strict';
import type { ProjectDoc, Timeline, TimelineItem } from '../../editor/types';
import type { ProjectTemplate } from '../../persist/templateStore';
import { TEMPLATE_TOOL_SCHEMAS, applyPlacement, copyTemplateAssets } from './template-tools';

const active: Timeline = {
  id: 'timeline_current',
  name: 'Current',
  order: 0,
  fps: 30,
  width: 1920,
  height: 1080,
  selectedId: null,
  items: [{
    id: 'existing', track: 'track_v1', startFrame: 0, durationInFrames: 50,
    name: 'Existing', kind: 'video', src: '/media/existing.mp4',
  }],
  trackOrder: ['track_v1', 'track_v2'],
  tracks: { track_v1: { kind: 'video' }, track_v2: { kind: 'video' } },
};

const templateItems: TimelineItem[] = [
  {
    id: 'title', track: 'tpl_v', startFrame: 10, durationInFrames: 20,
    name: 'Title', kind: 'video', src: '/media/title.mp4', playbackRate: 1,
    fadeInFrames: 5,
    keyframes: { scale: [{ frame: 19, value: 1.2 }] },
    zoom: {
      easeInFrames: 4,
      reframeCurve: {
        version: 1,
        timebase: 'effect-frame',
        coordinateSpace: 'composition-normalized',
        keyframes: [{ frame: 10, focalPointX: 0.5, focalPointY: 0.5, magnification: 1.5 }],
      },
    },
  },
  { id: 'card', track: 'tpl_v', startFrame: 35, durationInFrames: 5, name: 'Card', kind: 'motion-graphic' },
];

const templateTimeline: Timeline = {
  ...active,
  id: 'timeline_template',
  name: 'Template',
  items: templateItems,
  trackOrder: ['tpl_v'],
  tracks: { tpl_v: { kind: 'video' } },
  transitions: [{
    id: 'transition', type: 'cross-dissolve', durationInFrames: 6,
    outgoingItemId: 'title', incomingItemId: 'card', trackId: 'tpl_v',
  }],
};

const placed = applyPlacement(active, templateTimeline, templateItems, {
  startFrame: 100,
  durationInFrames: 60,
  targetTrackId: 'track_v2',
});
const title = placed.items.find((item) => item.name === 'Title');
const card = placed.items.find((item) => item.name === 'Card');
assert.deepEqual(
  title && { track: title.track, start: title.startFrame, duration: title.durationInFrames },
  { track: 'track_v2', start: 100, duration: 40 },
);
assert.deepEqual(
  card && { track: card.track, start: card.startFrame, duration: card.durationInFrames },
  { track: 'track_v2', start: 150, duration: 10 },
);
assert.equal(title?.playbackRate, 0.5);
assert.equal(title?.fadeInFrames, 10);
assert.equal(title?.keyframes?.scale?.[0]?.frame, 38);
assert.equal(title?.zoom?.easeInFrames, 8);
assert.equal(title?.zoom?.reframeCurve?.keyframes[0]?.frame, 20);
assert.equal(placed.transitions?.[0]?.durationInFrames, 10, 'scaled transitions must be clamped to adjacent clip lengths');
assert.equal(placed.transitions?.[0]?.trackId, 'track_v2');
assert.deepEqual(placed.trackOrder, ['track_v1', 'track_v2']);
assert.throws(
  () => applyPlacement(active, templateTimeline, templateItems, { targetTrackId: 'A1' }),
  /not found or has the wrong kind/,
);

const currentDoc: ProjectDoc = {
  version: 3,
  assets: [{ id: 'current_asset', name: 'Current', kind: 'image', src: '/media/current.png', durationInFrames: 1 }],
  mediaFolders: [],
  timelines: [active],
  activeTimelineId: active.id,
};
const template: ProjectTemplate = {
  id: 'template_1',
  name: 'Template',
  createdAt: 1,
  doc: {
    version: 3,
    assets: [{ id: 'template_asset', name: 'Backdrop', kind: 'image', src: '/media/backdrop.png', durationInFrames: 1 }],
    mediaFolders: [],
    timelines: [templateTimeline],
    activeTimelineId: templateTimeline.id,
  },
  assetIds: ['template_asset'],
};
const copied = copyTemplateAssets(currentDoc, template);
assert.equal(copied.doc.assets.length, 2);
assert.equal(copied.assets[0]?.templateAssetId, 'template_asset');
assert.notEqual(copied.assets[0]?.assetId, 'template_asset');
assert.equal(copied.doc.assets[1]?.id, copied.assets[0]?.assetId);
assert.equal(currentDoc.assets.length, 1);

const actionSchema = TEMPLATE_TOOL_SCHEMAS[0]?.input_schema.properties?.action as { enum?: string[] };
assert(actionSchema.enum?.includes('copy_assets'));

console.log('template tools check passed');
