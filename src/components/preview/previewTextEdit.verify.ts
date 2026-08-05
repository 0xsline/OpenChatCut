import assert from 'node:assert/strict';
import type { TimelineItem } from '../../editor/types';
import {
  bumpPreviewFontSize,
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
  props: { text: '你好', fontSize: 96, color: '#ff0000' },
} as TimelineItem;

const textFields = previewTextEditFields(textItem);
assert.ok(textFields, 'text clips expose color and font size');
assert.equal(textFields!.colorKey, 'color');
assert.equal(textFields!.fontSizeKey, 'fontSize');
assert.equal(textFields!.color, '#ff0000');
assert.equal(textFields!.fontSize, 96);

const mgItem = {
  ...base,
  kind: 'motion-graphic',
  props: { title: '叠字', textColor: '#00ff00', fontSize: 64 },
  code: 'const X = () => null;',
} as TimelineItem;
const mgFields = previewTextEditFields(mgItem);
assert.ok(mgFields, 'MG with textColor+fontSize is editable on canvas');
assert.equal(mgFields!.colorKey, 'textColor');
assert.equal(mgFields!.fontSizeKey, 'fontSize');
assert.equal(mgFields!.color, '#00ff00');

const bareMg = {
  ...base,
  kind: 'motion-graphic',
  props: { accent: 1 },
  code: 'const X = () => null;',
} as TimelineItem;
assert.equal(previewTextEditFields(bareMg), null, 'MG without text style props is not editable');

const video = { ...base, kind: 'video', src: 'x.mp4' } as TimelineItem;
assert.equal(previewTextEditFields(video), null);
assert.equal(isBakedVisualClip(video), true, 'video clips are treated as baked for the hint');
assert.equal(isBakedVisualClip(textItem), false);

const bumped = bumpPreviewFontSize(textFields!, 1);
assert.ok(bumped > textFields!.fontSize, 'A+ increases font size');
const shrunk = bumpPreviewFontSize(textFields!, -1);
assert.ok(shrunk < textFields!.fontSize, 'A- decreases font size');

console.log('previewTextEdit.verify.ts: ok');
