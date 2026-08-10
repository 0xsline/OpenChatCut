import assert from 'node:assert';
import { normalizeFrameRange } from './range';

assert.strictEqual(normalizeFrameRange(300), undefined, 'a full export needs no Remotion frameRange');
assert.deepStrictEqual(normalizeFrameRange(300, 30), [30, 299], 'an open-ended range reaches the last frame');
assert.deepStrictEqual(normalizeFrameRange(300, undefined, 90), [0, 89], 'exclusive API end becomes an inclusive Remotion end');
assert.deepStrictEqual(normalizeFrameRange(300, 30, 90), [30, 89], 'partial range preserves its exact frame count');

for (const args of [
  [0],
  [300, -1, 30],
  [300, 30.5, 90],
  [300, 90, 90],
  [300, 90, 301],
] as Array<[number, number?, number?]>) {
  assert.throws(() => normalizeFrameRange(...args), /frame|duration/i);
}

console.log('range.check OK');
