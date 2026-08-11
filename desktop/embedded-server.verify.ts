// Runnable check: `npx tsx desktop/embedded-server.verify.ts`.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, type IncomingMessage } from 'node:http';
import { createMiniConnect } from './mini-connect.ts';
import { mountAssemblyAiProxy } from './embedded-server.ts';

interface UpstreamRequest {
  method: string;
  path: string;
  authorization: string | undefined;
  body: Buffer;
}

async function requestBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

const upstreamRequests: UpstreamRequest[] = [];
const upstream = createServer((req, res) => {
  void requestBody(req).then((body) => {
    upstreamRequests.push({
      method: req.method ?? '',
      path: req.url ?? '',
      authorization: req.headers.authorization,
      body,
    });
    res.writeHead(req.method === 'POST' ? 201 : 200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
});
upstream.listen(0, '127.0.0.1');
await once(upstream, 'listening');
const upstreamAddress = upstream.address();
assert(upstreamAddress && typeof upstreamAddress === 'object');
const upstreamOrigin = `http://127.0.0.1:${upstreamAddress.port}`;

const app = createMiniConnect((error) => {
  throw error;
});
mountAssemblyAiProxy(app, {
  target: () => upstreamOrigin,
  headers: () => ({ authorization: 'test-assembly-key' }),
});
const editor = createServer((req, res) => app.handle(req, res));
editor.listen(0, '127.0.0.1');
await once(editor, 'listening');
const editorAddress = editor.address();
assert(editorAddress && typeof editorAddress === 'object');
const editorOrigin = `http://127.0.0.1:${editorAddress.port}`;
const editorHost = new URL(editorOrigin).host;

interface RequestOptions {
  method?: string;
  host?: string;
  origin?: string | null;
  body?: BodyInit;
  contentType?: string;
  secFetchSite?: string;
}

async function requestAssembly(path: string, options: RequestOptions = {}): Promise<Response> {
  const headers = new Headers();
  headers.set('Host', options.host ?? editorHost);
  if (options.origin !== null) headers.set('Origin', options.origin ?? editorOrigin);
  if (options.contentType) headers.set('Content-Type', options.contentType);
  if (options.secFetchSite) headers.set('Sec-Fetch-Site', options.secFetchSite);
  return fetch(`${editorOrigin}/assemblyai${path}`, {
    method: options.method,
    headers,
    body: options.body,
  });
}

const originalEditorUrl = process.env.OPENCHATCUT_EDITOR_URL;
try {
  delete process.env.OPENCHATCUT_EDITOR_URL;
  const reboundHost = `rebound.example:${editorAddress.port}`;
  const denied = [
    requestAssembly('/v2/upload', {
      method: 'POST',
      host: reboundHost,
      origin: `http://${reboundHost}`,
      body: new Uint8Array([1, 2, 3]),
    }),
    requestAssembly('/v2/transcript', {
      method: 'POST',
      origin: 'http://hostile.example',
      body: '{}',
      contentType: 'application/json',
    }),
    requestAssembly('/v2/transcript', {
      method: 'POST',
      origin: 'http://cross-site.example',
      secFetchSite: 'cross-site',
      body: '{}',
      contentType: 'application/json',
    }),
    requestAssembly('/v2/transcript', {
      method: 'POST',
      origin: null,
      body: '{}',
      contentType: 'application/json',
    }),
    requestAssembly('/v2/transcript/job-hostile', {
      method: 'GET',
      origin: 'http://hostile.example',
    }),
    requestAssembly('/v2/transcript/job-cross-site', {
      method: 'GET',
      origin: null,
      secFetchSite: 'cross-site',
    }),
  ];
  const deniedResponses = await Promise.all(denied);
  for (const response of deniedResponses) assert.equal(response.status, 403);
  assert.equal(upstreamRequests.length, 0, 'untrusted requests must never reach AssemblyAI');

  const binary = Buffer.from([0, 255, 1, 254, 2, 253]);
  const upload = await requestAssembly('/v2/upload', {
    method: 'POST',
    body: binary,
    contentType: 'application/octet-stream',
  });
  assert.equal(upload.status, 201);

  const createBody = JSON.stringify({ audio_url: 'https://upload.example/audio' });
  const create = await requestAssembly('/v2/transcript', {
    method: 'POST',
    body: createBody,
    contentType: 'application/json',
  });
  assert.equal(create.status, 201);

  const poll = await requestAssembly('/v2/transcript/job-1', {
    method: 'GET',
    origin: null,
  });
  assert.equal(poll.status, 200);

  assert.equal(upstreamRequests.length, 3);
  assert.deepEqual(upstreamRequests.map(({ method, path }) => ({ method, path })), [
    { method: 'POST', path: '/v2/upload' },
    { method: 'POST', path: '/v2/transcript' },
    { method: 'GET', path: '/v2/transcript/job-1' },
  ]);
  assert.deepEqual(upstreamRequests[0]?.body, binary, 'binary upload bytes must stay intact');
  assert.equal(upstreamRequests[1]?.body.toString('utf8'), createBody);
  for (const request of upstreamRequests) {
    assert.equal(request.authorization, 'test-assembly-key');
  }
} finally {
  if (originalEditorUrl === undefined) delete process.env.OPENCHATCUT_EDITOR_URL;
  else process.env.OPENCHATCUT_EDITOR_URL = originalEditorUrl;
  editor.close();
  upstream.close();
  await Promise.all([once(editor, 'close'), once(upstream, 'close')]);
}

console.log('embedded-server.verify: ok');
