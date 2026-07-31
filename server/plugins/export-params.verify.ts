// Export resolution/frame rate parameter check: exact short-side scaling and video-specific verification.
// Run with: npx tsx server/plugins/export-params.verify.ts (connected to npm test).
import assert from 'node:assert/strict';
import { exportScale, validateVideoParams } from './export.ts';
import { requestedVideoBitrateBps, resolveVideoBitrateBps } from '../../src/export/bitrate.ts';

// Short-edge presets preserve orientation; 4K means a 2160 px short edge.
const scale480p = exportScale({ width: 1920, height: 1080 }, '480p');
assert.deepEqual([Math.round(1920 * scale480p), Math.round(1080 * scale480p)], [854, 480]);
assert.equal(exportScale({ width: 1080, height: 1920 }, '720p'), 720 / 1080);
assert.equal(exportScale({ width: 1920, height: 1080 }, '1080p'), 1);
assert.equal(exportScale({ width: 1920, height: 1080 }, '4k'), 2);
assert.equal(exportScale({ width: 1080, height: 1920 }, '4k'), 2);
assert.equal(exportScale({ width: 1920, height: 1080 }, undefined), 1, '省略=不缩放');
// Presets target their exact short edge even for unusually small timelines.
assert.equal(exportScale({ width: 1280, height: 720 }, '1080p'), 1.5);
assert.equal(exportScale({ width: 100, height: 100 }, '1080p'), 10.8);
assert.equal(exportScale({ width: 100, height: 100 }, '4k'), 21.6);
const upscaled480p = exportScale({ width: 854, height: 480 }, '4k');
assert.equal(Math.round(480 * upscaled480p), 2160);
assert.equal(Math.round(854 * upscaled480p) % 2, 0);
const portraitCustomScale = exportScale({ width: 100, height: 138 }, '4k');
assert.deepEqual(
  [Math.round(100 * portraitCustomScale), Math.round(138 * portraitCustomScale)],
  [2160, 2980],
);
const narrowCustomScale = exportScale({ width: 25, height: 45 }, '4k');
assert.deepEqual(
  [Math.round(25 * narrowCustomScale), Math.round(45 * narrowCustomScale)],
  [2160, 3888],
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

console.log('export params verification passed');
