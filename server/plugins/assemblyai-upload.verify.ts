import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleAssemblyAiUpload } from './assemblyai-upload';

const root = await mkdtemp(join(tmpdir(), 'openchatcut-asr-upload-'));
const media = join(root, 'speech.wav');
const bytes = Buffer.from('streamed-audio-bytes');
await writeFile(media, bytes);

let upstreamCalls = 0;
const server = createServer((req, res) => {
  void handleAssemblyAiUpload(req, res, {
    getApiKey: () => 'test-key',
    resolveFile: (name) => name === 'speech.wav' ? media : null,
    fetchUpstream: async (input, init) => {
      upstreamCalls += 1;
      assert.equal(String(input), 'https://api.assemblyai.com/v2/upload');
      assert.equal(new Headers(init?.headers).get('authorization'), 'test-key');
      assert.equal(new Headers(init?.headers).get('content-length'), String(bytes.length));
      const uploaded = Buffer.from(await new Response(init?.body as BodyInit).arrayBuffer());
      assert.deepEqual(uploaded, bytes, 'the local file is streamed intact to AssemblyAI');
      return Response.json({ upload_url: 'https://assembly.example/upload/streamed' });
    },
  });
});

await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
assert.ok(address && typeof address === 'object');
const endpoint = `http://127.0.0.1:${address.port}/api/assemblyai-upload`;
const editorOrigin = new URL(endpoint).origin;
const editorJsonHeaders = { 'content-type': 'application/json', origin: editorOrigin };

try {
  const uploaded = await fetch(endpoint, {
    method: 'POST',
    headers: editorJsonHeaders,
    body: JSON.stringify({ src: '/media/uploads/speech.wav' }),
  });
  assert.equal(uploaded.status, 200);
  assert.deepEqual(await uploaded.json(), {
    uploadUrl: 'https://assembly.example/upload/streamed',
    bytes: bytes.length,
  });
  assert.equal(upstreamCalls, 1);
  const missingOrigin = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ src: '/media/uploads/speech.wav' }),
  });
  assert.equal(missingOrigin.status, 401);
  assert.equal(upstreamCalls, 1, 'a mutation without Origin never reaches the provider');

  const crossOrigin = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'text/plain', origin: 'https://evil.example' },
    body: JSON.stringify({ src: '/media/uploads/speech.wav' }),
  });
  assert.equal(crossOrigin.status, 401);
  assert.equal(upstreamCalls, 1, 'a cross-site simple POST never reaches the provider');

  const rebound = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      host: 'evil.example',
      origin: 'http://evil.example',
    },
    body: JSON.stringify({ src: '/media/uploads/speech.wav' }),
  });
  assert.equal(rebound.status, 401);
  assert.equal(upstreamCalls, 1, 'attacker-controlled matching Host and Origin never reach the provider');

  const textPlain = await fetch(endpoint, {
    method: 'POST',
    headers: { ...editorJsonHeaders, 'content-type': 'text/plain' },
    body: JSON.stringify({ src: '/media/uploads/speech.wav' }),
  });
  assert.equal(textPlain.status, 415);
  assert.equal(upstreamCalls, 1, 'non-JSON requests never reach the provider');


  const unsafe = await fetch(endpoint, {
    method: 'POST',
    headers: editorJsonHeaders,
    body: JSON.stringify({ src: '/media/uploads/../secret' }),
  });
  assert.equal(unsafe.status, 400);
  assert.equal(upstreamCalls, 1, 'unsafe paths never reach the provider');

  const missing = await fetch(endpoint, {
    method: 'POST',
    headers: editorJsonHeaders,
    body: JSON.stringify({ src: '/media/uploads/missing.wav' }),
  });
  assert.equal(missing.status, 404);
  assert.equal(upstreamCalls, 1);

  const oversized = await fetch(endpoint, {
    method: 'POST',
    headers: editorJsonHeaders,
    body: JSON.stringify({ src: `/media/uploads/${'a'.repeat(9_000)}` }),
  });
  assert.equal(oversized.status, 413);
  assert.equal(upstreamCalls, 1);
} finally {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  await rm(root, { recursive: true, force: true });
}

console.log('assemblyai-upload.verify: ok');
