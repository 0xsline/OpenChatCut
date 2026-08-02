import assert from 'node:assert/strict';
import { appendManualCue, newManualCaptions } from './manualCaptions';
import { captionTemplatePatch } from './captionTemplatePatch';
import { captionPreviewTextColor, captionPreviewTextColorPatch, effectivePreset } from './renderStyles';
import {
  captionPreviewLayoutPatch,
  captionPreviewStylePatch,
  captionPreviewTextPatch,
  findCaptionPreviewTarget,
} from './captionPreviewTarget';

let captions = newManualCaptions();
const laneId = captions.sourceEntries![0]!.id;
captions = { ...captions, ...appendManualCue(captions, laneId, '画面里可编辑', 1_000, 2_000) };

const overriddenCaptions = {
  ...captions,
  styleOverride: { color: '#123456' },
  sourceEntries: captions.sourceEntries?.map((entry) => ({
    ...entry,
    style: { color: '#654321' },
  })),
};
const templatePatch = captionTemplatePatch(overriddenCaptions, 'tiktok');
assert.equal(templatePatch.template, 'tiktok', 'choosing a template writes the selected template');
assert.equal(templatePatch.styleOverride, undefined, 'choosing a template clears track-level style overrides');
assert.equal(templatePatch.sourceEntries?.[0]?.style, undefined, 'choosing a template clears lane-level style overrides');
assert.equal(templatePatch.sourceEntries?.[0]?.words?.[0]?.text, '画面里可编辑', 'template changes preserve caption content');

const karaokePreset = {
  ...effectivePreset(overriddenCaptions),
  color: '#ffffff',
  highlightColor: '#0a0a0a',
  wholeLine: false,
};
assert.equal(captionPreviewTextColor(karaokePreset), '#0a0a0a', 'preview controls expose the visible karaoke color');
assert.deepEqual(
  captionPreviewTextColorPatch(karaokePreset, '#ff0000'),
  { color: '#ff0000', highlightColor: '#ff0000' },
  'changing preview text color updates active and inactive karaoke words',
);
assert.equal(
  captionPreviewTextColor({ ...karaokePreset, wholeLine: true }),
  '#ffffff',
  'whole-line captions expose their normal text color',
);

const target = findCaptionPreviewTarget(captions, [], 30, 1_500);
assert.equal(target?.kind, 'manual', 'manual multi-lane captions expose a preview edit target');
assert.equal(target?.cue.text, '画面里可编辑');

const textPatch = captionPreviewTextPatch(captions, target!, '预览已改字');
assert.equal(textPatch?.sourceEntries?.[0]?.words?.[0]?.text, '预览已改字');

const stylePatch = captionPreviewStylePatch(captions, target!, { color: '#ff0000' });
assert.equal(stylePatch.sourceEntries?.[0]?.style?.color, '#ff0000');

const layoutPatch = captionPreviewLayoutPatch(captions, target!, {
  anchor: 'bottom-center', offsetXRatio: 0.1, offsetYRatio: 0.2,
});
assert.equal(layoutPatch.sourceEntries?.[0]?.offsetXRatio, 0.1);
assert.equal(layoutPatch.sourceEntries?.[0]?.offsetYRatio, 0.2);

const deletePatch = captionPreviewTextPatch(captions, target!, '');
assert.equal(deletePatch?.sourceEntries?.[0]?.words?.length, 0);

console.log('captionPreviewTarget.verify: ok');
