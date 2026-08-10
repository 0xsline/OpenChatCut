import assert from 'node:assert/strict';
import { mediaAssetDownloadName, motionGraphicExport } from './assetExport';

Object.defineProperty(globalThis, 'window', {
  value: { location: { href: 'http://localhost/', origin: 'http://localhost' } },
});

const image = {
  id: 'image-1', name: '封面', kind: 'image' as const,
  src: '/media/uploads/cover.png', durationInFrames: 150,
};
assert.equal(mediaAssetDownloadName(image), '封面.png');

const mg = {
  id: 'mg-1', name: '标题', kind: 'motion-graphic' as const, src: '',
  durationInFrames: 90, width: 1080, height: 1080, code: 'return null',
};
const exported = motionGraphicExport(mg, 30);
assert.equal(exported.item.durationInFrames, 90);
assert.deepEqual([exported.state.width, exported.state.height], [1080, 1080]);
