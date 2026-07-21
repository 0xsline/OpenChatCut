import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ffmpegBin } from '../media-binaries.ts';
import { analyzeColorInFile, autoGradeSampleFps, parseSignalStats } from './auto-grade.ts';

function run(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => { stderr += String(chunk); });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve() : reject(new Error(stderr.slice(-1000))));
  });
}

assert.deepEqual(parseSignalStats([
  'frame:0    pts:0       pts_time:0',
  'lavfi.signalstats.YMIN=16',
  'lavfi.signalstats.YLOW=24',
  'lavfi.signalstats.YAVG=128.5',
  'lavfi.signalstats.YHIGH=228',
  'lavfi.signalstats.YMAX=235',
  'lavfi.signalstats.SATAVG=62.25',
].join('\n')), [{
  yMin: 16,
  yLow: 24,
  yAverage: 128.5,
  yHigh: 228,
  yMax: 235,
  saturationAverage: 62.25,
}]);

assert.equal(autoGradeSampleFps(1), 10);
assert.equal(autoGradeSampleFps(20), 0.5);
assert.ok(Math.abs(autoGradeSampleFps(230) - (10 / 230)) < 0.000001);

const work = await mkdtemp(join(tmpdir(), 'openchatcut-auto-grade-'));
try {
  const eightBit = join(work, 'eight-bit.mkv');
  const tenBit = join(work, 'ten-bit.mkv');
  await run(ffmpegBin(), [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'color=c=#707070:s=96x64:d=1:r=10',
    '-pix_fmt', 'yuv420p', '-c:v', 'ffv1', eightBit,
  ]);
  await run(ffmpegBin(), [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'color=c=#707070:s=96x64:d=1:r=10',
    '-vf', 'format=yuv420p10le', '-c:v', 'ffv1', tenBit,
  ]);

  const sdr8 = await analyzeColorInFile(eightBit);
  const sdr10 = await analyzeColorInFile(tenBit);
  assert.equal(sdr8.profile.bitDepth, 8);
  assert.equal(sdr10.profile.bitDepth, 10);
  assert.equal(sdr8.stats.sampleCount, 10);
  assert.equal(sdr10.stats.sampleCount, 10);
  assert.ok(Math.abs(sdr8.stats.yMean - sdr10.stats.yMean) < 0.01);
  assert.ok(Math.abs(sdr8.stats.saturationMean - sdr10.stats.saturationMean) < 0.01);
  assert.deepEqual(Object.keys(sdr8.filters).sort(), ['brightness', 'contrast', 'saturate']);
  console.log('auto-grade.verify: ok');
} finally {
  await rm(work, { recursive: true, force: true });
}
