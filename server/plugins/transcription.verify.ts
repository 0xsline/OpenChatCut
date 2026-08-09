import assert from 'node:assert/strict';
import {
  assertTranscriptionProviderConfigured,
  transcribeCloudAudio,
} from './transcription-providers.ts';
import type { TranscriptionOptions } from './transcription-types.ts';

const options: TranscriptionOptions = {
  openaiBaseUrl: 'https://api.openai.test',
  openaiApiKey: 'openai-test-key',
  openaiModel: 'gpt-4o-mini-transcribe',
  mistralBaseUrl: 'https://api.mistral.test/v1',
  mistralApiKey: 'mistral-test-key',
  mistralModel: 'voxtral-mini-latest',
  deepgramApiKey: 'deepgram-test-key',
  deepgramModel: 'nova-3',
  groqBaseUrl: 'https://api.groq.test/openai/v1',
  groqApiKey: 'groq-test-key',
  groqModel: 'whisper-large-v3-turbo',
  elevenApiKey: 'elevenlabs-test-key',
  elevenModel: 'scribe_v2',
  cartesiaApiKey: 'cartesia-test-key',
  cartesiaModel: 'ink-whisper',
  language: 'zh',
  diarization: true,
};

const originalFetch = globalThis.fetch;
try {
  let requestSeen = false;
  globalThis.fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    assert.equal(url, 'https://api.mistral.test/v1/audio/transcriptions');
    const body = init?.body;
    assert.ok(body instanceof FormData, 'Mistral transcription must use multipart audio upload');
    assert.equal(body.get('model'), 'voxtral-mini-latest');
    assert.equal(body.get('language'), 'en');
    requestSeen = true;
    return Response.json({
      text: 'hello world',
      language: 'en',
      duration: 0.5,
      words: [
        { word: 'hello', start: 0, end: 0.24 },
        { word: 'world', start: 0.25, end: 0.5 },
      ],
    });
  };

  const result = await transcribeCloudAudio(options, {
    provider: 'mistral',
    audio: new TextEncoder().encode('audio-bytes'),
    language: 'en',
    diarize: false,
  });
  assert.equal(requestSeen, true);
  assert.deepEqual(result.words, [
    { text: 'hello', start: 0, end: 240, speaker: null },
    { text: 'world', start: 250, end: 500, speaker: null },
  ]);
  assert.deepEqual(result.utterances, []);

  assert.throws(
    () => assertTranscriptionProviderConfigured({ ...options, mistralApiKey: '' }, 'mistral'),
    /Mistral API key is not configured/,
  );
  assert.throws(
    () => assertTranscriptionProviderConfigured({ ...options, cartesiaModel: 'ink-2' }, 'cartesia'),
    /streaming-only/,
  );
} finally {
  globalThis.fetch = originalFetch;
}

console.log('transcription.verify: ok (Mistral AI SDK compatibility route + provider guards)');
