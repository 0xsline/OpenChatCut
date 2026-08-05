import assert from 'node:assert/strict';
import type { TimelineItem } from '../../editor/types';
import {
  bumpPreviewFontSize,
  canPreviewTextEdit,
  cyclePreviewAlign,
  cyclePreviewFontWeight,
  isBakedVisualClip,
  previewTextEditFields,
} from './previewTextEdit';

const base = {
  id: 'x',
  track: 'V1' as const,
  startFrame: 0,
  durationInFrames: 30,
  name: 'clip',
};

const textItem = {
  ...base,
  kind: 'text',
  props: { text: '你好', fontSize: 96, color: '#ff0000', fontWeight: 700, align: 'center' },
} as TimelineItem;

const textFields = previewTextEditFields(textItem);
assert.ok(textFields, 'text clips expose full edit fields');
assert.equal(textFields!.colorKey, 'color');
assert.equal(textFields!.fontSizeKey, 'fontSize');
assert.equal(textFields!.textKey, 'text');
assert.equal(textFields!.text, '你好');
assert.equal(textFields!.fontWeightKey, 'fontWeight');
assert.equal(textFields!.alignKey, 'align');
assert.equal(canPreviewTextEdit(textItem), true);

const mgItem = {
  ...base,
  kind: 'motion-graphic',
  props: { title: '叠字', textColor: '#00ff00', fontSize: 64 },
  code: 'const X = () => null;',
} as TimelineItem;
const mgFields = previewTextEditFields(mgItem);
assert.ok(mgFields, 'MG with textColor+fontSize+title is editable');
assert.equal(mgFields!.colorKey, 'textColor');
assert.equal(mgFields!.textKey, 'title');
assert.equal(mgFields!.text, '叠字');

const textOnlyMg = {
  ...base,
  kind: 'motion-graphic',
  props: { caption: '只有文案' },
  code: 'const X = () => null;',
} as TimelineItem;
const textOnlyFields = previewTextEditFields(textOnlyMg);
assert.ok(textOnlyFields, 'MG with only a text prop is still editable');
assert.equal(textOnlyFields!.textKey, 'caption');
assert.equal(textOnlyFields!.colorKey, null);
assert.equal(textOnlyFields!.fontSizeKey, null);

const bareMg = {
  ...base,
  kind: 'motion-graphic',
  props: { accent: 1 },
  code: 'const X = () => null;',
} as TimelineItem;
assert.equal(previewTextEditFields(bareMg), null, 'MG without text style props is not editable');

const video = { ...base, kind: 'video', src: 'x.mp4' } as TimelineItem;
assert.equal(previewTextEditFields(video), null);
assert.equal(isBakedVisualClip(video), true);
assert.equal(isBakedVisualClip(textItem), false);

assert.ok(bumpPreviewFontSize(textFields!, 1) > textFields!.fontSize);
assert.ok(bumpPreviewFontSize(textFields!, -1) < textFields!.fontSize);
assert.equal(cyclePreviewFontWeight(400), 700);
assert.equal(cyclePreviewFontWeight(700), 900);
assert.equal(cyclePreviewFontWeight(900), 400);
assert.equal(cyclePreviewAlign('left'), 'center');
assert.equal(cyclePreviewAlign('center'), 'right');
assert.equal(cyclePreviewAlign('right'), 'left');

console.log('previewTextEdit.verify.ts: ok');
