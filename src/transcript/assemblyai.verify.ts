import assert from 'node:assert/strict';
import { createTranscript, loadTranscriptionSource, TranscriptionError } from './assemblyai';
import { putMediaBlob, resetMediaBlobMemory } from '../persist/mediaBlobStore';

const originalFetch = globalThis.fetch;

try {
  let requestBody: Record<string, unknown> | undefined;
  globalThis.fetch = async (_input, init) => {
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(JSON.stringify({ id: 'transcript-id' }), { status: 200 });
  };
  await createTranscript('https://example.com/audio.mp3');
  assert.equal(requestBody?.language_detection, true);
  assert.equal(requestBody?.language_code, undefined);

  await createTranscript('https://example.com/audio.mp3', { languageCode: 'en' });
  assert.equal(requestBody?.language_detection, undefined);
  assert.equal(requestBody?.language_code, 'en');

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
} finally {
  globalThis.fetch = originalFetch;
  resetMediaBlobMemory();
}

console.log('assemblyai.check: ok');
