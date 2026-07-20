// 导出分辨率/帧率参数检查:短边缩放、夹取、视频专用校验。
// 跑法:node --experimental-strip-types server/plugins/export-params.check.ts(check:generation 链)。
import assert from 'node:assert/strict';
import { exportScale, validateVideoParams } from './export.ts';

// 短边对齐:1080p 时间线 → 480p = 480/1080;竖屏 1080×1920 → 720p 用短边 1080
assert.equal(exportScale({ width: 1920, height: 1080 }, '480p'), 480 / 1080);
assert.equal(exportScale({ width: 1080, height: 1920 }, '720p'), 720 / 1080);
assert.equal(exportScale({ width: 1920, height: 1080 }, '1080p'), 1);
assert.equal(exportScale({ width: 1920, height: 1080 }, undefined), 1, '省略=不缩放');
// 720 时间线选 1080p = 放大 1.5(允许);夹取上限 4
assert.equal(exportScale({ width: 1280, height: 720 }, '1080p'), 1.5);
assert.equal(exportScale({ width: 100, height: 100 }, '1080p'), 4, '上限夹 4');

validateVideoParams({ resolution: '720p', fps: 60 }, 'video');
validateVideoParams(null, 'audio');
assert.throws(() => validateVideoParams({ resolution: '720p' }, 'audio'), /video exports only/);
assert.throws(() => validateVideoParams({ fps: 60 }, 'audio'), /video exports only/);
assert.throws(() => validateVideoParams({ resolution: '4k' }, 'video'), /480p, 720p, or 1080p/);
assert.throws(() => validateVideoParams({ fps: 29.97 }, 'video'), /24, 25, 30, 50, or 60/);

console.log('export-params.check: ok (short-side scale + video-only gates)');
