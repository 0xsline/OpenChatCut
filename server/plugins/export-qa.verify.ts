import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ffmpegBin } from '../media-binaries.ts';
import { analyzeExportFile } from './export-qa.ts';

function run(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => { stderr += String(chunk); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exit ${code}: ${stderr.slice(-600)}`));
    });
  });
}

const work = await mkdtemp(join(tmpdir(), 'occ-export-qa-verify-'));
try {
  const file = join(work, 'sample.mp4');
  await run(ffmpegBin(), [
    '-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'color=c=blue:s=320x180:r=30:d=1',
    '-f', 'lavfi', '-i', 'color=c=red:s=320x180:r=30:d=1',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=2',
    '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0[v]',
    '-map', '[v]', '-map', '2:a:0',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest',
    file,
  ]);
  assert.ok((await stat(file)).size > 0);

  const result = await analyzeExportFile(file, {
    durationSeconds: 2,
    width: 320,
    height: 180,
    fps: 30,
    expectsAudio: true,
    cutTimesSeconds: [1],
    maxEvidenceCuts: 1,
  });
  assert.equal(result.report.hasVideo, true);
  assert.equal(result.report.hasAudio, true);
  assert.equal(result.report.width, 320);
  assert.equal(result.report.height, 180);
  assert.equal(result.report.summary.errors, 0);
  assert.ok(result.evidence.base64 && result.evidence.base64.length > 100);
  assert.equal(result.evidence.samples.length, 2);
  console.log('export QA integration checks passed');
} finally {
  await rm(work, { recursive: true, force: true });
}
