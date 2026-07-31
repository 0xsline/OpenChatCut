import assert from 'node:assert/strict';
import {
  h264FfmpegOverride,
  hardwareEncoderFailureClass,
  isHardwareEncoderFailure,
  remotionHardwareAcceleration,
  resolveH264VideoBitrate,
  resolveOffthreadVideoThreads,
  resolveRenderConcurrency,
  withHardwareEncoderFallback,
  withEncoderProfileFallback,
} from './performance.mjs';

const abundantMemory = 64 * 1024 ** 3;
assert.equal(resolveRenderConcurrency({ cores: 10, memoryBytes: abundantMemory }), 8);
assert.equal(resolveRenderConcurrency({ cores: 4, memoryBytes: abundantMemory }), 3);
assert.equal(resolveRenderConcurrency({ cores: 2, memoryBytes: abundantMemory }), 1);
assert.equal(resolveRenderConcurrency({ cores: 32, memoryBytes: abundantMemory }), 24);
assert.equal(resolveRenderConcurrency({ cores: 32, memoryBytes: 16 * 1024 ** 3 }), 6);
assert.equal(resolveRenderConcurrency({ cores: 10, override: '100%' }), 10);
assert.equal(resolveRenderConcurrency({ cores: 10, override: '70%' }), 7);
assert.equal(resolveRenderConcurrency({ cores: 10, override: '6' }), 6);
assert.equal(resolveRenderConcurrency({ cores: 10, override: '99' }), 10);
assert.equal(resolveRenderConcurrency({ cores: 10, memoryBytes: abundantMemory, override: 'invalid' }), 8);

assert.equal(resolveOffthreadVideoThreads({ cores: 2 }), 1);
assert.equal(resolveOffthreadVideoThreads({ cores: 4 }), 2);
assert.equal(resolveOffthreadVideoThreads({ cores: 10 }), 3);
assert.equal(resolveOffthreadVideoThreads({ cores: 24 }), 4);

assert.equal(remotionHardwareAcceleration('h264', { platform: 'darwin', disabled: false }), 'required');
assert.equal(remotionHardwareAcceleration('h264', { platform: 'win32', disabled: false }), 'required');
assert.equal(remotionHardwareAcceleration('h264', { platform: 'linux', disabled: false }), 'required');
assert.equal(remotionHardwareAcceleration('vp8', { platform: 'darwin', disabled: false }), 'disable');
assert.equal(remotionHardwareAcceleration('h264', { platform: 'darwin', disabled: true }), 'disable');
assert.equal(remotionHardwareAcceleration('h264', {
  platform: 'linux', disabled: false, encoder: 'h264_nvenc',
}), 'required');
assert.equal(remotionHardwareAcceleration('h264', {
  platform: 'linux', disabled: false, encoder: 'h264_qsv',
}), 'disable');

assert.equal(resolveH264VideoBitrate({ width: 854, height: 480, fps: 30 }), '4000k');
assert.equal(resolveH264VideoBitrate({ width: 1920, height: 1080, fps: 30 }), '10000k');
assert.equal(resolveH264VideoBitrate({ width: 1920, height: 1080, fps: 60 }), '20000k');
assert.equal(resolveH264VideoBitrate({ width: 3840, height: 2160, fps: 60 }), '30000k');

assert.equal(isHardwareEncoderFailure(new Error('No NVENC capable devices found')), true);
assert.equal(isHardwareEncoderFailure(new Error('VideoToolbox encoder failed')), true);
assert.equal(isHardwareEncoderFailure(new Error('asset returned HTTP 404')), false);
assert.equal(hardwareEncoderFailureClass(new Error('/secret/device: No device')), 'device-unavailable');

const baseArgs = [
  '-r', '30', '-i', 'frames.png',
  '-c:v', 'libx264',
  '-vf', 'zscale=matrix=709',
  '-pix_fmt', 'yuv420p',
  'out.mp4',
];
const qsvArgs = h264FfmpegOverride('h264_qsv')({ type: 'pre-stitcher', args: baseArgs });
assert.equal(qsvArgs[qsvArgs.indexOf('-c:v') + 1], 'h264_qsv');
assert.equal(qsvArgs[qsvArgs.indexOf('-pix_fmt') + 1], 'nv12');
assert.equal(baseArgs[baseArgs.indexOf('-c:v') + 1], 'libx264', 'override must not mutate input');
const amfArgs = h264FfmpegOverride('h264_amf')({ type: 'pre-stitcher', args: baseArgs });
assert.equal(amfArgs[amfArgs.indexOf('-c:v') + 1], 'h264_amf');
assert.equal(amfArgs[amfArgs.indexOf('-pix_fmt') + 1], 'nv12');

const vaapiArgs = h264FfmpegOverride('h264_vaapi', {
  vaapiDevice: '/dev/dri/renderD129',
})({ type: 'stitcher', args: baseArgs });
assert.ok(vaapiArgs.indexOf('-vaapi_device') < vaapiArgs.indexOf('-i'));
assert.equal(vaapiArgs[vaapiArgs.indexOf('-vaapi_device') + 1], '/dev/dri/renderD129');
assert.equal(vaapiArgs[vaapiArgs.indexOf('-pix_fmt') + 1], 'vaapi');
assert.equal(
  vaapiArgs[vaapiArgs.indexOf('-vf') + 1],
  'zscale=matrix=709,format=nv12,hwupload',
);
const copyArgs = ['-i', 'chunk.mp4', '-c:v', 'copy', 'out.mp4'];
assert.deepEqual(
  h264FfmpegOverride('h264_amf')({ type: 'stitcher', args: copyArgs }),
  copyArgs,
);

{
  const result = await withEncoderProfileFallback({
    render: async (options) => {
      if (options.mode === 'hardware') throw new Error('No NVENC capable devices found');
      return 'ok';
    },
    hardwareOptions: { mode: 'hardware' },
    softwareOptions: { mode: 'software' },
    hardwareProfile: {
      id: 'h264_nvenc',
      label: 'NVIDIA NVENC',
      hardware: true,
      transport: 'server',
    },
  });
  assert.equal(result.result, 'ok');
  assert.deepEqual(result.encoder, {
    id: 'libx264',
    label: 'Software (libx264)',
    hardware: false,
    transport: 'server',
  });
  assert.equal(result.encoderFallbackReason, 'h264_nvenc: device-unavailable');
}
{
  let attempts = 0;
  const assetError = new Error('asset returned HTTP 404');
  await assert.rejects(
    withEncoderProfileFallback({
      render: async () => { attempts += 1; throw assetError; },
      hardwareOptions: { mode: 'hardware' },
      softwareOptions: { mode: 'software' },
      hardwareProfile: {
        id: 'h264_nvenc',
        label: 'NVIDIA NVENC',
        hardware: true,
        transport: 'server',
      },
    }),
    (error) => error === assetError,
  );
  assert.equal(attempts, 1);
}

{
  const attempts = [];
  let cleaned = 0;
  const result = await withHardwareEncoderFallback({
    render: async (options) => {
      attempts.push(options);
      if (attempts.length === 1) throw new Error('No NVENC capable devices found');
      return 'ok';
    },
    hardwareOptions: { hardwareAcceleration: 'required', videoBitrate: '10000k' },
    softwareOptions: { hardwareAcceleration: 'disable', videoBitrate: null },
    cleanup: async () => { cleaned += 1; },
  });
  assert.equal(result, 'ok');
  assert.equal(cleaned, 1);
  assert.deepEqual(attempts, [
    { hardwareAcceleration: 'required', videoBitrate: '10000k' },
    { hardwareAcceleration: 'disable', videoBitrate: null },
  ]);
}

await assert.rejects(
  withHardwareEncoderFallback({
    render: async () => { throw new Error('asset returned HTTP 404'); },
    hardwareOptions: { hardwareAcceleration: 'required' },
    softwareOptions: { hardwareAcceleration: 'disable' },
  }),
  /HTTP 404/,
);

console.log('remotion performance verification passed');
