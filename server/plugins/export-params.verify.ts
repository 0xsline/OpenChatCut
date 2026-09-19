// Export resolution/frame rate parameter check: exact short-side scaling and video-specific verification.
// Run with: npx tsx server/plugins/export-params.verify.ts (connected to npm test).
import assert from 'node:assert/strict';
import { exportScale, validateVideoParams } from './export.ts';
import { requestedVideoBitrateBps, resolveVideoBitrateBps } from '../../src/export/bitrate.ts';
import { exportFailureFrom } from '../../src/export/exportFailure.ts';
import { serverScaledExportDimensions } from '../../src/export/mediaSettings.ts';
import { planExport } from './export-plan';

const planState = {
  fps: 30, width: 1920, height: 1080, selectedId: null,
  items: [{ id: 'clip', name: 'clip', kind: 'video', track: 'V1', src: '/media/uploads/clip.mp4', startFrame: 0, durationInFrames: 120 }],
} as const;

// Short-edge presets preserve orientation; 4K means a 2160 px short edge.
// 854x480 is unreachable from 1920x1080 by any scale that lands both axes on
// an integer (854/16 is not whole), and Remotion rejects a fractional product
// outright — so 480p resolves to the nearest exactly-representable size.
const scale480p = exportScale({ width: 1920, height: 1080 }, '480p');
assert.deepEqual([1920 * scale480p, 1080 * scale480p], [864, 486]);
assert.equal(exportScale({ width: 1080, height: 1920 }, '720p'), 720 / 1080);
assert.equal(exportScale({ width: 1920, height: 1080 }, '1080p'), 1);
assert.equal(exportScale({ width: 1920, height: 1080 }, '4k'), 2);
assert.equal(exportScale({ width: 1080, height: 1920 }, '4k'), 2);
assert.equal(exportScale({ width: 1920, height: 1080 }, undefined), 1, '省略=不缩放');
// Presets target their exact short edge even for unusually small timelines,
// up to the scale both Remotion renderers accept (16): a 100 px canvas asked
// for 4k renders at 1600 px instead of throwing "scale must be <= 16".
assert.equal(exportScale({ width: 1280, height: 720 }, '1080p'), 1.5);
assert.equal(exportScale({ width: 100, height: 100 }, '1080p'), 10.8);
assert.equal(exportScale({ width: 100, height: 100 }, '4k'), 16);
assert.equal(exportScale({ width: 25, height: 45 }, '4k'), 16);

/** The local renderer's plan must be exact as JavaScript computes it, and even. */
function assertServerRenderable(source: { width: number; height: number }, resolution: '480p' | '720p' | '1080p' | '4k') {
  const plan = serverScaledExportDimensions(source, resolution);
  assert.equal(source.width * plan.scale, plan.width, `${source.width}x${source.height} ${resolution}: width product is exact`);
  assert.equal(source.height * plan.scale, plan.height, `${source.width}x${source.height} ${resolution}: height product is exact`);
  assert.equal(plan.width % 2, 0);
  assert.equal(plan.height % 2, 0);
  assert.ok(plan.scale <= 16);
  return plan;
}
assertServerRenderable({ width: 1920, height: 714 }, '4k');
assertServerRenderable({ width: 100, height: 138 }, '4k');
assertServerRenderable({ width: 1500, height: 800 }, '1080p');
// Square canvases: the nearest double to 480/1272 gives 480.00000000000006,
// so the exact scale has to be searched for, not derived.
assertServerRenderable({ width: 1272, height: 1272, }, '480p');
// The achievable sizes are even multiples of the reduced aspect ratio, which
// for a small gcd is a coarse grid: 1366x768 (gcd 2) can only render at integer
// scales, so "480p" has no exact size within reach and the plan says so
// instead of quietly rendering the canvas at 1x.
assert.equal(serverScaledExportDimensions({ width: 1920, height: 1080 }, '480p').representable, true);
assert.equal(serverScaledExportDimensions({ width: 1366, height: 768 }, '480p').representable, false);
assert.equal(serverScaledExportDimensions({ width: 1000, height: 563 }, '480p').representable, false);
assert.equal(serverScaledExportDimensions({ width: 750, height: 1334 }, '1080p').representable, false);
assert.equal(serverScaledExportDimensions({ width: 1366, height: 768 }, '4k').representable, true);
// Ties between two equally distant exact scales prefer the one a hardware
// H.264 encoder can still take (both sides within 4096).
const tied = assertServerRenderable({ width: 854, height: 480 }, '4k');
assert.deepEqual([tied.width, tied.height], [3416, 1920]);
assert.equal(tied.representable, false, '11% off the preset is a different resolution');
// A video export the local renderer cannot honour fails preflight with a code
// the client can act on, rather than reaching Remotion's integer check.
assert.throws(
  () => planExport({ state: { ...planState, width: 1366, height: 768 }, format: 'video', codec: 'h264', resolution: '480p' }),
  (error: unknown) => exportFailureFrom(error)?.code === 'export_resolution_unsupported'
    && exportFailureFrom(error)?.stage === 'preflight',
);

validateVideoParams({ resolution: '4k', fps: 60, videoBitrate: 40_000_000 }, 'video');
validateVideoParams(null, 'audio');
assert.throws(() => validateVideoParams({ resolution: '720p' }, 'audio'), /video exports only/);
assert.throws(() => validateVideoParams({ fps: 60 }, 'audio'), /video exports only/);
assert.throws(() => validateVideoParams({ resolution: '8k' }, 'video'), /480p, 720p, 1080p, or 4k/);
assert.throws(() => validateVideoParams({ resolution: 'constructor' }, 'video'), /480p, 720p, 1080p, or 4k/);
assert.throws(() => validateVideoParams({ fps: 29.97 }, 'video'), /24, 25, 30, 50, or 60/);
assert.throws(() => validateVideoParams({ videoBitrate: 12_000_000 }, 'audio'), /video exports only/);
assert.throws(() => validateVideoParams({ videoBitrate: 999_999 }, 'video'), /between 1000000 and 80000000/);
assert.throws(() => validateVideoParams({ videoBitrate: 12_500_000.5 }, 'video'), /integer/);

const bitrateInput = { width: 1920, height: 1080, fps: 30, customMbps: 12 } as const;
assert.equal(resolveVideoBitrateBps({ ...bitrateInput, mode: 'recommended' }), 10_000_000);
assert.equal(resolveVideoBitrateBps({ ...bitrateInput, mode: 'compact' }), 6_500_000);
assert.equal(resolveVideoBitrateBps({ ...bitrateInput, mode: 'high' }), 15_000_000);
assert.equal(resolveVideoBitrateBps({ ...bitrateInput, mode: 'custom' }), 12_000_000);
assert.equal(requestedVideoBitrateBps({ ...bitrateInput, mode: 'auto' }), undefined);

// FFmpeg's fps filter resamples frames without changing presentation duration.
for (const fps of [24, 30, 60]) {
  const plan = planExport({
    fps,
    state: {
      fps: 30, width: 1920, height: 1080, selectedId: null,
      items: [{ id: 'clip', name: 'clip', kind: 'video', track: 'V1', src: '/media/uploads/clip.mp4', startFrame: 0, durationInFrames: 120 }],
    },
  });
  assert.equal(plan.durationSeconds, 4, `30 to ${fps} fps must retain the 4s duration`);
}

console.log('export params verification passed');
