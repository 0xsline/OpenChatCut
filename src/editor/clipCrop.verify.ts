import assert from 'node:assert/strict';
import {
  clipCropEdgeMax,
  clipCropFractionToPx,
  clipCropInsetPatch,
  clipCropMergePatch,
  clipCropPxToFraction,
  compactClipCrop,
  hasClipCrop,
  PREVIEW_CROP_MIN_SPAN,
} from './clipCrop';

assert.equal(hasClipCrop(undefined), false);
assert.equal(hasClipCrop({ left: 0, right: 0, top: 0, bottom: 0 }), false);
assert.equal(hasClipCrop({ left: 0.2 }), true);
assert.equal(compactClipCrop({ left: 0, right: 0, top: 0, bottom: 0 }), undefined);

assert.deepEqual(clipCropInsetPatch(undefined, 'left', 0.25), { crop: { left: 0.25, top: 0, right: 0, bottom: 0 } });
assert.deepEqual(clipCropInsetPatch({ left: 0.25 }, 'left', 0), { crop: undefined });
assert.deepEqual(clipCropInsetPatch({ left: 0.1, right: 0.2 }, 'top', 0.3), {
  crop: { left: 0.1, top: 0.3, right: 0.2, bottom: 0 },
});

assert.equal(clipCropFractionToPx(0.25, 1920), 480);
assert.equal(clipCropPxToFraction(480, 1920), 0.25);
assert.equal(clipCropFractionToPx(clipCropPxToFraction(1, 1920), 1920), 1, '1px round-trips at 1920');
assert.deepEqual(clipCropMergePatch({ left: 0.1 }, { right: 0.2 }), {
  crop: { left: 0.1, top: 0, right: 0.2, bottom: 0 },
});
const maxLeft = clipCropEdgeMax({ right: 0.4 }, 'left');
assert.ok(Math.abs(maxLeft - (1 - 0.4 - PREVIEW_CROP_MIN_SPAN)) < 1e-9, 'left max respects opposite inset + min span');
const clampedLeft = clipCropInsetPatch({ right: 0.8 }, 'left', 0.9).crop?.left;
assert.ok(clampedLeft !== undefined && Math.abs(clampedLeft - clipCropEdgeMax({ right: 0.8 }, 'left')) < 1e-6, 'oversize inset is clamped then compacted');

console.log('clipCrop.verify: ok');
