import assert from 'node:assert/strict';
import {
  extractAudioForAsr, loadTranscriptionSource, transcriptionSourceForPath, TranscriptionError,
} from './assemblyai';
import { putMediaBlob, resetMediaBlobMemory } from '../persist/mediaBlobStore';

const originalFetch = globalThis.fetch;

try {
  globalThis.fetch = async () => { throw new TypeError('Failed to fetch'); };
  resetMediaBlobMemory();

  const src = '/media/uploads/cached-audio.wav';
  await putMediaBlob(src, new Blob(['cached audio'], { type: 'audio/wav' }));
  const cached = await loadTranscriptionSource(src);
  assert.equal(await cached.text(), 'cached audio');

  resetMediaBlobMemory();
  await assert.rejects(() => loadTranscriptionSource('/media/uploads/missing.wav'), (error) => (
    error instanceof TranscriptionError && error.code === 'source-unavailable'
  ));

  globalThis.fetch = async (input) => {
    assert.equal(String(input), '/api/extract-audio');
    return Response.json({ ok: false, noAudio: true }, { status: 422 });
  };
  await assert.rejects(
    () => extractAudioForAsr('/media/uploads/silent-video.mp4'),
    (error) => error instanceof TranscriptionError && error.code === 'no-audio',
    'the existing no-audio response remains a typed, skippable transcription error',
  );

  globalThis.fetch = async () => new Response('ffmpeg failed', { status: 500 });
  assert.equal(
    await transcriptionSourceForPath('/media/uploads/video.mp4', {}),
    '/media/uploads/video.mp4',
    'cloud callers preserve the existing fallback to the original media',
  );
  await assert.rejects(
    () => transcriptionSourceForPath('/media/uploads/video.mp4', {}, true),
    (error) => error instanceof TranscriptionError
      && error.code === 'service-unavailable'
      && error.message.includes('HTTP 500')
      && error.message.includes('ffmpeg failed'),
    'browser-local ASR stops before decoding the whole video when extraction fails',
  );
} finally {
  globalThis.fetch = originalFetch;
  resetMediaBlobMemory();
}

console.log('assemblyai.check: ok');
