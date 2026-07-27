import assert from 'node:assert/strict';
import type { DesignStyle } from '../editor/types';
import { buildDesignStyleRecipe, parseDesignStyleRecipe } from './designStyleTransfer';

const style: DesignStyle = {
  colors: [{ role: ' accent ', value: ' #ff5500 ' }],
  fonts: [{ role: 'heading', family: ' Inter ' }],
  styleGuide: '  快节奏，避免闪白转场。  ',
};
const built = buildDesignStyleRecipe('  社交短片  ', style, {
  scenarios: [' social ', 'social', 'launch'],
});
const parsed = parseDesignStyleRecipe(JSON.stringify(built));

assert.equal(parsed.name, '社交短片');
assert.deepEqual(parsed.scenarios, ['social', 'launch']);
assert.deepEqual(parsed.style.colors, [{ role: 'accent', value: '#ff5500' }]);
assert.equal(parsed.style.fonts[0]?.family, 'Inter');
assert.equal(parsed.style.styleGuide, '快节奏，避免闪白转场。');

assert.throws(() => parseDesignStyleRecipe('{'), /JSON/);
assert.throws(() => parseDesignStyleRecipe(JSON.stringify({ ...built, version: 2 })), /版本/);
assert.throws(() => parseDesignStyleRecipe(JSON.stringify({
  ...built,
  style: { colors: [{ role: 'accent' }], fonts: [] },
})), /颜色值/);

console.log('designStyleTransfer.verify: ok');
