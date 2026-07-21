import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ffmpegBin } from '../media-binaries.ts';
import {
  addSceneEvidence,
  detectScenesInFile,
  parseProgressTimeMs,
  sceneAnalysisFps,
} from './scene-detection.ts';
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
assert.equal(parseProgressTimeMs('out_time_us=1500000'), 1500);
assert.equal(parseProgressTimeMs('out_time_ms=2500000'), 2500);
assert.equal(parseProgressTimeMs('out_time=00:01:02.500000'), 62_500);
assert.equal(parseProgressTimeMs('progress=continue'), null);
assert.equal(sceneAnalysisFps(3_600_000), 10);
assert.equal(sceneAnalysisFps(36_000_000), 1);
assert.equal(sceneAnalysisFps(1_000), 12);
assert.deepEqual(addSceneEvidence('/media/uploads/cuts.mp4', [{
  timeMs: 1000, score: 0.42, kind: 'cut',
}], 3000), [{
  timeMs: 1000,
  score: 0.42,
  kind: 'cut',
  beforeTimeMs: 800,
  afterTimeMs: 1200,
  beforeThumbnailUrl: '/api/detect-scenes/frame?src=%2Fmedia%2Fuploads%2Fcuts.mp4&timeMs=800',
  afterThumbnailUrl: '/api/detect-scenes/frame?src=%2Fmedia%2Fuploads%2Fcuts.mp4&timeMs=1200',
}]);

const work = await mkdtemp(join(tmpdir(), 'openchatcut-scene-verify-'));
try {
  const video = join(work, 'cuts.mp4');
  const motionVideo = join(work, 'continuous-motion.mp4');
  await run(ffmpegBin(), [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'color=c=red:s=320x180:d=1:r=10',
    '-f', 'lavfi', '-i', 'color=c=blue:s=320x180:d=1:r=10',
    '-f', 'lavfi', '-i', 'color=c=green:s=320x180:d=1:r=10',
    '-filter_complex', '[0:v][1:v][2:v]concat=n=3:v=1:a=0',
    video,
  ]);
  await run(ffmpegBin(), [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=s=320x180:d=3:r=30',
    motionVideo,
  ]);
  const progress: Array<{ phase: string; progress: number; processedMs: number }> = [];
  const result = await detectScenesInFile(video, {
    threshold: 0.2,
    minSceneMs: 500,
    onProgress: (update) => progress.push(update),
  });
  assert.equal(result.scenes.length, 2);
  assert.equal(result.sampleFps, 12);
  assert.ok(Math.abs(result.scenes[0]!.timeMs - 1000) <= 100);
  assert.ok(Math.abs(result.scenes[1]!.timeMs - 2000) <= 100);
  assert.equal(progress[0]!.phase, 'probing');
  assert.ok(progress.some((update) => update.phase === 'detecting'));
  assert.ok(progress.some((update) => update.phase === 'detecting' && update.processedMs > 0));
  assert.equal(progress.at(-1)!.phase, 'finalizing');
  assert.equal(progress.at(-1)!.processedMs, result.durationMs);

  const cancelled = new AbortController();
  cancelled.abort();
  await assert.rejects(
    () => detectScenesInFile(video, { signal: cancelled.signal }),
    (error: unknown) => error instanceof Error && error.name === 'AbortError',
  );

  const continuousMotion = await detectScenesInFile(motionVideo, {
    threshold: 0.3,
    minSceneMs: 500,
  });
  assert.equal(continuousMotion.scenes.length, 0);
  console.log('scene-detection.verify: ok');
} finally {
  await rm(work, { recursive: true, force: true });
}
