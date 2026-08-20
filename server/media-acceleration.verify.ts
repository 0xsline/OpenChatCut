import assert from 'node:assert/strict';
import {
  h264EncoderAttempts,
  h264EncoderFallbackReason,
  h264EncoderProfile,
  h264EncodingArgs,
  h264FilterChain,
  h264GlobalArgs,
  h264HardwareCandidates,
  h264ProbeArgs,
  hwDecodeArgs,
  isHardwareH264Encoder,
  resolveH264TargetBitrate,
  resolveVaapiDevice,
  selectWorkingH264Encoder,
  shouldFallbackH264Encoder,
  type H264Encoder,
} from './media-acceleration.ts';

assert.deepEqual(h264HardwareCandidates('darwin'), ['h264_videotoolbox']);
assert.deepEqual(h264HardwareCandidates('win32'), ['h264_nvenc', 'h264_qsv', 'h264_amf']);
assert.deepEqual(h264HardwareCandidates('linux'), ['h264_nvenc', 'h264_qsv', 'h264_vaapi']);
assert.equal(isHardwareH264Encoder('h264_videotoolbox'), true);
assert.equal(isHardwareH264Encoder('libx264'), false);
assert.equal(isHardwareH264Encoder('h264_vaapi'), true);
assert.deepEqual(h264EncoderAttempts('h264_nvenc'), ['h264_nvenc', 'libx264']);
assert.deepEqual(h264EncoderAttempts('libx264'), ['libx264']);
assert.deepEqual(hwDecodeArgs('libx264'), [], 'software encoding must keep decoded frames in system memory');

assert.equal(
  h264EncoderFallbackReason('h264_nvenc', new Error('/private/path: No NVENC capable devices found')),
  'h264_nvenc: device-unavailable',
);
assert.equal(
  shouldFallbackH264Encoder('h264_nvenc', new Error('No NVENC capable devices found')),
  true,
);
assert.equal(shouldFallbackH264Encoder('h264_nvenc', new Error('asset returned HTTP 404')), false);
assert.equal(shouldFallbackH264Encoder('h264_nvenc', new DOMException('cancelled', 'AbortError')), false);
assert.equal(resolveVaapiDevice('/dev/dri/renderD129'), '/dev/dri/renderD129');
assert.equal(resolveVaapiDevice('../../tmp/fake-device'), '/dev/dri/renderD128');
assert.deepEqual(h264GlobalArgs('h264_vaapi', '/dev/dri/renderD130'), [
  '-vaapi_device', '/dev/dri/renderD130',
]);
assert.equal(
  h264FilterChain('h264_vaapi', ['fps=30']),
  'fps=30,format=nv12,hwupload',
);
const vaapiProbe = h264ProbeArgs('h264_vaapi', '/dev/dri/renderD130');
assert.equal(vaapiProbe[vaapiProbe.indexOf('-f') + 1], 'rawvideo');
assert.equal(vaapiProbe[vaapiProbe.indexOf('-i') + 1], 'pipe:0');
assert.equal(vaapiProbe[vaapiProbe.indexOf('-frames:v') + 1], '1');
assert.ok(vaapiProbe.indexOf('-vaapi_device') < vaapiProbe.indexOf('-i'));
assert.equal(vaapiProbe[vaapiProbe.indexOf('-c:v') + 1], 'h264_vaapi');

const probeAttempts: H264Encoder[] = [];
const selected = await selectWorkingH264Encoder(
  h264HardwareCandidates('linux'),
  async (encoder) => {
    probeAttempts.push(encoder);
    return encoder === 'h264_qsv';
  },
);
assert.equal(selected, 'h264_qsv');
assert.deepEqual(probeAttempts, ['h264_nvenc', 'h264_qsv']);
assert.equal(
  await selectWorkingH264Encoder(['h264_nvenc', 'h264_qsv'], async () => false),
  'libx264',
);
assert.deepEqual(h264EncoderProfile('h264_qsv'), {
  id: 'h264_qsv',
  label: 'Intel Quick Sync Video',
  hardware: true,
  transport: 'server',
});

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
assert.deepEqual(h264EncodingArgs({
  encoder: 'h264_vaapi',
  targetBitrate: 8_000_000,
}), [
  '-c:v', 'h264_vaapi', '-pix_fmt', 'vaapi', '-b:v', '8000000',
]);
assert.deepEqual(h264EncodingArgs({
  encoder: 'h264_nvenc',
  targetBitrate: 8_000_000,
  hardwareQuality: 23,
  qualityMode: 'cqp',
}), [
  '-c:v', 'h264_nvenc', '-pix_fmt', 'yuv420p',
  '-rc_mode', 'CQP', '-global_quality', '23',
]);
assert.deepEqual(h264EncodingArgs({
  encoder: 'h264_nvenc',
  targetBitrate: 8_000_000,
  hardwareQuality: 23,
  qualityMode: 'legacy-qp',
}), [
  '-c:v', 'h264_nvenc', '-pix_fmt', 'yuv420p',
  '-rc', 'constqp', '-qp', '23',
]);
assert.equal(resolveH264TargetBitrate({ width: 854, height: 480, fps: 30 }), 4_000_000);
assert.equal(resolveH264TargetBitrate({ width: 1920, height: 1080, fps: 30 }), 10_000_000);
assert.equal(resolveH264TargetBitrate({ width: 1920, height: 1080, fps: 60 }), 20_000_000);
assert.equal(resolveH264TargetBitrate({ width: 3840, height: 2160, fps: 60 }), 60_000_000);
console.log('media acceleration verification passed');
