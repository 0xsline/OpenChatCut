import assert from 'node:assert/strict';
import { captionBoxStyle, captionPreviewTextColor, wordStyle } from './renderStyles';
import type { CaptionStyle } from './styles';

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
assert.equal(captionBoxStyle({ ...preset, boxShadowSize: 0 }, true).boxShadow, undefined);

console.log('renderStyles.verify: caption render style controls remain aligned');
