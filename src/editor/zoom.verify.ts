// Runnable check for the zoom curve math: `npx tsx src/editor/zoom.check.ts`.
import assert from 'node:assert';
import { zoomAt, shapeCurve } from './zoom';
import type { ZoomEffect } from './types';

// slow-push = linear ramp 1→2 over 60 frames (easeIn = full duration)
const push: ZoomEffect = { shape: 'slow-push', magnification: 2 };
assert.ok(Math.abs(zoomAt(push, 0, 60).magnification - 1) < 1e-9, 'slow-push start = 1');
assert.ok(Math.abs(zoomAt(push, 30, 60).magnification - 1.5) < 1e-9, 'slow-push mid = 1.5');
assert.ok(Math.abs(zoomAt(push, 60, 60).magnification - 2) < 1e-9, 'slow-push end = 2');

// shape curves: punch is front-loaded (ease-out), hold is symmetric at the mid
assert.ok(shapeCurve('punch', 0.5) > 0.5, 'punch ease-out front-loaded');
assert.ok(Math.abs(shapeCurve('hold', 0.5) - 0.5) < 1e-9, 'hold ease-in-out mid = 0.5');
assert.strictEqual(shapeCurve('slow-push', 0.4), 0.4, 'slow-push linear');

// reframe sparse keyframes interpolate linearly and win over the parametric curve
const curved: ZoomEffect = {
  reframeCurve: {
    version: 1,
    timebase: 'effect-frame',
    coordinateSpace: 'composition-normalized',
    keyframes: [
      { frame: 0, focalPointX: 0, focalPointY: 0, magnification: 1 },
      { frame: 10, focalPointX: 1, focalPointY: 1, magnification: 3 },
    ],
  },
};
const r = zoomAt(curved, 5, 60);
assert.ok(Math.abs(r.magnification - 2) < 1e-9, 'reframe mid magnification = 2');
assert.ok(Math.abs(r.focalX - 0.5) < 1e-9 && Math.abs(r.focalY - 0.5) < 1e-9, 'reframe mid focal = 0.5');
// clamps outside the keyframe range
assert.strictEqual(zoomAt(curved, 999, 60).magnification, 3, 'reframe clamps to last');

console.log('zoom.check OK');
