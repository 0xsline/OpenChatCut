import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ffmpegBin } from '../media-binaries.ts';
import { detectScenesInFile } from './scene-detection.ts';
import { normalizeSceneCandidates, parseSceneMetadata } from '../../src/scene-detection/detect.ts';

function run(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => { stderr += String(chunk); });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve() : reject(new Error(stderr.slice(-800))));
  });
}

const parsed = parseSceneMetadata([
  'frame:0 pts:1000 pts_time:1',
  'lavfi.scene_score=0.42',
  'frame:1 pts:1100 pts_time:1.1',
  'lavfi.scene_score=0.35',
].join('\n'));
assert.deepEqual(parsed, [{ timeMs: 1000, score: 0.42 }, { timeMs: 1100, score: 0.35 }]);
assert.deepEqual(normalizeSceneCandidates(parsed, {
  threshold: 0.3, minSceneMs: 500, durationMs: 3000,
}), [{ timeMs: 1000, score: 0.42, kind: 'cut' }]);

const work = await mkdtemp(join(tmpdir(), 'openchatcut-scene-verify-'));
try {
  const video = join(work, 'cuts.mp4');
  await run(ffmpegBin(), [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'color=c=red:s=320x180:d=1:r=10',
    '-f', 'lavfi', '-i', 'color=c=blue:s=320x180:d=1:r=10',
    '-f', 'lavfi', '-i', 'color=c=green:s=320x180:d=1:r=10',
    '-filter_complex', '[0:v][1:v][2:v]concat=n=3:v=1:a=0',
    video,
  ]);
  const result = await detectScenesInFile(video, { threshold: 0.2, minSceneMs: 500 });
  assert.equal(result.scenes.length, 2);
  assert.ok(Math.abs(result.scenes[0]!.timeMs - 1000) <= 100);
  assert.ok(Math.abs(result.scenes[1]!.timeMs - 2000) <= 100);
  console.log('scene-detection.verify: ok');
} finally {
  await rm(work, { recursive: true, force: true });
}
