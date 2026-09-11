import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  h264HardwareSupportsDimensions,
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

// GL backend selection: angle on desktop platforms, angle-egl on Linux
// (headless renderers without X11), CC_RENDER_GL override for diagnosis.
{
  const render = await readFile(new URL('./render.mjs', import.meta.url), 'utf8');
  assert.match(render, /function resolveRenderGlBackend/, 'GL backend resolver exists');
  assert.match(render, /process\.platform === 'linux' \? 'angle-egl' : 'angle'/, 'linux defaults to angle-egl, others to angle');
  assert.match(render, /CC_RENDER_GL/, 'CC_RENDER_GL overrides the backend');
  assert.ok((render.match(/gl: resolveRenderGlBackend\(\)/g) ?? []).length >= 5, 'every render/still path uses the resolver');
  assert.match(render, /CC_REMOTION_BINARIES_DIR/, 'the packaged app supplies the mirrored compositor directory');
  // The packaged app ships as an asar archive: the compositor inside it can be neither
  // chmod'ed nor spawned, so every selectComposition / renderMedia / renderStill call must
  // render from the mirrored directory (null in dev, where the package path is a real file).
  assert.ok((render.match(/binariesDirectory: binariesDirectory\(\)/g) ?? []).length >= 5,
    'every composition selection, media render and still render passes the binaries directory');
  assert.doesNotMatch(render, /binariesDirectory: undefined/, 'the software retry keeps the binaries directory');
  assert.match(render, /attempt\.ffmpegOverride\s*\?\s*renderDirectHardware/,
    'the custom ffmpeg override, not the binaries directory, marks the direct-hardware attempt');
}

// ── Hardware H.264 frame-size ceiling ─────────────────────────────────────────
// Hardware H.264 encoders stop at 4096 per dimension, far below what the codec
// allows. Measured on the reference machine: h264_nvenc encodes 3840x2160 and
// fails 5808x2160 with "No capable devices found", leaving a zero-byte file.
assert.equal(h264HardwareSupportsDimensions(1920, 1080), true, '1080p stays on hardware');
assert.equal(h264HardwareSupportsDimensions(3840, 2160), true, 'UHD stays on hardware');
assert.equal(h264HardwareSupportsDimensions(4096, 4096), true, 'the cap itself is allowed');
assert.equal(h264HardwareSupportsDimensions(4097, 2160), false, 'one pixel over the cap is not');
// The case that could not export at all: a 2.69:1 scope timeline at the "4k"
// preset, which scales the short side to 2160 and lands at 5808 wide.
assert.equal(h264HardwareSupportsDimensions(5808, 2160), false, 'scope 4k exceeds hardware H.264');
assert.equal(h264HardwareSupportsDimensions(2160, 5808), false, 'the cap applies to height too');
// Fail open: an unreadable size must not disable hardware for everyone.
assert.equal(h264HardwareSupportsDimensions(undefined, 2160), true, 'unknown width keeps hardware');
assert.equal(h264HardwareSupportsDimensions(NaN, NaN), true, 'unreadable size keeps hardware');
assert.equal(h264HardwareSupportsDimensions(0, 0), true, 'a zero size is unknown, not oversized');
assert.equal(h264HardwareSupportsDimensions(5808, 2160, { max: 8192 }), true,
  'the cap is overridable for encoders that genuinely allow more');

// ── Runtime failures that previously escaped the software fallback ────────────
// The exact stderr h264_nvenc emits for an oversized frame.
assert.equal(isHardwareEncoderFailure(new Error(
  '[h264_nvenc @ 0x1] No capable devices found',
)), true, 'the real NVENC oversize message is a hardware failure');
assert.equal(isHardwareEncoderFailure(new Error(
  'Error while opening encoder - maybe incorrect parameters such as bit_rate, rate, width or height.',
)), true, 'ffmpeg’s encoder-open failure is a hardware failure');
// hardwareAcceleration is 'required' for NVENC on Windows, so Remotion rejects
// rather than degrading; that rejection has to reach the software fallback.
assert.equal(isHardwareEncoderFailure(new Error(
  'Hardware acceleration is set to "required" but is not available',
)), true, 'a required-acceleration rejection is a hardware failure');
assert.equal(isHardwareEncoderFailure(new Error('Disk full')), false,
  'unrelated failures still propagate instead of silently re-rendering');

console.log('performance.verify: hardware H.264 frame-size ceiling and failure detection passed');
