import assert from 'node:assert/strict';
import { appendManualCue, newManualCaptions } from './manualCaptions';
import { mapCaptionStyle } from './styleMap';
import { captionTemplatePatch } from './captionTemplatePatch';
import { captionPreviewOutsideClickAction } from './captionPreviewToolbar';
import {
  captionBoxStyle,
  captionPreviewTextColor,
  captionPreviewTextColorPatch,
  containerStyle,
  effectivePreset,
  shadowBlurSize,
  wordStyle,
} from './renderStyles';
import {
  captionPreviewLayoutPatch,
  captionPreviewLayoutResetPatch,
  captionPreviewNudgePatch,
  captionPreviewStyleResetPatch,
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
assert.equal(shadowBlurSize('0 2px 5px #000, 0 3px 12px #0008'), 12, 'shadow controls read the dominant blur layer');
assert.equal(
  wordStyle({ ...karaokePreset, strokeColor: '#ff0000', strokeWidth: 2, strokeOpacity: 0.5 }, true).WebkitTextStroke,
  '2px rgba(255, 0, 0, 0.5)',
  'caption renderer applies stroke opacity without fading the fill',
);
assert.deepEqual(
  captionBoxStyle({ ...karaokePreset, highlightBackground: '#000000', boxBorderColor: '#ffffff', boxBorderWidth: 2, boxBorderRadius: 10 }, true),
  {
    background: '#000000', border: '2px solid #ffffff', borderRadius: 10, boxShadow: undefined,
    boxSizing: 'border-box', padding: '0 .14em',
  },
  'caption box fields are converted into paintable CSS',
);
assert.match(
  String(containerStyle(karaokePreset, 'tiktok', 1080, 1920, {
    anchor: 'middle-center', scale: 1.25, rotation: -12, opacity: 0.6,
  }).transform),
  /rotate\(-12deg\) scale\(1\.25\)/,
  'whole-caption transforms are consumed by the shared preview/export layout',
);
assert.deepEqual(
  mapCaptionStyle({
    strokeOpacity: 0.4,
    textShadowSize: 14,
    boxBorderColor: '#abcdef',
    boxBorderWidth: 3,
    boxBorderOpacity: 0.8,
    boxBorderRadius: 12,
    boxShadow: '0 4px 18px #0008',
    boxShadowSize: 18,
  }, 1920),
  {
    styleOverride: {
      strokeOpacity: 0.4,
      textShadowSize: 14,
      boxBorderColor: '#abcdef',
      boxBorderWidth: 3,
      boxBorderOpacity: 0.8,
      boxBorderRadius: 12,
      boxShadow: '0 4px 18px #0008',
      boxShadowSize: 18,
    },
    pacing: undefined,
    ignored: [],
  },
  'agent caption style input can reach every newly rendered paint field',
);

assert.deepEqual(
  captionPreviewOutsideClickAction({
    editing: true,
    popoverOpen: false,
    insideEditor: false,
    insideToolbar: false,
    draftChanged: true,
  }),
  { closeEditor: true, commitDraft: true, closePopover: false },
  'clicking canvas space commits a changed direct-edit draft before closing the editor',
);
assert.deepEqual(
  captionPreviewOutsideClickAction({
    editing: true,
    popoverOpen: true,
    insideEditor: false,
    insideToolbar: true,
    draftChanged: true,
  }),
  { closeEditor: false, commitDraft: false, closePopover: false },
  'toolbar pointerdown must not cancel the toolbar click or close the active editor',
);

const target = findCaptionPreviewTarget(captions, [], 30, 1_500);
assert.equal(target?.kind, 'manual', 'manual multi-lane captions expose a preview edit target');
assert.equal(target?.cue.text, '画面里可编辑');

const textPatch = captionPreviewTextPatch(captions, target!, '预览已改字');
assert.equal(textPatch?.sourceEntries?.[0]?.words?.[0]?.text, '预览已改字');

const stylePatch = captionPreviewStylePatch(captions, target!, { color: '#ff0000' });
assert.equal(stylePatch.sourceEntries?.[0]?.style?.color, '#ff0000');
const styledCaptions = { ...captions, ...stylePatch };
assert.equal(
  captionPreviewStyleResetPatch(styledCaptions, findCaptionPreviewTarget(styledCaptions, [], 30, 1_500)!).sourceEntries?.[0]?.style,
  undefined,
  'style reset removes only the selected lane override',
);

const layoutPatch = captionPreviewLayoutPatch(captions, target!, {
  anchor: 'bottom-center', offsetXRatio: 0.1, offsetYRatio: 0.2,
});
assert.equal(layoutPatch.sourceEntries?.[0]?.offsetXRatio, 0.1);
assert.equal(layoutPatch.sourceEntries?.[0]?.offsetYRatio, 0.2);
const transformedCaptions = {
  ...captions,
  ...captionPreviewLayoutPatch(captions, target!, {
    anchor: 'bottom-center', offsetXRatio: 0.1, offsetYRatio: 0.2, scale: 1.5, rotation: 15, opacity: 0.75,
  }),
};
const transformedTarget = findCaptionPreviewTarget(transformedCaptions, [], 30, 1_500)!;
assert.equal(transformedTarget.layout?.scale, 1.5, 'manual preview targets retain render transforms');
const resetLayout = captionPreviewLayoutResetPatch(transformedCaptions, transformedTarget).sourceEntries?.[0];
assert.equal(resetLayout?.anchor, undefined);
assert.equal(resetLayout?.scale, undefined);
assert.equal(resetLayout?.words?.[0]?.text, '画面里可编辑', 'layout reset preserves cue content');

const positionedCaptions = { ...captions, ...layoutPatch };
const positionedTarget = findCaptionPreviewTarget(positionedCaptions, [], 30, 1_500)!;
assert.equal(
  captionPreviewNudgePatch(positionedCaptions, positionedTarget, 'left').sourceEntries?.[0]?.offsetXRatio,
  0.09,
  'left arrow moves the caption one percent of the composition width',
);
assert.equal(
  captionPreviewNudgePatch(positionedCaptions, positionedTarget, 'up').sourceEntries?.[0]?.offsetYRatio,
  0.21,
  'bottom anchors store upward movement as a positive vertical offset',
);

const topLayoutPatch = captionPreviewLayoutPatch(captions, target!, {
  anchor: 'top-center', offsetXRatio: 0, offsetYRatio: 0.2,
});
const topCaptions = { ...captions, ...topLayoutPatch };
const topTarget = findCaptionPreviewTarget(topCaptions, [], 30, 1_500)!;
assert.equal(
  captionPreviewNudgePatch(topCaptions, topTarget, 'up').sourceEntries?.[0]?.offsetYRatio,
  0.19,
  'top anchors store upward movement as a negative vertical delta',
);

const deletePatch = captionPreviewTextPatch(captions, target!, '');
assert.equal(deletePatch?.sourceEntries?.[0]?.words?.length, 0);

console.log('captionPreviewTarget.verify: ok');
