import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ffmpegBin } from '../server/media-binaries.ts';
import { decodePcm, extractPcm, pcmExtractionArgs } from './native-asr-pcm.ts';

const SAMPLE_RATE = 16_000;
const ffmpeg = ffmpegBin();
const dir = await mkdtemp(join(tmpdir(), 'occ-native-pcm-'));

function generate(path: string, args: readonly string[]): void {
  execFileSync(ffmpeg, ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y', ...args, path], {
    stdio: 'pipe',
  });
}

/** Offset of the first top-level ISO-BMFF box of the given type, or -1. */
function topLevelBoxOffset(bytes: Buffer, type: string): number {
  let offset = 0;
  while (offset + 8 <= bytes.length) {
    const size32 = bytes.readUInt32BE(offset);
    if (bytes.toString('latin1', offset + 4, offset + 8) === type) return offset;
    const size = size32 === 1 ? Number(bytes.readBigUInt64BE(offset + 8)) : size32;
    if (size < 8) return -1;
    offset += size;
  }
  return -1;
}

try {
  // #167: an MP4 whose moov atom follows mdat (FFmpeg's default without
  // +faststart, and common for camera files) must decode. Noise keeps mdat
  // incompressible (~5 MB), far beyond the ~32 KiB FFmpeg keeps buffered for a
  // non-seekable input, so this fixture yields zero samples through stdin. The path
  // also carries spaces and non-ASCII characters, as user media often does.
  const tailMoov = join(dir, '测 试 clip.mp4');
  generate(tailMoov, [
    '-f', 'lavfi', '-i', 'color=size=320x180:rate=30:duration=2,noise=alls=100:allf=t',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
    '-c:v', 'mpeg4', '-q:v', '1', '-c:a', 'aac', '-shortest',
  ]);
  const bytes = await readFile(tailMoov);
  const mdat = topLevelBoxOffset(bytes, 'mdat');
  const moov = topLevelBoxOffset(bytes, 'moov');
  assert.ok(mdat >= 0 && moov > mdat, 'fixture keeps moov after mdat, the layout a pipe cannot demux');
  const samples = await extractPcm(ffmpeg, tailMoov, SAMPLE_RATE);
  assert.ok(
    Math.abs(samples.length - 2 * SAMPLE_RATE) < SAMPLE_RATE / 10,
    `decodes about 2 s of 16 kHz mono audio (got ${samples.length} samples)`,
  );
  assert.ok(samples.some((sample) => Math.abs(sample) > 0.1), 'decoded samples carry the tone, not silence');

  // A source without audio rejects with FFmpeg's reason instead of crashing the worker.
  const videoOnly = join(dir, 'video-only.mp4');
  generate(videoOnly, ['-f', 'lavfi', '-i', 'testsrc=duration=1:size=64x64:rate=10', '-c:v', 'mpeg4']);
  await assert.rejects(
    extractPcm(ffmpeg, videoOnly, SAMPLE_RATE),
    (error: Error) => /FFmpeg PCM extraction failed/.test(error.message) && /0:a:0/.test(error.message),
    'a video-only source rejects and names the missing audio stream',
  );

  const junk = join(dir, 'junk.mp4');
  await writeFile(junk, 'not a media file');
  await assert.rejects(extractPcm(ffmpeg, junk, SAMPLE_RATE), /FFmpeg PCM extraction failed/,
    'unreadable input rejects');

  if (process.platform !== 'win32') {
    // FFmpeg can exit 0 without producing audio (the original #167 symptom).
    // That must reject; throwing from the close listener killed the process.
    const silentFfmpeg = join(dir, 'fake-ffmpeg.sh');
    await writeFile(silentFfmpeg, '#!/bin/sh\necho "partial file" 1>&2\nexit 0\n');
    await chmod(silentFfmpeg, 0o755);
    await assert.rejects(
      extractPcm(silentFfmpeg, tailMoov, SAMPLE_RATE),
      (error: Error) => /invalid PCM audio/.test(error.message) && /partial file/.test(error.message),
      'an empty decode rejects with FFmpeg stderr attached',
    );
  }
} finally {
  await rm(dir, { recursive: true, force: true });
}

const args = pcmExtractionArgs('/media/uploads/clip.mp4', SAMPLE_RATE);
assert.ok(!args.includes('pipe:0'), 'the source is never streamed through stdin');
assert.deepEqual(
  args.slice(args.indexOf('-protocol_whitelist'), args.indexOf('-protocol_whitelist') + 4),
  ['-protocol_whitelist', 'file', '-i', 'file:/media/uploads/clip.mp4'],
  'FFmpeg opens the file itself, restricted to the file protocol',
);

assert.throws(() => decodePcm([], 0), /invalid PCM audio/, 'zero bytes are not audio');
assert.throws(() => decodePcm([Buffer.alloc(3)], 3), /invalid PCM audio/, 'partial samples are rejected');
const decoded = decodePcm([
  Buffer.from(new Float32Array([0.5]).buffer),
  Buffer.from(new Float32Array([-0.25]).buffer),
], 8);
assert.deepEqual(Array.from(decoded), [0.5, -0.25], 'chunks are joined in order');

console.log('native ASR PCM extraction verification passed');
