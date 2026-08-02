import assert from 'node:assert/strict';
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
  patch: { scale: 1, x: 0, y: 0, rotation: 0, opacity: 1 },
});

console.log('inspector-controls.verify: ok');
