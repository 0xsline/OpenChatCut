// Browser MediaRecorder WebM (Meet, Zoom web, Loom, ...) must be detected and
// normalized on import. The fixture is synthetic: three VP8 segments of
// growing size, irregular millisecond timestamps and one keyframe per segment,
// muxed without a frame duration, so ffprobe reports what it reports for a
// real recording: avg_frame_rate 0/0, r_frame_rate 1000/1 and the first
// segment's size only.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ffmpegBin, ffprobeBin } from './media-binaries.ts';
import {
  encodeTranscodedVideo,
  isVariableFrameRate,
  normalizeReason,
  parseFrameRate,
  probeVideo,
  resolveStreamPlan,
  resolveTargetFps,
  summarizeKeyframes,
} from './media-normalization.ts';
import { normalizeMediaFile } from './media-normalization-runner.ts';

const SEGMENT_SECONDS = 5;
const SIZES = ['320x180', '640x360', '1280x720'] as const;

function runTool(binary: string, args: string[]): string {
  const result = spawnSync(binary, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  assert.equal(result.status, 0, `${binary} ${args.join(' ')} failed: ${result.error?.message ?? result.stderr}`);
  return result.stdout;
}

function ffprobeJson(path: string, args: string[]): Record<string, unknown> {
  return JSON.parse(runTool(ffprobeBin(), ['-v', 'error', ...args, '-of', 'json', path])) as Record<string, unknown>;
}

/** Overwrite the track's DefaultDuration element with an EBML Void of equal
 * length. MediaRecorder never writes one; ffmpeg's muxer always does. */
function stripDefaultDuration(bytes: Buffer): Buffer {
  const id = Buffer.from([0x23, 0xe3, 0x83]);
  const at = bytes.indexOf(id);
  assert.ok(at >= 0, 'fixture should contain a DefaultDuration element to strip');
  const sizeByte = bytes[at + 3]!;
  assert.ok(sizeByte & 0x80, 'DefaultDuration size should use a one-byte EBML length');
  const total = id.length + 1 + (sizeByte & 0x7f);
  const out = Buffer.from(bytes);
  out[at] = 0xec;
  out[at + 1] = 0x80 | (total - 2);
  out.fill(0, at + 2, at + total);
  return out;
}

async function makeBrowserRecording(dir: string): Promise<string> {
  const segments: string[] = [];
  for (const [index, size] of SIZES.entries()) {
    const segment = join(dir, `segment-${index}.ivf`);
    runTool(ffmpegBin(), [
      '-v', 'error', '-y', '-f', 'lavfi',
      '-i', `testsrc2=size=${size}:rate=30:duration=${SEGMENT_SECONDS}`,
      // Irregular 18-48 ms frame gaps so no frame rate fits the timestamps.
      '-vf', "settb=1/1000,setpts='floor(N*33.3+15*sin(N*1.7))/1000/TB'",
      '-fps_mode', 'passthrough', '-enc_time_base', '1/1000',
      '-c:v', 'libvpx', '-g', '1000', '-b:v', '300k', segment,
    ]);
    segments.push(segment);
  }
  const list = join(dir, 'segments.ffconcat');
  await writeFile(list, [
    'ffconcat version 1.0',
    ...segments.flatMap((segment) => [`file '${segment.replaceAll("'", "'\\''")}'`, `duration ${SEGMENT_SECONDS}`]),
    '',
  ].join('\n'));
  const muxed = join(dir, 'muxed.webm');
  runTool(ffmpegBin(), ['-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', muxed]);
  const recording = join(dir, 'meet-recording.webm');
  await writeFile(recording, stripDefaultDuration(await readFile(muxed)));
  return recording;
}

// Frame-rate rules.
assert.equal(parseFrameRate('0/0'), undefined);
assert.equal(isVariableFrameRate(undefined, 1000), true, 'missing avg with a 1000/1 timebase rate is VFR');
assert.equal(isVariableFrameRate(undefined, 240), false, '240 fps slow motion is a real rate, not a timebase');
assert.equal(isVariableFrameRate(240, 240), false);
assert.equal(isVariableFrameRate(undefined, 30), false);
assert.equal(resolveTargetFps(undefined, undefined, 1000), 30, 'timebase-only sources target 30 fps, not 120');
assert.equal(resolveTargetFps(60, undefined, 1000, true), 60, 'an explicit target still wins');
assert.equal(resolveTargetFps(undefined, 29.97, 30), 29.97);

// Keyframe summary: largest size wins, rotation is applied, gaps are measured
// over the whole file when it was scanned whole.
{
  const frames = [
    { best_effort_timestamp_time: '0.000', width: 320, height: 180 },
    { best_effort_timestamp_time: '9.000', width: 1280, height: 720 },
    { best_effort_timestamp_time: '18.000', width: 640, height: 360 },
  ];
  const summary = summarizeKeyframes(frames, 0, 20, true);
  assert.deepEqual(summary.largest, { width: 1280, height: 720 });
  assert.equal(summary.sizes.length, 3);
  assert.equal(summary.longGop, true);
  assert.deepEqual(summarizeKeyframes(frames, 90, 20, true).largest, { width: 720, height: 1280 });
  const regular = Array.from({ length: 21 }, (_, second) => ({
    best_effort_timestamp_time: String(second), width: 1920, height: 1080,
  }));
  const steady = summarizeKeyframes(regular, 0, 20, true);
  assert.equal(steady.longGop, false);
  assert.equal(steady.sizes.length, 1);
  assert.equal(summarizeKeyframes(frames, 0, 0, true).longGop, true, 'a file without duration is bounded by its last keyframe');
}

// Transcode arguments: no filter-graph rebuild on size change, and forced
// keyframes when the source GOP is long.
{
  const captured: string[][] = [];
  const outputPath = join(tmpdir(), 'openchatcut-browser-recording-unwritten.mp4');
  await encodeTranscodedVideo(
    ffmpegBin(),
    { inputPath: 'browser.webm', hasAudio: false },
    [],
    [outputPath],
    { targetW: 1280, targetH: 720, targetBitrate: 4_000_000, targetFps: 30, convertToCfr: true, forceKeyframes: true },
    outputPath,
    { preferred: 'libx264', resolveDecodeArgs: async () => [], runFfmpeg: async (args) => { captured.push(args); } },
  );
  const [args] = captured;
  assert.ok(args, 'the transcode should run once');
  const reinit = args.indexOf('-reinit_filter');
  assert.ok(reinit >= 0 && args[reinit + 1] === '0', '-reinit_filter 0 must be passed');
  assert.ok(reinit < args.indexOf('-i'), '-reinit_filter is an input option and must precede -i');
  assert.equal(args[args.indexOf('-force_key_frames') + 1], 'expr:gte(t,n_forced*1)');
}

const testDir = await mkdtemp(join(tmpdir(), 'openchatcut-browser-recording-'));
try {
  const recording = await makeBrowserRecording(testDir);

  // The fixture reproduces the real recording's stream header.
  const header = ffprobeJson(recording, ['-select_streams', 'v:0', '-show_streams']);
  const stream = (header.streams as Array<Record<string, unknown>>)[0]!;
  assert.equal(stream.codec_name, 'vp8');
  assert.equal(stream.avg_frame_rate, '0/0');
  assert.equal(stream.r_frame_rate, '1000/1');
  assert.equal(stream.width, 320, 'stream header reports the first frame only');
  assert.equal(stream.height, 180);

  const meta = await probeVideo(recording);
  assert.equal(meta.variableFrameRate, true);
  assert.equal(meta.width, 1280, 'probe reports the largest size seen');
  assert.equal(meta.height, 720);
  assert.deepEqual(meta.resolutionChanges?.map((size) => `${size.width}x${size.height}`), [...SIZES]);
  assert.equal(meta.longGop, true, 'one keyframe per 5 s segment is a long GOP');
  assert.equal(resolveTargetFps(undefined, meta.avgFrameRate, meta.nominalFrameRate), 30);
  assert.equal(resolveStreamPlan(meta, false, false).transcodeVideo, true, 'size changes cannot be stream-copied');

  const reason = normalizeReason(meta, 4_000_000, false, false) ?? '';
  assert.match(reason, /variable frame rate/);
  assert.match(reason, /resolution changes mid-stream \(320x180 -> 640x360 -> 1280x720\)/);

  // End to end: a plain import normalizes it to steady 1280x720 / 30 fps with
  // a keyframe every second.
  const outputPath = join(testDir, 'meet-recording.mp4');
  const result = await normalizeMediaFile({
    inputPath: recording,
    publicSrc: '/media/uploads/meet-recording.webm',
    outputPath,
    preserveInput: true,
    uploadsDirectory: testDir,
  });
  assert.equal(result.normalized, true);
  assert.equal(result.width, 1280);
  assert.equal(result.height, 720);
  assert.equal(result.variableFrameRate, false);

  const output = ffprobeJson(outputPath, [
    '-select_streams', 'v:0', '-count_frames',
    '-show_entries', 'stream=width,height,avg_frame_rate,nb_read_frames:format=duration',
  ]);
  const outStream = (output.streams as Array<Record<string, unknown>>)[0]!;
  assert.equal(outStream.avg_frame_rate, '30/1');
  const expectedFrames = SIZES.length * SEGMENT_SECONDS * 30;
  // Without -reinit_filter 0 each size switch rebuilds the fps filter and the
  // output gains frames (452 for this fixture).
  assert.ok(
    Math.abs(Number(outStream.nb_read_frames) - expectedFrames) <= 1,
    `expected ~${expectedFrames} frames across the size switches, got ${String(outStream.nb_read_frames)}`,
  );
  const keyframes = ffprobeJson(outputPath, [
    '-select_streams', 'v:0', '-skip_frame', 'nokey', '-show_frames',
    '-show_entries', 'frame=best_effort_timestamp_time',
  ]);
  const times = (keyframes.frames as Array<{ best_effort_timestamp_time: string }>)
    .map((frame) => Number(frame.best_effort_timestamp_time));
  const largestGap = Math.max(...times.slice(1).map((time, index) => time - times[index]!));
  assert.ok(times.length >= SIZES.length * SEGMENT_SECONDS, `expected a keyframe per second, got ${times.length}`);
  assert.ok(largestGap <= 1.1, `keyframe gap ${largestGap.toFixed(3)} s exceeds the forced 1 s interval`);
} finally {
  await rm(testDir, { recursive: true, force: true });
}

console.log('browser recording normalization verification passed');
