import assert from 'node:assert/strict';
import { focalFramesFromGeometry } from './geometry-focus';
import type { VisualGeometryAsset } from '../geometry/visual-geometry';

const geometry = (segments: VisualGeometryAsset['segments']): VisualGeometryAsset => ({
  assetId: 'a',
  sourceRevision: 'r',
  algorithmVersion: 'v',
  durationSec: 30,
  segments,
});

async function main(): Promise<void> {
  const FPS = 30;
  const asset = geometry([
    { startSec: 0, endSec: 10, person: 'left', zone: { rects: [], face: null, subject: { x: 0.1, y: 0.2, w: 0.2, h: 0.3 } } },
    { startSec: 10, endSec: 20, person: 'right', zone: { rects: [], face: null, subject: { x: 0.7, y: 0.2, w: 0.2, h: 0.3 } } },
    { startSec: 20, endSec: 30, person: 'none', zone: { rects: [], face: null, subject: null } },
  ]);

  // 1. Frames map to their segment's subject center.
  const kfs = focalFramesFromGeometry(asset, 900, FPS, {
    intervalFrames: 15,
    maxSamples: 100,
    smooth: 0,
  });
  assert.equal(kfs.length, Math.ceil(900 / 15) + 1, 'sampled every interval + terminal frame');
  const early = kfs.find((k) => k.frame < 150)!;
  const middle = kfs.find((k) => k.frame >= 300 && k.frame < 450)!;
  const late = kfs.find((k) => k.frame >= 600)!;
  assert.ok(Math.abs(early.focalPointX - 0.2) < 1e-6, 'left segment subject center x=0.1+0.1');
  assert.ok(Math.abs(early.focalPointY - 0.35) < 1e-6, 'subject center y=0.2+0.15');
  assert.ok(Math.abs(middle.focalPointX - 0.8) < 1e-6, 'right segment subject center');
  assert.deepEqual({ x: late.focalPointX, y: late.focalPointY }, { x: 0.5, y: 0.5 }, 'no-subject segment falls back to frame center');

  // 2. srcInFrame shifts the source-time mapping.
  const shifted = focalFramesFromGeometry(asset, 300, FPS, {
    srcInFrame: 300,
    intervalFrames: 15,
    maxSamples: 100,
    smooth: 0,
  });
  // Frame 0 with srcInFrame=300 → source sec 10 → right segment.
  assert.ok(Math.abs(shifted[0]!.focalPointX - 0.8) < 1e-6, 'srcInFrame offset lands in the right segment');

  // 3. playbackRate scales source time.
  const slowed = focalFramesFromGeometry(asset, 660, FPS, {
    playbackRate: 0.5,
    intervalFrames: 15,
    maxSamples: 100,
    smooth: 0,
  });
  // Frame 0 at 0.5× → source sec 0 → left segment; frame 450 → source sec 7.5 → left; frame 600 → source sec 10 → right.
  assert.ok(Math.abs(slowed.find((k) => k.frame === 0)!.focalPointX - 0.2) < 1e-6);
  assert.ok(Math.abs(slowed.find((k) => k.frame === 450)!.focalPointX - 0.2) < 1e-6, '0.5× keeps frame 450 in the left segment');
  assert.ok(Math.abs(slowed.find((k) => k.frame === 600)!.focalPointX - 0.8) < 1e-6, 'frame 600 reaches source sec 10');

  // 4. Face center is used when no subject.
  const faceOnly = geometry([
    { startSec: 0, endSec: 10, person: 'center', zone: { rects: [], face: { x: 0.4, y: 0.1, w: 0.2, h: 0.2 }, subject: null } },
  ]);
  const faceKfs = focalFramesFromGeometry(faceOnly, 150, FPS, { smooth: 0 });
  assert.ok(Math.abs(faceKfs[0]!.focalPointX - 0.5) < 1e-6, 'face center x');
  assert.ok(Math.abs(faceKfs[0]!.focalPointY - 0.2) < 1e-6, 'face center y');

  // 5. Duration end frame is always included.
  const endKfs = focalFramesFromGeometry(asset, 100, FPS, {
    intervalFrames: 30,
    maxSamples: 100,
    smooth: 0,
  });
  assert.equal(endKfs[endKfs.length - 1]!.frame, 99, 'last frame included');

  // 6. Long clips respect the sample cap and carry the aspect crop.
  const capped = focalFramesFromGeometry(asset, 216_000, FPS, {
    intervalFrames: 1,
    maxSamples: 4,
    smooth: 0,
    magnification: 3.16,
  });
  assert.equal(capped.length, 4, 'geometry path obeys maxSamples');
  assert.ok(capped.every((keyframe) => keyframe.magnification === 3.16));

  // 7. Geometry paths honor temporal smoothing.
  const raw = focalFramesFromGeometry(asset, 601, FPS, {
    intervalFrames: 300,
    maxSamples: 10,
    smooth: 0,
  });
  const smoothed = focalFramesFromGeometry(asset, 601, FPS, {
    intervalFrames: 300,
    maxSamples: 10,
    smooth: 0.5,
  });
  assert.ok(Math.abs(raw[1]!.focalPointX - 0.8) < 1e-6);
  assert.ok(smoothed[1]!.focalPointX > 0.2 && smoothed[1]!.focalPointX < 0.8);

  console.log('geometry-focus.verify: all assertions passed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
