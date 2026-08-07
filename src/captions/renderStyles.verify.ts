import assert from 'node:assert/strict';
import { captionBoxStyle, captionPreviewTextColor, captionTextStyle, containerStyle, effectivePreset, wordStyle } from './renderStyles';
import { CAPTION_STYLE_BY_ID, type CaptionStyle } from './styles';
import { mapCaptionStyle } from './styleMap';

const preset: CaptionStyle = {
  id: 'plain',
  label: 'Test',
  labelZh: '测试',
  hint: '测试',
  fontFamily: 'Inter',
  fontSize: 0.04,
  fontWeight: 700,
  color: '#ffffff',
  highlightColor: '#ffffff',
  highlightBackground: '#ff2e63',
  strokeColor: '#112233',
  strokeWidth: 4,
  strokeOpacity: 0.5,
  textShadow: '0 3px 8px #000000aa',
  boxBorderColor: '#abcdef',
  boxBorderWidth: 3,
  boxBorderOpacity: 0.25,
  boxBorderRadius: 12,
  boxShadow: '0 4px 12px #00000088',
};

const text = wordStyle(preset, false);
assert.equal(text.paintOrder, 'stroke fill');
assert.equal(text.WebkitTextStroke, '4px rgba(17, 34, 51, 0.5)');
assert.equal(text.textShadow, '0 3px 8px #000000aa');
assert.equal(captionPreviewTextColor({ ...preset, color: '#ffffff', highlightColor: '#0a0a0a' }), '#0a0a0a');
assert.equal(captionPreviewTextColor({ ...preset, wholeLine: true, color: '#f8f8f8', highlightColor: '#0a0a0a' }), '#f8f8f8');

assert.equal(wordStyle({ ...preset, textShadowSize: 0 }, false).textShadow, 'none');
const activeBox = captionBoxStyle(preset, true);
assert.equal(activeBox.background, '#ff2e63');
assert.equal(activeBox.border, '3px solid rgba(171, 205, 239, 0.25)');
assert.equal(activeBox.borderRadius, 12);
assert.equal(activeBox.boxShadow, '0 4px 12px #00000088');
assert.equal(captionBoxStyle({ ...preset, boxShadowSize: 0 }, true).boxShadow, 'none');

const mapped = mapCaptionStyle({
  fontFamily: 'Noto Sans SC',
  fontSize: 0.064,
  fontWeight: 650,
  fontStyle: 'italic',
  textAlign: 'left',
  underline: true,
  strike: true,
  letterSpacing: 1.75,
  lineHeight: 1.45,
  strokeColor: '#445566',
  strokeWidth: 2,
  shadow: '1px 2px 3px #000000aa',
  background: '#112233',
  backgroundOpacity: 0.5,
  borderRadius: 18,
}, 1_000);
assert.deepEqual(mapped.ignored, [], 'all serialized high-impact style fields map into the caption model');
const serializedOverride = JSON.parse(JSON.stringify(mapped.styleOverride)) as typeof mapped.styleOverride;
const rendered = captionTextStyle({ ...preset, ...serializedOverride }, 1_000, false);
assert.deepEqual(
  {
    fontFamily: rendered.fontFamily,
    fontSize: rendered.fontSize,
    fontWeight: rendered.fontWeight,
    fontStyle: rendered.fontStyle,
    textAlign: rendered.textAlign,
    textDecorationLine: rendered.textDecorationLine,
    letterSpacing: rendered.letterSpacing,
    lineHeight: rendered.lineHeight,
    WebkitTextStroke: rendered.WebkitTextStroke,
    textShadow: rendered.textShadow,
    background: rendered.background,
    borderRadius: rendered.borderRadius,
  },
  {
    fontFamily: 'Noto Sans SC, system-ui, sans-serif',
    fontSize: 64,
    fontWeight: 650,
    fontStyle: 'italic',
    textAlign: 'left',
    textDecorationLine: 'underline line-through',
    letterSpacing: 1.75,
    lineHeight: 1.45,
    WebkitTextStroke: '2px rgba(68, 85, 102, 0.5)',
    textShadow: '1px 2px 3px #000000aa',
    background: 'rgba(17, 34, 51, 0.5)',
    borderRadius: 18,
  },
  'the shared preview/export consumer receives every serialized typography and paint property',
);
const transformed = containerStyle(
  { ...preset, ...serializedOverride },
  'plain',
  1_920,
  1_080,
  { anchor: 'middle-right', offsetXRatio: Number.NaN, scale: Number.NaN, rotation: Number.NaN, opacity: Number.NaN },
);
assert.equal(transformed.textAlign, 'left');
assert.match(String(transformed.transform), /translate\(0px, 0px\) rotate\(0deg\) scale\(1\)/);
assert.equal(transformed.opacity, 1);
assert.equal(
  [...Object.values(rendered), ...Object.values(transformed)].some(
    (value) => value === undefined || (typeof value === 'number' && !Number.isFinite(value)),
  ),
  false,
  'shared render output contains neither undefined nor non-finite numeric values',
);

const builtinIds = ['plain', 'black-bar', 'bubble-pop', 'signal'] as const;
const builtinLooks = builtinIds.map((template) => {
  const persisted = JSON.parse(JSON.stringify({ enabled: true, template, pacing: 'phrase' as const }));
  const resolved = effectivePreset(persisted);
  const painted = captionTextStyle(resolved, 1_080, false, resolved.wholeLine);
  return {
    template: persisted.template,
    fontFamily: painted.fontFamily,
    fontSize: painted.fontSize,
    fontWeight: painted.fontWeight,
    color: painted.color,
    stroke: painted.WebkitTextStroke,
    background: CAPTION_STYLE_BY_ID[template].background ?? CAPTION_STYLE_BY_ID[template].highlightBackground ?? '',
    wordsPerPage: resolved.wordsPerPage ?? null,
  };
});
assert.equal(new Set(builtinLooks.map((look) => JSON.stringify(look))).size, builtinIds.length,
  'built-in preset ids persist and resolve to observably distinct render/layout fields');

console.log('renderStyles.verify: caption render style controls remain aligned');
