import assert from 'node:assert/strict';
import { requestPreviewProxy } from './previewMedia';

const source = '/media/uploads/preview-force-check.mp4';
let calls = 0;
globalThis.fetch = async () => {
  calls++;
  return Response.json({
    source: { src: source, durationMs: 1_000, width: 640, height: 360, codec: 'h264', longGop: false },
    proxy: calls === 1
      ? { status: 'not-needed', reason: 'source-compatible' }
      : { status: 'ready', reason: 'forced', previewSrc: '/api/preview-proxy-file?src=check' },
  });
};

await requestPreviewProxy(source);
await requestPreviewProxy(source, true);
await requestPreviewProxy(source, true);
assert.equal(calls, 2, 'forced proxy generation is retried once and cached after it is ready');

console.log('previewMedia.verify: ok');
