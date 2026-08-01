import assert from 'node:assert/strict';
import { loadTranscriptionSource, transcribePath, TranscriptionError } from './assemblyai';
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

  const assemblyCalls: string[] = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    assemblyCalls.push(`${init?.method ?? 'GET'} ${url}`);
    if (url === '/api/keys') {
      return Response.json({ models: {} });
    }
    if (url === '/media/uploads/a.wav' && init?.method === 'HEAD') {
      return new Response(null, { status: 200, headers: { 'content-length': '3' } });
    }
    if (url === '/media/uploads/a.wav') {
      return new Response(new Blob(['wav'], { type: 'audio/wav' }));
    }
    if (url === '/assemblyai/v2/upload') {
      return Response.json({ upload_url: 'https://example.test/audio' });
    }
    if (url === '/assemblyai/v2/transcript' && init?.method === 'POST') {
      return Response.json({ id: 'tx1' });
    }
    if (url === '/assemblyai/v2/transcript/tx1') {
      return Response.json({
        status: 'completed',
        text: 'hello',
        words: [{ text: 'hello', start: 0, end: 500, speaker: 'A' }],
        utterances: [],
      });
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  const assembly = await transcribePath('/media/uploads/a.wav');
  assert.equal(assembly.words[0]?.speaker, 'A');
  assert.ok(assemblyCalls.some((call) => call.includes('/assemblyai/v2/upload')), 'default route uses AssemblyAI');

  const localCalls: string[] = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    localCalls.push(`${init?.method ?? 'GET'} ${url}`);
    if (url === '/api/keys') {
      return Response.json({ models: { PREFERRED_TRANSCRIPTION_VENDOR: 'faster-whisper', FASTER_WHISPER_MODEL: 'small' } });
    }
    if (url === '/media/uploads/b.wav' && init?.method === 'HEAD') {
      return new Response(null, { status: 200, headers: { 'content-length': '3' } });
    }
    if (url === '/api/asr/transcribe') {
      return Response.json({ text: '本地', words: [{ text: '本地', start: 0, end: 300, speaker: null }], utterances: [] });
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  const local = await transcribePath('/media/uploads/b.wav');
  assert.equal(local.words[0]?.speaker, null);
  assert.ok(localCalls.some((call) => call.includes('/api/asr/transcribe')), 'faster-whisper route uses local ASR endpoint');

  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url === '/api/keys') {
      return Response.json({ models: { PREFERRED_TRANSCRIPTION_VENDOR: 'faster-whisper' } });
    }
    if (url === '/media/uploads/missing-local.wav' && init?.method === 'HEAD') {
      return new Response(null, { status: 200, headers: { 'content-length': '3' } });
    }
    if (url === '/api/asr/transcribe') {
      return Response.json({ error: 'missing' }, { status: 404 });
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  await assert.rejects(() => transcribePath('/media/uploads/missing-local.wav'), (error) => (
    error instanceof TranscriptionError && error.code === 'source-unavailable'
  ));

  const autoLocalCalls: string[] = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    autoLocalCalls.push(`${init?.method ?? 'GET'} ${url}`);
    if (url === '/api/keys') {
      return Response.json({
        keys: { ASSEMBLYAI_API_KEY: { configured: false } },
        models: {},
        asr: { fasterWhisper: { installed: true } },
      });
    }
    if (url === '/media/uploads/c.wav' && init?.method === 'HEAD') {
      return new Response(null, { status: 200, headers: { 'content-length': '3' } });
    }
    if (url === '/api/asr/transcribe') {
      return Response.json({ text: '自动本地', words: [{ text: '自动本地', start: 0, end: 300, speaker: null }], utterances: [] });
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  await transcribePath('/media/uploads/c.wav');
  assert.ok(autoLocalCalls.some((call) => call.includes('/api/asr/transcribe')), 'installed local ASR is used when AssemblyAI is not configured');

  const fallbackCalls: string[] = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    fallbackCalls.push(`${init?.method ?? 'GET'} ${url}`);
    if (url === '/api/keys') {
      return Response.json({
        keys: { ASSEMBLYAI_API_KEY: { configured: true } },
        models: {},
        asr: { fasterWhisper: { installed: true } },
      });
    }
    if (url === '/media/uploads/d.wav' && init?.method === 'HEAD') {
      return new Response(null, { status: 200, headers: { 'content-length': '3' } });
    }
    if (url === '/media/uploads/d.wav') {
      return new Response(new Blob(['wav'], { type: 'audio/wav' }));
    }
    if (url === '/assemblyai/v2/upload') {
      return new Response('unauthorized', { status: 401 });
    }
    if (url === '/api/asr/transcribe') {
      return Response.json({ text: '回退本地', words: [{ text: '回退本地', start: 0, end: 300, speaker: null }], utterances: [] });
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  await transcribePath('/media/uploads/d.wav');
  assert.ok(fallbackCalls.some((call) => call.includes('/assemblyai/v2/upload')), 'AssemblyAI was attempted first');
  assert.ok(fallbackCalls.some((call) => call.includes('/api/asr/transcribe')), 'AssemblyAI auth failure falls back to local ASR');
} finally {
  globalThis.fetch = originalFetch;
  resetMediaBlobMemory();
}

console.log('assemblyai.check: ok');
