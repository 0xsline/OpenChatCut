import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, type IncomingMessage } from 'node:http';
import { createMiniConnect } from '../desktop/mini-connect.ts';
import { proxyMiddleware } from './proxy.ts';

async function body(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

let received: Record<string, string | undefined> | undefined;
const upstream = createServer((req, res) => {
  void body(req).then((requestBody) => {
    received = {
      editorBootstrap: req.headers['x-openchatcut-editor-bootstrap'] as string | undefined,
      editorToken: req.headers['x-openchatcut-editor-token'] as string | undefined,
      provider: req.headers['x-openchatcut-provider'] as string | undefined,
      cookie: req.headers.cookie,
      ordinary: req.headers['x-ordinary'] as string | undefined,
      body: requestBody,
    };
    res.end('ok');
  });
});
upstream.listen(0, '127.0.0.1');
await once(upstream, 'listening');
const upstreamAddress = upstream.address();
assert(upstreamAddress && typeof upstreamAddress === 'object');

const app = createMiniConnect((error) => { throw error; });
app.use(proxyMiddleware({
  target: () => `http://127.0.0.1:${upstreamAddress.port}`,
  headers: () => ({}),
}));
const local = createServer((req, res) => app.handle(req, res));
local.listen(0, '127.0.0.1');
await once(local, 'listening');
const localAddress = local.address();
assert(localAddress && typeof localAddress === 'object');

try {
  const response = await fetch(`http://127.0.0.1:${localAddress.port}/relay`, {
    method: 'POST',
    headers: {
      Cookie: 'private=1',
      'X-OpenChatCut-Editor-Bootstrap': 'bootstrap-secret',
      'X-OpenChatCut-Editor-Token': 'editor-secret',
      'X-OpenChatCut-Provider': 'local-routing-only',
      'X-Ordinary': 'keep-me',
    },
    body: 'synthetic',
  });
  assert.equal(response.status, 200);
  assert.deepEqual(received, {
    editorBootstrap: undefined,
    editorToken: undefined,
    provider: undefined,
    cookie: undefined,
    ordinary: 'keep-me',
    body: 'synthetic',
  });
} finally {
  local.close();
  upstream.close();
  await Promise.all([once(local, 'close'), once(upstream, 'close')]);
}

console.log('proxy.verify: local capability headers are never forwarded upstream');
