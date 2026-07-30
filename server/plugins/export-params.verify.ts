// Export resolution/frame rate parameter check: short side scaling, clamping, video-specific verification.
// Run with: npx tsx server/plugins/export-params.verify.ts (connected to npm test).
import assert from 'node:assert/strict';
import { exportScale, validateVideoParams } from './export.ts';
import { requestedVideoBitrateBps, resolveVideoBitrateBps } from '../../src/export/bitrate.ts';

// Short edge alignment: 1080p timeline → 480p = 480/1080; vertical screen 1080×1920 → 720p with short edge 1080
assert.equal(exportScale({ width: 1920, height: 1080 }, '480p'), 480 / 1080);
assert.equal(exportScale({ width: 1080, height: 1920 }, '720p'), 720 / 1080);
assert.equal(exportScale({ width: 1920, height: 1080 }, '1080p'), 1);
assert.equal(exportScale({ width: 1920, height: 1080 }, undefined), 1, '省略=不缩放');
// 720 Timeline selection 1080p = Magnification 1.5 (allowed); Clip upper limit 4
assert.equal(exportScale({ width: 1280, height: 720 }, '1080p'), 1.5);
assert.equal(exportScale({ width: 100, height: 100 }, '1080p'), 4, '上限夹 4');

validateVideoParams({ resolution: '720p', fps: 60, videoBitrate: 12_000_000 }, 'video');
validateVideoParams(null, 'audio');
assert.throws(() => validateVideoParams({ resolution: '720p' }, 'audio'), /video exports only/);
assert.throws(() => validateVideoParams({ fps: 60 }, 'audio'), /video exports only/);
assert.throws(() => validateVideoParams({ resolution: '4k' }, 'video'), /480p, 720p, or 1080p/);
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
