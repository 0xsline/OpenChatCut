import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { editorApiToken, externalMcpToken } from '../server/editor-auth.ts';
import { runDesktopSmokeProbe } from './smoke-probe.ts';

const requests: Array<{
  path: string;
  method: string | undefined;
  authorization: string | undefined;
  origin: string | undefined;
  token: string | undefined;
}> = [];
const server = createServer((req, res) => {
  requests.push({
    path: req.url ?? '',
    method: req.method,
    authorization: req.headers.authorization,
    origin: typeof req.headers.origin === 'string' ? req.headers.origin : undefined,
    token: typeof req.headers['x-openchatcut-editor-token'] === 'string'
      ? req.headers['x-openchatcut-editor-token']
      : undefined,
  });
  res.setHeader('Content-Type', 'application/json');
  if (req.url === '/api/keys') res.end('{}');
  else if (req.url === '/api/external-mcp/mcp') res.end('{"name":"openchatcut"}');
  else if (req.url === '/render-still') res.end(JSON.stringify({ frames: [{ base64: 'synthetic' }] }));
  else { res.statusCode = 404; res.end('{}'); }
});

server.listen(0, '127.0.0.1');
await once(server, 'listening');
const address = server.address();
assert(address && typeof address === 'object');
const origin = `http://127.0.0.1:${address.port}`;
const executed: string[] = [];
const win = {
  webContents: {
    executeJavaScript: async (expression: string) => {
      executed.push(expression);
      if (expression.includes('selectDirectory') || expression.includes('updates?.check')) return 'function';
      return {
        version: 3,
        asr: { available: false },
        semantic: { available: false },
        clap: { available: false },
        rhythm: { available: false },
      };
    },
  },
};

try {
  await runDesktopSmokeProbe(origin, win as never, false);
  assert.equal(executed.length, 3);
  assert.deepEqual(requests.map((request) => request.path), [
    '/api/keys',
    '/api/external-mcp/mcp',
  ]);
  assert.equal(requests[0]?.token, editorApiToken());
  assert.equal(requests[1]?.token, undefined, 'MCP must not receive the editor token');
  assert.equal(requests[1]?.authorization, `Bearer ${externalMcpToken()}`);

  requests.length = 0;
  executed.length = 0;
  await runDesktopSmokeProbe(origin, win as never, true);
  assert.equal(executed.length, 3);
  assert.deepEqual(requests.map((request) => request.path), [
    '/api/keys',
    '/api/external-mcp/mcp',
    '/render-still',
  ]);
  const render = requests[2];
  assert.equal(render?.method, 'POST');
  assert.equal(render?.origin, origin);
  assert.equal(render?.token, editorApiToken());
} finally {
  server.close();
  await once(server, 'close');
}

console.log('smoke-probe.verify: desktop requests use independent editor and MCP auth');
