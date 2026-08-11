import assert from 'node:assert/strict';
import { putMediaBlob, resetMediaBlobMemory } from '../persist/mediaBlobStore';
import {
  genericCloudTranscribePath,
  parseTranscriptResult,
} from './generic-cloud-asr';

const originalFetch = globalThis.fetch;

function requestBody(init: RequestInit | undefined): Blob {
  assert.ok(init != null && init.body instanceof Blob, 'transcription request must send a Blob body');
  assert.equal(new Headers(init.headers).get('content-type'), 'application/octet-stream',
    'transcription request must declare its binary body');
  return init.body;
}

try {
  const checkpoints: string[] = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url === '/media/uploads/asr.wav') {
      return new Response(new Blob(['audio-bytes'], { type: 'audio/wav' }));
    }
    assert.match(url, /^\/api\/transcribe\?/);
    const query = new URL(url, 'http://localhost').searchParams;
    assert.equal(query.get('provider'), 'deepgram');
    assert.equal(query.get('language'), 'en');
    assert.equal(query.get('diarize'), '0');
    assert.equal(init?.method, 'POST');
    assert.equal(await requestBody(init).text(), 'audio-bytes');
    return Response.json({
      text: 'hello world',
      words: [
        { text: 'hello', start: 0, end: 250, speaker: 'A' },
        { text: 'world', start: 260, end: 500, speaker: 'A' },
      ],
      utterances: [{
        speaker: 'A', text: 'hello world', start: 0, end: 500,
        words: [
          { text: 'hello', start: 0, end: 250, speaker: 'A' },
          { text: 'world', start: 260, end: 500, speaker: 'A' },
        ],
      }],
    });
  };

  const result = await genericCloudTranscribePath(
    'deepgram',
    '/media/uploads/master.mp4',
    async (checkpoint) => { checkpoints.push(checkpoint.providerStatus ?? ''); },
    undefined,
    { asrPath: '/media/uploads/asr.wav', languageCode: 'en', diarize: false },
  );
  assert.equal(result.words.length, 2);
  assert.deepEqual(checkpoints, ['processing', 'completed']);

  resetMediaBlobMemory();
  await putMediaBlob('/media/uploads/cached.wav', new Blob(['cached-audio'], { type: 'audio/wav' }));
  let postedCachedBody = '';
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url === '/media/uploads/cached.wav') throw new TypeError('offline');
    postedCachedBody = await requestBody(init).text();
    return Response.json({ text: '', words: [], utterances: [] });
  };
  await genericCloudTranscribePath(
    'openai',
    '/media/uploads/master.mp4',
    async () => undefined,
    undefined,
    { asrPath: '/media/uploads/cached.wav' },
  );
  assert.equal(postedCachedBody, 'cached-audio');

  assert.throws(
    () => parseTranscriptResult({ text: 'bad', words: [{ text: 'x', start: 10, end: 2 }], utterances: [] }),
    /reversed word timestamp/,
  );
  assert.throws(
    () => parseTranscriptResult({ text: 'bad', words: [], utterances: 'not-an-array' }),
    /invalid response/,
  );
} finally {
  globalThis.fetch = originalFetch;
  resetMediaBlobMemory();
}

console.log('generic-cloud-asr.verify: ok');
