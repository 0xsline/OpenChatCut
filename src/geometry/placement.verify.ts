import assert from 'node:assert/strict';
import {
  graphicOverlapsFace,
  safeBoxForRange,
  transformFromSafeBox,
} from './placement';
import type { VisualGeometryAsset } from './visual-geometry';

const geometry: VisualGeometryAsset = {
  assetId: 'a',
  sourceRevision: 'r',
  algorithmVersion: 'v',
  durationSec: 20,
  segments: [
    // Person on the left, safe zone on the right (0.52..0.97).
    {
      startSec: 0,
      endSec: 10,
      person: 'left',
      zone: { rects: [{ x: 0.52, y: 0.05, w: 0.45, h: 0.75 }], face: { x: 0.1, y: 0.2, w: 0.25, h: 0.3 }, subject: { x: 0.05, y: 0.1, w: 0.35, h: 0.8 } },
    },
    // Empty segment: full-frame safe zone.
    {
      startSec: 10,
      endSec: 20,
      person: 'none',
      zone: { rects: [{ x: 0, y: 0, w: 1, h: 1 }], face: null, subject: null },
    },
  ],
};

async function main(): Promise<void> {
  // 1. Window overlapping the person segment picks the right-side rect.
  const box = safeBoxForRange(geometry, 2, 8)!;
  assert.ok(box, 'safe box found');
  assert.ok(box.x >= 0.5, 'box sits on the empty right side');

  // 2. Window inside the empty segment gets the full frame.
  const full = safeBoxForRange(geometry, 12, 18)!;
  assert.ok(Math.abs(full.w - 1) < 1e-6 && Math.abs(full.h - 1) < 1e-6);

  // 3. Window entirely outside the geometry → no box.
  const tiny = safeBoxForRange(geometry, 25, 30);
  assert.equal(tiny, null, 'no window overlap → no box');

  // 4. Transform centers the graphic in the box.
  const t = transformFromSafeBox(box, 1.78)!;
  const expectedX = (box.x + box.w / 2 - 0.5) * 100;
  const expectedY = (box.y + box.h / 2 - 0.5) * 100;
  assert.ok(Math.abs(t.x - expectedX) < 0.2, 'x centers on box');
  assert.ok(Math.abs(t.y - expectedY) < 0.2, 'y centers on box');
  assert.ok(t.scale <= box.w, 'width fits the box');
  assert.ok(t.scale / 1.78 <= box.h, 'height fits the box');
  assert.ok(t.scale > 0.05);

  // 5. Placed graphic does not overlap the face.
  const conflict = graphicOverlapsFace(t, 1.78, geometry.segments[0]!.zone.face!);
  assert.equal(conflict, false, 'placement avoids the face');

  // 6. Degenerate input → null.
  assert.equal(transformFromSafeBox({ x: 0, y: 0, w: 0, h: 0 }, 1.78), null);

  console.log('placement.verify: all assertions passed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
