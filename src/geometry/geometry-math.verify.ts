import assert from 'node:assert/strict';
import {
  GEOM_GRID_H,
  GEOM_GRID_W,
  intersects,
  largestEmptyRect,
  safeZoneForRange,
  type FrameGeom,
  type GeomRect,
} from './geometry-math';

const W = GEOM_GRID_W;
const H = GEOM_GRID_H;

function emptyOcc(): Uint8Array {
  return new Uint8Array(W * H);
}

function fillOcc(occ: Uint8Array, x0: number, y0: number, x1: number, y1: number): void {
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) occ[y * W + x] = 1;
  }
}

const frame = (t: number, occ: Uint8Array, face: GeomRect | null = null): FrameGeom => ({ t, occ, face });

async function main(): Promise<void> {
  // 1. Empty grid → the whole frame is the safe zone (nothing blocks placement).
  const empty = safeZoneForRange([frame(0, emptyOcc())], 0, 10);
  assert.equal(empty.rects.length, 1, 'all-empty occupancy offers the whole frame');
  assert.equal(empty.rects[0]!.x, 0);
  assert.equal(empty.rects[0]!.y, 0);
  assert.ok(Math.abs(empty.rects[0]!.w - 1) < 1e-6 && Math.abs(empty.rects[0]!.h - 1) < 1e-6);
  assert.equal(empty.subject, null);

  // 2. Person on the left half → largest empty rect is on the right, clear of the face.
  const person = emptyOcc();
  fillOcc(person, 0, 0, Math.floor(W * 0.5), H); // person occupies left 50%
  const zone = safeZoneForRange([frame(0, person, { x: 0.15, y: 0.2, w: 0.2, h: 0.25 })], 0, 10);
  assert.ok(zone.rects.length > 0, 'right half must offer a placeable rect');
  const best = zone.rects[0]!;
  assert.ok(best.x >= 0.5 - 1e-6, 'best rect starts right of the person');
  assert.ok(!intersects(best, { x: 0.15, y: 0.2, w: 0.2, h: 0.25 }), 'face exclusion respected');

  // 3. Bottom caption band (blockRects) is subtracted: no rect may cross into it.
  const full = emptyOcc();
  const captionBand = { x: 0, y: 0.84, w: 1, h: 0.16 };
  const withBand = safeZoneForRange([frame(0, full)], 0, 10, [captionBand]);
  for (const r of withBand.rects) {
    assert.ok(r.y + r.h <= 0.84 + 1e-6, 'no rect enters the caption band');
  }

  // 4. Range union: a person appearing at either end blocks the whole segment.
  const early = emptyOcc();
  fillOcc(early, 0, 0, Math.floor(W * 0.5), H);
  const late = emptyOcc();
  fillOcc(late, Math.floor(W * 0.5), 0, W, H);
  const union = safeZoneForRange([frame(1, early), frame(9, late)], 0, 10);
  assert.equal(union.rects.length, 0, 'left+right union leaves no empty column');

  // 5. Out-of-range segment falls back to the nearest sampled frame, not a global union.
  const only = emptyOcc();
  fillOcc(only, 0, 0, Math.floor(W * 0.4), H);
  const near = safeZoneForRange([frame(5, only)], 0, 10);
  const far = safeZoneForRange([frame(5, only)], 20, 30);
  assert.ok(near.rects.length > 0);
  assert.deepEqual(far.rects, near.rects, 'nearest-frame fallback equals the sampled-frame zone');

  // 6. Face union across frames (person moves head between samples).
  const a = emptyOcc();
  const b = emptyOcc();
  const zoneFace = safeZoneForRange([
    frame(0, a, { x: 0.1, y: 0.1, w: 0.2, h: 0.2 }),
    frame(1, b, { x: 0.7, y: 0.1, w: 0.2, h: 0.2 }),
  ], 0, 10);
  assert.ok(zoneFace.face, 'face union present');
  assert.ok(zoneFace.face!.w >= 0.6, 'faces on both sides widen the union');

  // 7. largestEmptyRect: exact histogram result on a crafted grid.
  const grid = new Uint8Array(W * H);
  // Block row 2 (0-based) fully, and column 15 from row 0..4 → the largest empty
  // rect sits above the blocked row.
  for (let x = 0; x < W; x++) grid[2 * W + x] = 1;
  for (let y = 0; y < 5; y++) grid[y * W + 15] = 1;
  const found = largestEmptyRect(grid);
  assert.ok(found, 'largest empty rect found');
  assert.equal(found.y, 5, 'starts below blocked rows 0..4 (column 15 blocked there too)');
  assert.equal(found.h, H - 5, 'spans to the bottom');

  // 8. intersects helper.
  assert.equal(intersects({ x: 0, y: 0, w: 0.5, h: 0.5 }, { x: 0.4, y: 0.4, w: 0.5, h: 0.5 }), true);
  assert.equal(intersects({ x: 0, y: 0, w: 0.3, h: 0.3 }, { x: 0.5, y: 0.5, w: 0.3, h: 0.3 }), false);

  console.log('geometry-math.verify: all assertions passed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
