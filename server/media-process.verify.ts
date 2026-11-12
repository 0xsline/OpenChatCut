import assert from 'node:assert/strict';
import { ffmpegThreadArgs, ffmpegThreadCount, withWindowsHide } from './media-process.ts';

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

// Media children must never flash a console window in the packaged desktop
// app (GUI process, no console) on Windows.
assert.deepEqual(withWindowsHide(), { windowsHide: true });
assert.deepEqual(
  withWindowsHide({ stdio: ['ignore', 'pipe', 'pipe'] }),
  { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
);

console.log('media process thread limit verification passed');
