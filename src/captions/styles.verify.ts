import assert from 'node:assert/strict';
import { CAPTION_STYLES, CAPTION_STYLE_BY_ID } from './styles';
import { paginate } from './types';

assert.equal(CAPTION_STYLES.length, 22);
assert.equal(new Set(CAPTION_STYLES.map((style) => style.id)).size, 22);
assert.equal(CAPTION_STYLE_BY_ID['the-french-dispatch'].label, 'The French Dispatch');
// 黑底白字默认样式:整句连续渲染(无词间隙/无逐词高亮)+整行黑底
assert.equal(CAPTION_STYLE_BY_ID['black-bar'].wholeLine, true);
assert.ok(CAPTION_STYLE_BY_ID['black-bar'].background);
assert.equal(paginate([
  { text: 'one', start: 0, end: 100 },
  { text: 'two', start: 110, end: 200 },
  { text: 'three', start: 210, end: 300 },
], 'phrase', 2).length, 2);

console.log('caption-styles.check: ok');
