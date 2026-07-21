import assert from 'node:assert/strict';
import type { MediaAsset, Timeline, TimelineItem } from '../../editor/types';
import type { Tpl } from '../../types';
import { timelineToFcpxml } from '../../export/fcpxml';
import {
  motionGraphicRenderFilename,
  motionGraphicRenderKey,
} from '../../export/motionGraphicRefs';
import {
  buildMotionGraphicExportPlan,
  MG_VIDEO_TOOL_SCHEMAS,
  resolveMotionGraphicExportTargets,
  runMotionGraphicExportPlan,
} from './mg-video-tools';
import { GENERATE_TOOL_SCHEMAS } from './generate-tools';

const instance: TimelineItem = {
  id: 'item_title_1',
  track: 'V1',
  startFrame: 24,
  durationInFrames: 90,
  name: 'Edited title',
  kind: 'motion-graphic',
  templateId: 'asset_title',
  code: 'return null',
  props: { subtitle: 'World', title: 'Hello' },
  width: 1920,
  height: 1080,
};

const state: Timeline = {
  id: 'timeline_main',
  name: 'Main',
  order: 0,
  fps: 30,
  width: 1920,
  height: 1080,
  items: [instance],
  trackOrder: ['V1'],
  tracks: { V1: { kind: 'video' } },
  selectedId: null,
};

const asset: MediaAsset = {
  id: 'asset_title',
  name: 'Title asset',
  kind: 'motion-graphic',
  src: '',
  durationInFrames: 75,
  code: 'return null',
  props: { title: 'Default', subtitle: 'Subtitle' },
  width: 1920,
  height: 1080,
};

const template: Tpl = {
  id: 'template_card',
  name: 'Card template',
  category: 'Title',
  width: 1080,
  height: 1080,
  fps: 30,
  durationInFrames: 60,
  props: { body: 'Default card' },
  propSchema: [],
  thumb: null,
  code: 'return null',
};

const reorderedProps = { ...instance, props: { title: 'Hello', subtitle: 'World' } };
assert.equal(
  motionGraphicRenderKey(instance),
  motionGraphicRenderKey(reorderedProps),
  'render keys must be stable across property insertion order',
);
assert.notEqual(
  motionGraphicRenderKey(instance),
  motionGraphicRenderKey({ ...instance, props: { title: 'Changed', subtitle: 'World' } }),
  'property changes must produce a new render key',
);
assert.notEqual(
  motionGraphicRenderKey(instance),
  motionGraphicRenderKey({ ...instance, durationInFrames: instance.durationInFrames * 2 }),
  'duration changes must produce a new render key',
);
assert.equal(
  motionGraphicRenderFilename(instance),
  `mg-${motionGraphicRenderKey(instance)}.mov`,
);
assert.equal(
  motionGraphicRenderKey({ ...instance, props: undefined }),
  motionGraphicRenderKey({ ...instance, props: undefined }),
  'missing property overrides must use a deterministic render identity',
);

const preferred = resolveMotionGraphicExportTargets(
  state,
  { assetId: 'asset_title' },
  [asset],
  [template],
);
assert.equal(preferred.length, 1);
assert.equal(preferred[0].item.id, instance.id);
assert.equal(preferred[0].usesTimelineInstance, true);
assert.equal(preferred[0].assetName, asset.name);

const defaults = resolveMotionGraphicExportTargets(
  state,
  { assetId: 'asset_title', preferTimelineInstance: false },
  [asset],
  [template],
);
assert.equal(defaults.length, 1);
assert.equal(defaults[0].usesTimelineInstance, false);
assert.deepEqual(defaults[0].item.props, asset.props);
assert.equal(defaults[0].item.durationInFrames, asset.durationInFrames);

const templateDefaults = resolveMotionGraphicExportTargets(
  state,
  { assetId: 'template_card', preferTimelineInstance: false },
  [asset],
  [template],
);
assert.equal(templateDefaults[0].item.templateId, template.id);
assert.deepEqual(templateDefaults[0].item.props, template.props);

const exactItem = resolveMotionGraphicExportTargets(
  state,
  { itemId: instance.id, preferTimelineInstance: false },
  [asset],
  [template],
);
assert.equal(exactItem[0].item.id, instance.id, 'itemId always means the edited timeline instance');

const xmlPlan = buildMotionGraphicExportPlan(preferred, { filenameMode: 'xml' });
assert.equal(xmlPlan[0].filename, motionGraphicRenderFilename(instance));
const assetPlan = buildMotionGraphicExportPlan(preferred, { filenameMode: 'asset', name: 'Custom / title' });
assert.equal(assetPlan[0].filename, 'Custom _ title.mov');

const key = motionGraphicRenderKey(instance);
const xmlWithRender = timelineToFcpxml(state, { motionGraphicRenderKeys: [key] });
assert.match(xmlWithRender, new RegExp(`name="mg-${key}\\.mov"`));
assert.match(xmlWithRender, new RegExp(`src="file:\\./mg-${key}\\.mov"`));
assert.match(xmlWithRender, /<asset-clip ref="id-mg-/);
assert.doesNotMatch(xmlWithRender, /motion graphic placeholder/);

const xmlWithoutRender = timelineToFcpxml(state);
assert.match(xmlWithoutRender, /motion graphic placeholder/);
assert.doesNotMatch(xmlWithoutRender, new RegExp(`name="mg-${key}\\.mov"`));

const twoTargets = [
  ...preferred,
  { ...preferred[0], item: { ...preferred[0].item, id: 'item_title_2', props: { title: 'Second' } } },
];
const twoPlans = buildMotionGraphicExportPlan(twoTargets, { filenameMode: 'xml' });
const attempted: string[] = [];
const result = await runMotionGraphicExportPlan(state, twoPlans, async (_timeline, _item, filename) => {
  attempted.push(filename);
  if (attempted.length === 1) throw new Error('render failed');
});
assert.equal(result.exported.length, 1);
assert.equal(result.failed.length, 1);
assert.equal(result.failed[0].error, 'render failed');
assert.equal(attempted.length, 2, 'one failed render must not cancel the rest of the batch');

const proresSchema = MG_VIDEO_TOOL_SCHEMAS.find((tool) => tool.name === 'export_motion_graphic_prores');
assert.ok(proresSchema);
const proresProperties = proresSchema.input_schema.properties;
assert.ok(proresProperties);
assert.ok(proresProperties.filenameMode);
assert.ok(proresProperties.preferTimelineInstance);

const submitExportSchema = GENERATE_TOOL_SCHEMAS.find((tool) => tool.name === 'submit_export');
assert.ok(submitExportSchema);
const submitExportProperties = submitExportSchema.input_schema.properties;
assert.ok(submitExportProperties);
assert.ok(submitExportProperties.motionGraphicRenderKeys);

console.log('mg-export-params.check.ts: all assertions passed');
