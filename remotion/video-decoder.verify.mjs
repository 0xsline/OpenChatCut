// The server render's video decoder is chosen per platform, with an explicit
// override in both directions (issue #162).
// node remotion/video-decoder.verify.mjs
import assert from 'node:assert/strict';
import { resolveServerVideoDecoder, SERVER_VIDEO_DECODERS } from './video-decoder.mjs';

assert.deepEqual([...SERVER_VIDEO_DECODERS], ['webcodecs', 'offthread']);

assert.equal(resolveServerVideoDecoder({ platform: 'win32', override: undefined }), 'offthread',
  'Windows exports must not depend on the WebCodecs decode that wedges on D3D11 decoders');
assert.equal(resolveServerVideoDecoder({ platform: 'darwin', override: undefined }), 'webcodecs',
  'macOS keeps the frame-sync-verified @remotion/media path');
assert.equal(resolveServerVideoDecoder({ platform: 'linux', override: undefined }), 'webcodecs',
  'Linux keeps the @remotion/media path');

assert.equal(resolveServerVideoDecoder({ platform: 'darwin', override: 'offthread' }), 'offthread',
  'any platform can opt into the compositor');
assert.equal(resolveServerVideoDecoder({ platform: 'win32', override: 'webcodecs' }), 'webcodecs',
  'Windows can opt back into WebCodecs for diagnosis');
assert.equal(resolveServerVideoDecoder({ platform: 'linux', override: '  OffThread\n' }), 'offthread',
  'the override ignores case and surrounding whitespace');
assert.equal(resolveServerVideoDecoder({ platform: 'win32', override: 'ffmpeg' }), 'offthread',
  'an unknown override keeps the platform default');
assert.equal(resolveServerVideoDecoder({ platform: 'darwin', override: '' }), 'webcodecs');

const previous = process.env.CC_RENDER_VIDEO_DECODER;
try {
  process.env.CC_RENDER_VIDEO_DECODER = 'offthread';
  assert.equal(resolveServerVideoDecoder({ platform: 'darwin' }), 'offthread',
    'CC_RENDER_VIDEO_DECODER is read on every render, not once at import');
  delete process.env.CC_RENDER_VIDEO_DECODER;
  assert.equal(resolveServerVideoDecoder({ platform: 'win32' }), 'offthread');
} finally {
  if (previous === undefined) delete process.env.CC_RENDER_VIDEO_DECODER;
  else process.env.CC_RENDER_VIDEO_DECODER = previous;
}

console.log('video-decoder.verify: Windows server renders decode with the compositor; the override works both ways');
