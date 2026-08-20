import assert from 'node:assert/strict';
import { ffmpegThreadArgs, ffmpegThreadCount } from './media-process.ts';

const previous = process.env.OPENCHATCUT_FFMPEG_THREADS;
try {
  delete process.env.OPENCHATCUT_FFMPEG_THREADS;
  assert.equal(ffmpegThreadCount(8), 6);
  assert.deepEqual(ffmpegThreadArgs(4), ['-threads', '3']);
  process.env.OPENCHATCUT_FFMPEG_THREADS = '2';
  assert.equal(ffmpegThreadCount(16), 2);
  process.env.OPENCHATCUT_FFMPEG_THREADS = '99';
  assert.equal(ffmpegThreadCount(4), 4, 'override must not exceed available cores');
} finally {
  if (previous === undefined) delete process.env.OPENCHATCUT_FFMPEG_THREADS;
  else process.env.OPENCHATCUT_FFMPEG_THREADS = previous;
}

console.log('media process thread limit verification passed');
