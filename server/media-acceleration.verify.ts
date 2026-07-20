import assert from 'node:assert/strict';
import { ffmpegBin } from './media-binaries.ts';
import {
  h264EncoderAttempts,
  h264EncodingArgs,
  h264HardwareCandidates,
  isHardwareH264Encoder,
  resolveH264Encoder,
  resolveH264TargetBitrate,
  type H264Encoder,
} from './media-acceleration.ts';

assert.deepEqual(h264HardwareCandidates('darwin'), ['h264_videotoolbox']);
assert.deepEqual(h264HardwareCandidates('win32'), ['h264_nvenc', 'h264_qsv', 'h264_amf']);
assert.deepEqual(h264HardwareCandidates('linux'), []);
assert.equal(isHardwareH264Encoder('h264_videotoolbox'), true);
assert.equal(isHardwareH264Encoder('libx264'), false);
assert.deepEqual(h264EncoderAttempts('h264_nvenc'), ['h264_nvenc', 'libx264']);
assert.deepEqual(h264EncoderAttempts('libx264'), ['libx264']);

assert.deepEqual(h264EncodingArgs({ encoder: 'libx264' }), [
  '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'medium', '-crf', '18',
]);
assert.deepEqual(h264EncodingArgs({ encoder: 'h264_qsv', targetBitrate: 8_000_000 }), [
  '-c:v', 'h264_qsv', '-pix_fmt', 'nv12', '-b:v', '8000000',
]);
assert.deepEqual(h264EncodingArgs({
  encoder: 'h264_videotoolbox',
  targetBitrate: 8_000_000,
  maxBitrate: 8_000_000,
  bufferSize: 16_000_000,
}), [
  '-c:v', 'h264_videotoolbox', '-pix_fmt', 'yuv420p',
  '-b:v', '8000000', '-maxrate', '8000000', '-bufsize', '16000000',
]);
assert.equal(resolveH264TargetBitrate({ width: 854, height: 480, fps: 30 }), 4_000_000);
assert.equal(resolveH264TargetBitrate({ width: 1920, height: 1080, fps: 30 }), 10_000_000);
assert.equal(resolveH264TargetBitrate({ width: 1920, height: 1080, fps: 60 }), 20_000_000);
assert.equal(resolveH264TargetBitrate({ width: 3840, height: 2160, fps: 60 }), 30_000_000);

const detected = await resolveH264Encoder(ffmpegBin());
assert.ok((['h264_videotoolbox', 'h264_nvenc', 'h264_qsv', 'h264_amf', 'libx264'] as H264Encoder[]).includes(detected));
console.log(`media acceleration verification passed (${detected})`);
