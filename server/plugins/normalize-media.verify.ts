import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { ffmpegBin, ffprobeBin } from '../media-binaries.ts';
import {
  isVariableFrameRate,
  parseFrameRate,
  playableDurationSeconds,
  resolveTargetFps,
} from './normalize-media.ts';

assert.equal(parseFrameRate('30/1'), 30);
assert.ok(Math.abs((parseFrameRate('30000/1001') ?? 0) - 29.97002997) < 0.000001);
assert.equal(parseFrameRate('0/0'), undefined);
assert.equal(parseFrameRate('N/A'), undefined);

assert.equal(isVariableFrameRate(30, 30), false);
assert.equal(isVariableFrameRate(30000 / 1001, 30000 / 1001), false);
assert.equal(isVariableFrameRate(29.97, 30), true);
assert.equal(isVariableFrameRate(24, 30), true);

assert.equal(resolveTargetFps(24, 29.97, 30), 24);
assert.equal(resolveTargetFps(0, 29.97, 30), 30);
assert.equal(resolveTargetFps(undefined, 59.94, 60), 60);
assert.equal(resolveTargetFps(undefined, undefined, undefined), 30);
assert.equal(playableDurationSeconds({ duration: 3.934, frameCount: 116, avgFrameRate: 30 }), 116 / 30);
assert.equal(playableDurationSeconds({ duration: 3.934 }), 3.934);

for (const [name, binary] of [['ffmpeg', ffmpegBin()], ['ffprobe', ffprobeBin()]]) {
  const result = spawnSync(binary, ['-version'], { encoding: 'utf8' });
  assert.equal(result.status, 0, `${name} binary is not executable: ${result.error?.message ?? result.stderr}`);
}

console.log('normalize-media verification passed');
