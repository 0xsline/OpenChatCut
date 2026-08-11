import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { transcriptionPlugin } from './transcription.ts';
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
  language: 'en',
  diarization: false,
};

let routeHandler: ((req: IncomingMessage, res: ServerResponse) => void) | null = null;
const configureServer = transcriptionPlugin(options).configureServer;
assert.equal(typeof configureServer, 'function');
if (typeof configureServer !== 'function') throw new Error('transcription plugin must configure a server route');
configureServer({
  config: { logger: { error: () => undefined } },
  middlewares: {
    use(path: string, handler: (req: IncomingMessage, res: ServerResponse) => void) {
      assert.equal(path, '/api/transcribe');
      routeHandler = handler;
    },
  },
} as never);

const server = createServer((req, res) => {
  const spoofedRemoteAddress = req.headers['x-test-remote-address'];
  if (typeof spoofedRemoteAddress === 'string') {
    const actualRemoteAddress = req.socket.remoteAddress;
    Object.defineProperty(req.socket, 'remoteAddress', {
      configurable: true,
      value: spoofedRemoteAddress,
    });
    res.once('finish', () => {
      Object.defineProperty(req.socket, 'remoteAddress', {
        configurable: true,
        value: actualRemoteAddress,
      });
    });
  }
  req.url = req.url?.replace(/^\/api\/transcribe/, '') ?? '/';
  if (!routeHandler) {
    res.statusCode = 500;
    res.end('transcription route was not registered');
    return;
  }
  routeHandler(req, res);
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const address = server.address();
assert(address && typeof address === 'object');
const origin = `http://127.0.0.1:${address.port}`;
const originalFetch = globalThis.fetch;
let providerCalls = 0;

globalThis.fetch = async (input, init) => {
  providerCalls += 1;
  assert.equal(String(input), 'https://api.mistral.test/v1/audio/transcriptions');
  assert.ok(init?.body instanceof FormData, 'authorized binary audio must reach the provider');
  return Response.json({
    text: 'authorized audio',
    words: [{ word: 'authorized', start: 0, end: 0.4 }],
  });
};

try {
  let response = await originalFetch(`${origin}/api/transcribe?provider=mistral`, {
    headers: { 'Content-Type': 'application/octet-stream', Origin: origin },
  });
  assert.equal(response.status, 405, 'the route accepts POST only');
  assert.equal(providerCalls, 0);

  response = await originalFetch(`${origin}/api/transcribe?provider=invalid`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: 'must-not-be-forwarded',
  });
  assert.equal(response.status, 401,
    'a request without the editor Origin is rejected before query parsing');
  assert.equal(providerCalls, 0);

  response = await originalFetch(`${origin}/api/transcribe?provider=invalid`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/octet-stream',
      Origin: origin,
      'X-Test-Remote-Address': '192.0.2.44',
    },
    body: 'must-not-be-forwarded',
  });
  assert.equal(response.status, 401,
    'matching Host and Origin cannot spoof a non-loopback socket');
  assert.equal(providerCalls, 0);

  response = await originalFetch(`${origin}/api/transcribe?provider=invalid`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain', Origin: 'https://evil.example' },
    body: 'cross-site simple body',
  });
  assert.equal(response.status, 401,
    'a cross-site simple request is rejected by editor authorization');
  assert.equal(providerCalls, 0);

  response = await originalFetch(`${origin}/api/transcribe?provider=invalid`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain', Origin: origin },
    body: 'simple cross-site-compatible body',
  });
  assert.equal(response.status, 415,
    'a simple content type is rejected before query parsing');
  assert.equal(providerCalls, 0);

  response = await originalFetch(`${origin}/api/transcribe?provider=invalid`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream; charset=binary', Origin: origin },
    body: 'parameterized body',
  });
  assert.equal(response.status, 415,
    'content-type parameters are not accepted without an explicit parser');
  assert.equal(providerCalls, 0);

  response = await originalFetch(`${origin}/api/transcribe?provider=mistral&language=en&diarize=0`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream', Origin: origin },
    body: Buffer.from('audio-bytes'),
  });
  assert.equal(response.status, 200,
    'a loopback same-origin binary request reaches transcription');
  assert.equal(providerCalls, 1);
  assert.equal((await response.json() as { text: string }).text, 'authorized audio');
} finally {
  globalThis.fetch = originalFetch;
  server.close();
  await once(server, 'close');
}

console.log('transcription-route.verify: loopback authorization and binary content gate passed');
