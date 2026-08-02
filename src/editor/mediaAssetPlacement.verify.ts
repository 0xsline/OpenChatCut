import assert from 'node:assert/strict';
import { placeMediaAssets } from './mediaAssetPlacement';

const placed: Array<{ id: string; frame: number }> = [];
let selected: string[] = [];
assert.equal(placeMediaAssets({
  assetIds: ['b', 'a', 'missing'],
  assets: [
    { id: 'a', durationInFrames: 30 },
    { id: 'b', durationInFrames: 10 },
  ],
  startFrame: 100,
  add: (asset, frame) => {
    const id = `item-${asset.id}`;
    placed.push({ id, frame });
    return id;
  },
  select: (ids) => { selected = ids; },
}), true);
assert.deepEqual(placed, [
  { id: 'item-b', frame: 100 },
  { id: 'item-a', frame: 110 },
]);
assert.deepEqual(selected, ['item-b', 'item-a'], 'the whole batch remains selected');

console.log('mediaAssetPlacement.verify: batch placement and selection OK');
