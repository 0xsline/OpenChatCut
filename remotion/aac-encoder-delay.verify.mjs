// Exported audio must line up with the picture. Rebuilds Remotion's audio
// encode + mux with its own ffmpeg (libfdk_aac → ADTS → stream copy), measures
// beep onsets against the source PCM, and checks the compensation brings a
// ~42.7 ms lag back to within a few ms without touching the video.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  compensateAacEncoderDelay,
  FDK_AAC_ENCODER_DELAY_SAMPLES,
  remotionFfRunner,
  rendersRemotionAacTrack,
} from './aac-encoder-delay.mjs';

const require = createRequire(import.meta.url);
const ffmpegStatic = require('ffmpeg-static');
const execFileAsync = promisify(execFile);
const RATE = 48000;
const run = remotionFfRunner();
const root = await mkdtemp(path.join(tmpdir(), 'openchatcut-aac-delay-'));
const file = (name) => path.join(root, name);

// The premise: Remotion still encodes AAC with libfdk_aac into ADTS. If this
// changes, re-measure the delay before trusting FDK_AAC_ENCODER_DELAY_SAMPLES.
{
  const dist = path.dirname(require.resolve('@remotion/renderer'));
  const compress = await readFile(path.join(dist, 'compress-audio.js'), 'utf8');
  const codecs = await readFile(path.join(dist, 'options', 'audio-codec.js'), 'utf8');
  assert.match(compress, /\['-f', 'adts'\]/, 'Remotion writes its AAC track as raw ADTS');
  assert.match(codecs, /audioCodec === 'aac'\) \{\s*return 'libfdk_aac'/, 'Remotion encodes AAC with libfdk_aac');
}

/** 3 s stereo 16-bit WAV: 1 kHz 50 ms beeps at 0.25 s + k·0.5 s, silence between. */
function beepWav() {
  const seconds = 3;
  const frames = seconds * RATE;
  const buffer = Buffer.alloc(44 + frames * 4);
  buffer.write('RIFF', 0); buffer.writeUInt32LE(36 + frames * 4, 4); buffer.write('WAVE', 8);
  buffer.write('fmt ', 12); buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20); buffer.writeUInt16LE(2, 22);
  buffer.writeUInt32LE(RATE, 24); buffer.writeUInt32LE(RATE * 4, 28); buffer.writeUInt16LE(4, 32); buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36); buffer.writeUInt32LE(frames * 4, 40);
  for (let i = 0; i < frames; i++) {
    const t = i / RATE;
    const phase = (t - 0.25) % 0.5;
    const on = t >= 0.25 && phase < 0.05;
    const value = on ? Math.round(0.5 * 32767 * Math.sin(2 * Math.PI * 1000 * t)) : 0;
    buffer.writeInt16LE(value, 44 + i * 4);
    buffer.writeInt16LE(value, 46 + i * 4);
  }
  return buffer;
}

/** Decoded as a player hears it (edit lists applied). */
async function decodeMono(input) {
  const { stdout: pcm } = await execFileAsync(ffmpegStatic,
    ['-v', 'error', '-i', input, '-vn', '-ac', '1', '-ar', String(RATE), '-f', 'f32le', '-'],
    { encoding: 'buffer', maxBuffer: 1 << 28 });
  return new Float32Array(pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + (pcm.length - (pcm.length % 4))));
}

/** Sample index of every beep onset: 1 ms RMS crossing half the beep level after silence. */
function onsets(samples) {
  const window = 48;
  const found = [];
  let active = false;
  for (let start = 0; start + window < samples.length; start += 4) {
    let energy = 0;
    for (let i = start; i < start + window; i++) energy += samples[i] * samples[i];
    const rms = Math.sqrt(energy / window);
    if (!active && rms > 0.18) { active = true; found.push(start); }
    else if (active && rms < 0.02) active = false;
  }
  return found;
}

/** Median onset lag of `candidate` against `reference`, in milliseconds. */
async function lagMs(reference, candidate) {
  const want = onsets(await decodeMono(reference));
  const got = onsets(await decodeMono(candidate));
  assert.ok(want.length >= 5, `reference has beeps (${want.length})`);
  const lags = want.map((w) => got.reduce((best, g) => (Math.abs(g - w) < Math.abs(best - w) ? g : best), Infinity) - w);
  lags.sort((a, b) => a - b);
  return (lags[Math.floor(lags.length / 2)] / RATE) * 1000;
}

const videoMd5 = async (input) => (await execFileAsync(ffmpegStatic,
  ['-v', 'error', '-i', input, '-map', '0:v:0', '-c', 'copy', '-f', 'md5', '-'])).stdout;

try {
  await writeFile(file('beeps.wav'), beepWav());
  // Picture track: libx264 as Remotion's stitcher produces it.
  await execFileAsync(ffmpegStatic, [
    '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=64x64:r=25:d=3',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-y', file('video.mp4'),
  ]);
  // Remotion's compressAudio + stitch mux, argument for argument.
  await run('ffmpeg', ['-hide_banner', '-i', file('beeps.wav'), '-c:a', 'libfdk_aac', '-f', 'adts', '-b:a', '320k', '-cutoff', '18000', '-y', file('audio.aac')]);
  const rendered = file('rendered.mp4');
  await run('ffmpeg', ['-hide_banner', '-i', file('video.mp4'), '-i', file('audio.aac'), '-c:v', 'copy', '-c:a', 'copy', '-r', '25', '-movflags', 'faststart', '-y', rendered]);

  const expectedMs = (FDK_AAC_ENCODER_DELAY_SAMPLES / RATE) * 1000;
  const before = await lagMs(file('beeps.wav'), rendered);
  assert.ok(Math.abs(before - expectedMs) <= 3,
    `uncompensated ADTS track lags by the FDK encoder delay (${before.toFixed(1)} ms, expected ${expectedMs.toFixed(1)} ms)`);

  const videoBefore = await videoMd5(rendered);
  assert.equal(await compensateAacEncoderDelay({ file: rendered, run }), true, 'unsignalled priming is compensated');
  const after = await lagMs(file('beeps.wav'), rendered);
  assert.ok(Math.abs(after) <= 5, `compensated audio aligns within 5 ms (${after.toFixed(1)} ms)`);
  assert.equal(await videoMd5(rendered), videoBefore, 'video packets are copied untouched');
  const probe = JSON.parse(await run('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,start_time', '-of', 'json', rendered]));
  for (const stream of probe.streams) assert.equal(Number(stream.start_time), 0, `${stream.codec_type} still starts at 0`);

  assert.equal(await compensateAacEncoderDelay({ file: rendered, run }), false, 'a second pass is a no-op');
  assert.ok(Math.abs(await lagMs(file('beeps.wav'), rendered)) <= 5, 'a second pass does not shift again');

  // AAC whose priming the encoder already signalled (ffmpeg's native encoder in mp4) is left alone.
  const native = file('native.mp4');
  await execFileAsync(ffmpegStatic, ['-hide_banner', '-loglevel', 'error', '-i', file('video.mp4'), '-i', file('beeps.wav'), '-c:v', 'copy', '-c:a', 'aac', '-y', native]);
  assert.equal(await compensateAacEncoderDelay({ file: native, run }), false, 'signalled priming is not shifted');
  assert.equal(await compensateAacEncoderDelay({ file: file('video.mp4'), run }), false, 'a silent render is not touched');

  assert.equal(rendersRemotionAacTrack({ outputLocation: 'x.mp4', codec: 'h264' }), true);
  assert.equal(rendersRemotionAacTrack({ outputLocation: 'x.mov', codec: 'prores', audioCodec: 'aac' }), true);
  assert.equal(rendersRemotionAacTrack({ outputLocation: 'x.mp4', codec: 'h264', audioCodec: 'mp3' }), false);
  assert.equal(rendersRemotionAacTrack({ outputLocation: 'x.webm', codec: 'vp8' }), false);
  assert.equal(rendersRemotionAacTrack({ outputLocation: 'x.mp4', codec: 'h264', muted: true }), false);

  const render = await readFile(new URL('./render.mjs', import.meta.url), 'utf8');
  assert.ok((render.match(/renderMediaWithAlignedAudio\(attempt, abortSignal\)/g) ?? []).length === 2,
    'every renderMedia path without the direct-hardware AAC remux restores the encoder delay');
} finally {
  await rm(root, { recursive: true, force: true });
}
console.log('AAC encoder delay compensation verification passed');
