import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { keyframeResetBatch } from '../../editor/keyframeReset';
import { clampScalar, scalarModifier, scrubScalar, snapScalar } from './scalarMath';

assert.equal(scalarModifier({ shiftKey: false, metaKey: false }), 1);
assert.equal(scalarModifier({ shiftKey: true, metaKey: false }), 10);
assert.equal(scalarModifier({ shiftKey: false, metaKey: true }), 0.1);
assert.equal(scrubScalar(1, 2, 0.05, 0, 2, { shiftKey: false, metaKey: false }), 1.1);
assert.equal(scrubScalar(1, 2, 0.05, 0, 2, { shiftKey: true, metaKey: false }), 2);
assert.equal(scrubScalar(1, -100, 0.05, 0, 2, { shiftKey: false, metaKey: true }), 0.5);
assert.equal(clampScalar(9, 0, 2), 2);
assert.equal(snapScalar(1.373, 0, 2, 0.05), 1.35);

const row = keyframeResetBatch('clip-1', ['volume']);
assert.equal(row.label, 'Reset volume');
assert.deepEqual(row.actions, [
  { type: 'clearKeyframes', id: 'clip-1', prop: 'volume' },
  { type: 'setVolume', id: 'clip-1', volume: 1 },
]);

const group = keyframeResetBatch('clip-1', ['scale', 'x', 'y', 'rotation', 'opacity']);
assert.equal(group.label, 'Reset transform');
assert.deepEqual(group.actions.at(-1), {
  type: 'setTransform',
  id: 'clip-1',
  // Uniform scale reset also re-links scaleX/scaleY so non-uniform residue is cleared.
  patch: { scale: 1, scaleX: 1, scaleY: 1, x: 0, y: 0, rotation: 0, opacity: 1, crop: undefined },
});

const transformSource = readFileSync(new URL('./InspectorKeyframeControls.tsx', import.meta.url), 'utf8');
assert.match(transformSource, /label: '裁左'/, 'Transform 分组在圆角下应有裁左');
assert.match(transformSource, /label: '裁右'/, 'Transform 分组应有裁右');
assert.match(transformSource, /label: '裁上'/, 'Transform 分组应有裁上');
assert.match(transformSource, /label: '裁下'/, 'Transform 分组应有裁下');
assert.match(transformSource, /CROP_ROWS\.map/, '四边裁切应排在关键帧行之后');

console.log('inspector-controls.verify: ok');
