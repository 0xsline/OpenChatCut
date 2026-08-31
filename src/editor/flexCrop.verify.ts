import assert from 'node:assert/strict';
import {
  flexCropClipPath,
  flexCropEdgeMax,
  flexCropFractionToPx,
  flexCropInsetPatch,
  flexCropMergePatch,
  flexCropPxToFraction,
  flexCropRect,
  flexCropRenderPx,
  flexCropVisibleRect,
  compactFlexCrop,
  hasFlexCrop,
  PREVIEW_CROP_MIN_SPAN,
} from './flexCrop';

assert.equal(hasFlexCrop(undefined), false);
assert.equal(hasFlexCrop({ left: 0, right: 0, top: 0, bottom: 0 }), false);
assert.equal(hasFlexCrop({ left: 0.2 }), true);
assert.equal(compactFlexCrop({ left: 0, right: 0, top: 0, bottom: 0 }), undefined);

assert.deepEqual(flexCropInsetPatch(undefined, 'left', 0.25), { crop: { left: 0.25, top: 0, right: 0, bottom: 0 } });
assert.deepEqual(flexCropInsetPatch({ left: 0.25 }, 'left', 0), { crop: undefined });
assert.deepEqual(flexCropInsetPatch({ left: 0.1, right: 0.2 }, 'top', 0.3), {
  crop: { left: 0.1, top: 0.3, right: 0.2, bottom: 0 },
});

assert.equal(flexCropFractionToPx(0.25, 1920), 480);
assert.equal(flexCropPxToFraction(480, 1920), 0.25);
assert.equal(flexCropFractionToPx(flexCropPxToFraction(1, 1920), 1920), 1, '1px round-trips at 1920');
assert.equal(flexCropRenderPx(100 / 1080, 1080), 100, '100px bottom stays 100px on the canvas');
assert.equal(flexCropRenderPx(7 / 1920, 1920), 7);
{
  const stored = compactFlexCrop({
    left: 0,
    right: 0,
    top: 100 / 1080,
    bottom: 100 / 1080,
  });
  assert.ok(stored);
  assert.equal(flexCropRenderPx(stored.top ?? 0, 1080), 100, 'compacted Crop Top does not ceil to 101px');
  assert.equal(flexCropRenderPx(stored.bottom ?? 0, 1080), 100, 'compacted Crop Bottom does not ceil to 101px');
  const path = flexCropClipPath(stored, 1920, 1080);
  assert.ok(path && path.includes('px') && !path.includes('%'), 'clip-path is composition px, not CSS %');
}
assert.equal(
  flexCropClipPath({ bottom: 100 / 1920 }, 1080, 1920),
  'inset(0px 0px 100px 0px)',
  'Crop Bottom 100px is 100 canvas pixels, not a percent of the letterboxed video box',
);
assert.deepEqual(flexCropRect({ bottom: 100 / 1920, left: 40 / 1080 }, 1080, 1920), {
  x: 40, y: 0, width: 1040, height: 1820,
});

{
  const frame = { x: 0, y: 656, width: 1080, height: 608 };
  const inLetterbox = { top: 0.1, bottom: 0.1 };
  assert.equal(flexCropClipPath(inLetterbox, 1080, 1920), 'inset(192px 0px 192px 0px)');
  const visIdle = flexCropVisibleRect(inLetterbox, 1080, 1920, frame);
  assert.deepEqual(visIdle, frame, 'Crop Top/Bottom still in the letterbox does not move the orange picture box');

  const intoPicture = { top: 0.4, bottom: 0.4 };
  assert.equal(flexCropClipPath(intoPicture, 1080, 1920), 'inset(768px 0px 768px 0px)');
  const vis = flexCropVisibleRect(intoPicture, 1080, 1920, frame);
  assert.equal(vis.y, 768);
  assert.equal(vis.y + vis.height, 1152);
  assert.equal(vis.y, flexCropRect(intoPicture, 1080, 1920).y, 'orange top is the same canvas pixel as clip-path top');
}

{
  const frame = { x: 0, y: 656, width: 1080, height: 608 };
  const leftRight = { left: 100 / 1080, right: 80 / 1080 };
  const path = flexCropClipPath(leftRight, 1080, 1920);
  assert.equal(path, 'inset(0px 80px 0px 100px)');
  const vis = flexCropVisibleRect(leftRight, 1080, 1920, frame);
  assert.equal(vis.x, 100);
  assert.equal(vis.x + vis.width, 1000);
}

{
  for (let n = 0; n <= 1920; n++) {
    const stored = n === 0 ? undefined : compactFlexCrop({
      left: 0, right: 0, top: flexCropPxToFraction(n, 1920), bottom: 0,
    });
    assert.equal(flexCropFractionToPx(stored?.top ?? 0, 1920), n, `Crop Top ${n}px round-trips`);
  }
  const frame = { x: 0, y: 656, width: 1080, height: 608 };
  let prev = frame.y;
  for (let n = 656; n <= 720; n++) {
    const vis = flexCropVisibleRect({ top: flexCropPxToFraction(n, 1920) }, 1080, 1920, frame);
    assert.equal(vis.y, n, `orange top follows Crop Top ${n}px`);
    assert.equal(vis.y - prev, n === 656 ? 0 : 1, `orange moves 1px from ${prev} to ${n}`);
    assert.equal(flexCropClipPath({ top: flexCropPxToFraction(n, 1920) }, 1080, 1920), `inset(${n}px 0px 0px 0px)`);
    prev = vis.y;
  }
}

assert.deepEqual(flexCropMergePatch({ left: 0.1 }, { right: 0.2 }), {
  crop: { left: 0.1, top: 0, right: 0.2, bottom: 0 },
});
const maxLeft = flexCropEdgeMax({ right: 0.4 }, 'left');
assert.ok(Math.abs(maxLeft - (1 - 0.4 - PREVIEW_CROP_MIN_SPAN)) < 1e-9, 'left max respects opposite inset + min span');
const clampedLeft = flexCropInsetPatch({ right: 0.8 }, 'left', 0.9).crop?.left;
assert.ok(clampedLeft !== undefined && Math.abs(clampedLeft - flexCropEdgeMax({ right: 0.8 }, 'left')) < 1e-6, 'oversize inset is clamped then compacted');

console.log('flexCrop.verify: ok');
