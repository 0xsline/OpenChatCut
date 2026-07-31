import assert from 'node:assert/strict';
import { buildExportPack, lutCandidates, zoomCandidates } from './export';
import type { SerializableFxDef } from '../gl/fx/uniforms';
import type { TimelineItem } from '../editor/types';

const cube = `TITLE "Test"
LUT_3D_SIZE 2
0 0 0
0 0 1
0 1 0
0 1 1
1 0 0
1 0 1
1 1 0
1 1 1`;

const lut: SerializableFxDef = {
  id: 'custom:test-lut',
  name: 'Test LUT',
  desc: '',
  frag: 'void main() {}',
  props: [],
  cube,
};
const zoomItem: TimelineItem = {
  id: 'clip-1',
  track: 'V1',
  startFrame: 0,
  durationInFrames: 90,
  name: 'Test clip',
  kind: 'video',
  zoom: { shape: 'punch', magnification: 2 },
};

const lutItems = lutCandidates([lut]);
const zoomItems = zoomCandidates([zoomItem]);
assert.equal(lutItems[0]?.item.type, 'lut');
assert.equal(zoomItems[0]?.item.type, 'zoom');
assert.equal(zoomItems[0]?.item.type === 'zoom' ? zoomItems[0].item.envelope?.length : 0, 32);

const result = buildExportPack(
  { id: 'test-pack', name: 'Test pack' },
  [...lutItems, ...zoomItems].map(({ item }) => item),
);
assert.equal(result.ok, true);

console.log('plugin export verification passed');
