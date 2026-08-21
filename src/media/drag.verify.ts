import assert from 'node:assert/strict';
import { canDropMediaAsset, parseMediaAssetDragText } from './drag';

assert.equal(parseMediaAssetDragText('{"v":1,"assetId":"asset_1"}'), 'asset_1');
assert.equal(parseMediaAssetDragText('{"v":2,"assetId":"asset_1"}'), null);
assert.equal(parseMediaAssetDragText('{"v":1,"assetId":""}'), null);
assert.equal(parseMediaAssetDragText('not-json'), null);

assert.equal(canDropMediaAsset({ kind: 'image' }, 'video'), true);
assert.equal(canDropMediaAsset({ kind: 'gif' }, 'video'), true);
assert.equal(canDropMediaAsset({ kind: 'audio' }, 'audio'), true);
assert.equal(canDropMediaAsset({ kind: 'image' }, 'audio'), false);
assert.equal(canDropMediaAsset({ kind: 'audio' }, 'video'), false);
assert.equal(canDropMediaAsset({ kind: 'document' }, 'video'), false);
assert.equal(canDropMediaAsset({ kind: 'file' }, 'audio'), false);

console.log('media drag: payload validation and track compatibility OK');
