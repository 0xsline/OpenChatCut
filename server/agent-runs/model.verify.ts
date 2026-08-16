import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { generateText } from 'ai';
import { createServerLanguageModel } from './model';

let originHeader: string | undefined;
let fetchSiteHeader: string | undefined;
const server = createServer((req, res) => {
  originHeader = req.headers.origin;
  fetchSiteHeader = req.headers['sec-fetch-site'];
  res.writeHead(400, { 'content-type': 'application/json' });
  res.end('{"error":{"message":"captured"}}');
});

await new Promise<void>((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});

try {
  const address = server.address();
  assert(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  await assert.rejects(generateText({
    model: createServerLanguageModel('deepseek', 'test-model', 'chat', origin),
    prompt: 'test',
    maxRetries: 0,
  }));
  assert.equal(originHeader, origin);
  assert.equal(fetchSiteHeader, 'same-origin');
} finally {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

console.log('agent-runs/model.verify: internal proxy request passes the origin gate');
