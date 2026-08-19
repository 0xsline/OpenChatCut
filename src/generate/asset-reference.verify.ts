import assert from 'node:assert/strict';
import type { MediaAsset } from '../editor/types';
import { findAssetByReference } from './asset-reference';

const asset = (id: string, name = id): MediaAsset => ({
  id, name, kind: 'video', src: `/media/uploads/${id}.mp4`, durationInFrames: 30,
});
const assets = [asset('abc1'), asset('abc2'), asset('abc')];

assert.equal(findAssetByReference('abc', assets)?.id, 'abc', 'exact id wins over earlier prefixes');
assert.equal(findAssetByReference('abc1', assets)?.id, 'abc1');
assert.throws(
  () => findAssetByReference('ab', assets),
  /asset id prefix is ambiguous/,
  'ambiguous prefixes are rejected instead of selecting the first asset',
);
assert.equal(findAssetByReference('missing', assets), undefined);

console.log('asset-reference.verify OK');
