import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import ffmpegPath from 'ffmpeg-static';
import { renderTimeline, setUploadsDirProvider } from '../../remotion/render.mjs';

const run = promisify(execFile);
const width = 160;
const height = 90;
const fps = 30;
const sourceRate = '30000/1001';
const frameCount = 60;
const scenarios = [
  { label: 'normal', srcInFrame: 0, playbackRate: 1 },
  { label: 'trimmed-2x', srcInFrame: 5, playbackRate: 2 },
];
const sourceFrameCount = Math.max(...scenarios.map(({ srcInFrame, playbackRate }) =>
  Math.ceil(frameCount * playbackRate) + srcInFrame + 2));
const frameBytes = width * height * 3;
const softwareH264 = {
  id: 'libx264',
  label: 'Software (libx264)',
  hardware: false,
  transport: 'server',
};

if (!ffmpegPath) throw new Error('ffmpeg-static binary unavailable');

async function decodeRgb(path) {
  const { stdout } = await run(ffmpegPath, [
    '-v', 'error',
    '-i', path,
    '-f', 'rawvideo',
    '-pix_fmt', 'rgb24',
    'pipe:1',
  ], { encoding: 'buffer', maxBuffer: frameBytes * frameCount * 2 });
  assert.equal(stdout.length, frameBytes * frameCount, `unexpected decoded byte count for ${path}`);
  return Array.from({ length: frameCount }, (_, index) =>
    stdout.subarray(index * frameBytes, (index + 1) * frameBytes));
}

function meanSquaredError(left, right, invertLeft = false) {
  let total = 0;
  let samples = 0;
  for (let index = 0; index < left.length; index += 12) {
    const leftValue = invertLeft ? 255 - left[index] : left[index];
    const delta = leftValue - right[index];
    total += delta * delta;
    samples += 1;
  }
  return total / samples;
}

const directory = await mkdtemp(join(tmpdir(), 'openchatcut-clip-fx-'));
try {
  const source = join(directory, 'source.mp4');
  await run(ffmpegPath, [
    '-v', 'error',
    '-f', 'lavfi',
    '-i', `testsrc2=size=${width}x${height}:rate=${sourceRate}:duration=${sourceFrameCount / fps}`,
    '-frames:v', String(sourceFrameCount),
    '-c:v', 'libx264',
    '-pix_fmt', 'yuv420p',
    source,
  ]);

  setUploadsDirProvider(() => directory);
  process.env.OPENCHATCUT_RENDER_CONCURRENCY = '8';
  process.env.OPENCHATCUT_DISABLE_HARDWARE_ENCODING = '1';

  for (const { label, srcInFrame, playbackRate } of scenarios) {
    const item = {
      id: 'clip-1',
      name: 'source.mp4',
      kind: 'video',
      src: '/media/uploads/source.mp4',
      track: 'V1',
      startFrame: 0,
      durationInFrames: frameCount,
      srcInFrame,
      playbackRate,
      width,
      height,
    };
    const state = {
      id: `clip-fx-export-verification-${label}`,
      fps,
      width,
      height,
      fit: 'contain',
      items: [item],
      tracks: { V1: { kind: 'video' } },
      trackOrder: ['V1'],
      selectedId: null,
      selectedIds: [],
      assets: [],
    };
    const baselinePath = join(directory, `baseline-${label}.mp4`);
    const effectPath = join(directory, `effect-${label}.mp4`);

    await renderTimeline({ state, outputLocation: baselinePath, codec: 'h264', h264Profile: softwareH264 });
    await renderTimeline({
      state: {
        ...state,
        items: [{
          ...item,
          effects: [{
            id: 'invert-regression',
            assetId: 'builtin:fx-invert',
          }],
        }],
      },
      outputLocation: effectPath,
      codec: 'h264',
      h264Profile: softwareH264,
    });

    const [baselineFrames, effectFrames] = await Promise.all([
      decodeRgb(baselinePath),
      decodeRgb(effectPath),
    ]);
    const mismatches = [];
    const sameFrameDistances = [];
    for (let outputFrame = 0; outputFrame < frameCount; outputFrame += 1) {
      assert.ok(
        meanSquaredError(effectFrames[outputFrame], baselineFrames[outputFrame]) > 1_000,
        `effect export frame ${outputFrame} did not apply the WebGL effect`,
      );
      sameFrameDistances.push(meanSquaredError(
        effectFrames[outputFrame],
        baselineFrames[outputFrame],
        true,
      ));
      let closestBaselineFrame = -1;
      let closestDistance = Number.POSITIVE_INFINITY;
      for (let baselineFrame = 0; baselineFrame < frameCount; baselineFrame += 1) {
        const distance = meanSquaredError(
          effectFrames[outputFrame],
          baselineFrames[baselineFrame],
          true,
        );
        if (distance < closestDistance) {
          closestDistance = distance;
          closestBaselineFrame = baselineFrame;
        }
      }
      if (closestBaselineFrame !== outputFrame) {
        mismatches.push({ outputFrame, closestBaselineFrame });
      }
    }

    assert.deepEqual(mismatches, [], `${label} effect export reused baseline frames: ${JSON.stringify(mismatches)}`);
    const maximumSameFrameDistance = Math.max(...sameFrameDistances);
    assert.ok(
      maximumSameFrameDistance < 500,
      `${label} effect export diverged from the inverse of its same-index baseline frame: ${maximumSameFrameDistance}`,
    );
    console.log(`clipFxExport.verify: ${frameCount}/${frameCount} ${label} fractional-rate effect frames are transformed and frame-accurate (max inverse MSE ${maximumSameFrameDistance.toFixed(2)})`);
  }
} finally {
  await rm(directory, { recursive: true, force: true });
}
