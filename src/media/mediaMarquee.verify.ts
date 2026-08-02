import assert from 'node:assert/strict';
import { marqueeAssetIds, marqueeRect } from './mediaMarquee';

assert.deepEqual(marqueeRect({ x: 50, y: 40 }, { x: 10, y: 15 }), {
  left: 10, top: 15, right: 50, bottom: 40,
});
assert.deepEqual(marqueeAssetIds(
  { left: 10, top: 10, right: 30, bottom: 30 },
  [
    { id: 'inside', rect: { left: 12, top: 12, right: 20, bottom: 20 } },
    { id: 'edge', rect: { left: 30, top: 20, right: 40, bottom: 25 } },
    { id: 'outside', rect: { left: 31, top: 31, right: 40, bottom: 40 } },
  ],
), ['inside', 'edge']);

console.log('mediaMarquee.verify: geometry and intersecting selection pass');
