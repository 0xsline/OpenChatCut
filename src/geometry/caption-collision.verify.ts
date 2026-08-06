import assert from 'node:assert/strict';
import {
  captionBandFromLayout,
  captionFaceConflicts,
  faceUnionOf,
  suggestCaptionAvoidance,
} from './caption-collision';
import type { VisualGeometryAsset } from './visual-geometry';
import type { GeomRect } from './geometry-math';

const geometryWith = (face: GeomRect | null): VisualGeometryAsset => ({
  assetId: 'a',
  sourceRevision: 'r',
  algorithmVersion: 'v',
  durationSec: 10,
  segments: [
    {
      startSec: 0,
      endSec: 10,
      person: face ? (face.x + face.w / 2 < 0.4 ? 'left' : face.x + face.w / 2 > 0.6 ? 'right' : 'center') : 'none',
      zone: { rects: [], face, subject: face },
    },
  ],
});

async function main(): Promise<void> {
  // 1. Default bottom-center caption vs a low-mid face → conflict.
  const faceMid = geometryWith({ x: 0.3, y: 0.6, w: 0.4, h: 0.3 });
  const defaults = [{ anchor: 'bottom-center', offsetXRatio: 0, offsetYRatio: 0 }];
  const conflicts = captionFaceConflicts(faceMid, defaults);
  assert.equal(conflicts.length, 1, 'bottom caption over a low face must flag');
  assert.ok(conflicts[0]!.coverage > 0.2);

  // 2. Face near the bottom edge (speaker sitting low) → still flagged.
  const faceLow = geometryWith({ x: 0.3, y: 0.7, w: 0.4, h: 0.25 });
  assert.equal(captionFaceConflicts(faceLow, defaults).length, 1);

  // 3. No face → no conflict.
  assert.equal(captionFaceConflicts(geometryWith(null), defaults).length, 0);

  // 4. Top-anchored caption vs face at bottom → no conflict (different band).
  const topLayout = [{ anchor: 'top-center', offsetXRatio: 0, offsetYRatio: 0 }];
  assert.equal(captionFaceConflicts(faceLow, topLayout).length, 0);

  // 5. Offset moves the caption out of the face band → no conflict.
  const shifted = [{ anchor: 'bottom-center', offsetXRatio: 0, offsetYRatio: -0.5 }];
  assert.equal(captionFaceConflicts(faceMid, shifted).length, 0, 'moved up clear of the face');

  // 6. faceUnionOf merges faces across segments.
  const twoSegments: VisualGeometryAsset = {
    assetId: 'a', sourceRevision: 'r', algorithmVersion: 'v', durationSec: 20,
    segments: [
      { startSec: 0, endSec: 10, person: 'left', zone: { rects: [], face: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 }, subject: null } },
      { startSec: 10, endSec: 20, person: 'right', zone: { rects: [], face: { x: 0.7, y: 0.1, w: 0.2, h: 0.2 }, subject: null } },
    ],
  };
  const union = faceUnionOf(twoSegments);
  assert.ok(union, 'face union present');
  assert.ok(Math.abs(union.w - 0.8) < 1e-6, 'union spans both sides');

  // 7. captionBandFromLayout mapping sanity.
  const band = captionBandFromLayout({ anchor: 'bottom-center', offsetXRatio: 0, offsetYRatio: 0 })!;
  assert.ok(Math.abs((band.y + band.h / 2) - 0.92) < 1e-6, 'bottom center at y≈0.92');
  const top = captionBandFromLayout({ anchor: 'top-left', offsetXRatio: 0, offsetYRatio: 0 })!;
  assert.ok(Math.abs((top.x + top.w / 2) - 0.25) < 1e-6, 'top-left centers at x≈0.25');

  // 8. Avoidance moves a conflicting bottom caption above the face.
  const lowFace = geometryWith({ x: 0.3, y: 0.6, w: 0.4, h: 0.3 });
  const conflict = captionFaceConflicts(lowFace, defaults)[0]!;
  const suggestion = suggestCaptionAvoidance(conflict)!;
  assert.equal(suggestion.side, 'above');
  const moved = captionBandFromLayout({ ...conflict.layout, offsetYRatio: suggestion.offsetYRatio })!;
  assert.equal(captionFaceConflicts(lowFace, [{ ...conflict.layout, offsetYRatio: suggestion.offsetYRatio }]).length, 0, 'suggested offset clears the face');
  assert.ok(moved.y + moved.h <= 0.6 - 1e-6, 'band sits above the face top');

  // 9. Face spanning the full height → no suggestion possible.
  const fullFace = geometryWith({ x: 0.2, y: 0.02, w: 0.6, h: 0.96 });
  const fullConflict = captionFaceConflicts(fullFace, defaults)[0]!;
  assert.equal(suggestCaptionAvoidance(fullConflict), null, 'no room above or below');

  // 10. No face detected → subject top band stands in (conservative avoidance).
  const noFace = {
    assetId: 'a', sourceRevision: 'r', algorithmVersion: 'v', durationSec: 10,
    segments: [{
      startSec: 0, endSec: 10, person: 'center',
      zone: { rects: [], face: null, subject: { x: 0.3, y: 0.85, w: 0.4, h: 0.15 } },
    }],
  } as VisualGeometryAsset;
  const headUnion = faceUnionOf(noFace)!;
  assert.ok(headUnion, 'subject top band replaces the missing face');
  assert.ok(Math.abs(headUnion.y - 0.85) < 1e-6, 'band starts at subject top');
  assert.ok(Math.abs(headUnion.h - 0.0525) < 1e-6, 'band is the top 35% of the subject');
  const noFaceConflicts = captionFaceConflicts(noFace, defaults);
  assert.equal(noFaceConflicts.length, 1, 'bottom caption over the subject head band flags even without a face');

  console.log('caption-collision.verify: all assertions passed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
