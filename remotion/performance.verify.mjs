import assert from 'node:assert/strict';
import {
  isHardwareEncoderFailure,
  remotionHardwareAcceleration,
  resolveH264VideoBitrate,
  resolveOffthreadVideoThreads,
  resolveRenderConcurrency,
  withHardwareEncoderFallback,
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
assert.equal(remotionHardwareAcceleration('h264', { platform: 'linux', disabled: false }), 'disable');
assert.equal(remotionHardwareAcceleration('vp8', { platform: 'darwin', disabled: false }), 'disable');
assert.equal(remotionHardwareAcceleration('h264', { platform: 'darwin', disabled: true }), 'disable');

assert.equal(resolveH264VideoBitrate({ width: 854, height: 480, fps: 30 }), '4000k');
assert.equal(resolveH264VideoBitrate({ width: 1920, height: 1080, fps: 30 }), '10000k');
assert.equal(resolveH264VideoBitrate({ width: 1920, height: 1080, fps: 60 }), '20000k');
assert.equal(resolveH264VideoBitrate({ width: 3840, height: 2160, fps: 60 }), '30000k');

assert.equal(isHardwareEncoderFailure(new Error('No NVENC capable devices found')), true);
assert.equal(isHardwareEncoderFailure(new Error('VideoToolbox encoder failed')), true);
assert.equal(isHardwareEncoderFailure(new Error('asset returned HTTP 404')), false);

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
