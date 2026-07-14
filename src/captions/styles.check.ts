import assert from 'node:assert/strict';
import { CAPTION_STYLES, CAPTION_STYLE_BY_ID } from './styles';
import { paginate } from './types';

assert.equal(CAPTION_STYLES.length, 21);
assert.equal(new Set(CAPTION_STYLES.map((style) => style.id)).size, 21);
assert.equal(CAPTION_STYLE_BY_ID['the-french-dispatch'].label, 'The French Dispatch');
assert.equal(paginate([
  { text: 'one', start: 0, end: 100 },
  { text: 'two', start: 110, end: 200 },
  { text: 'three', start: 210, end: 300 },
], 'phrase', 2).length, 2);

console.log('caption-styles.check: ok');
