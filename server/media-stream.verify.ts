// Run: npx tsx server/media-stream.verify.ts
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { unlinkSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, get, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMiniConnect } from '../desktop/mini-connect.ts';
import { distStaticMiddleware } from '../desktop/static-files.ts';
import { serveDiskFile } from './media-dir.ts';

const root = await mkdtemp(join(tmpdir(), 'occ-media-stream-check-'));
const errors: NodeJS.ErrnoException[] = [];
const app = createMiniConnect((error) => errors.push(error as NodeJS.ErrnoException));
const content = '0123456789';
let cancelDone: Promise<unknown> | undefined;

function removeOnHeaders(res: ServerResponse, file: string): void {
  const original = res.writeHead.bind(res);
  res.writeHead = ((...args: Parameters<ServerResponse['writeHead']>) => {
    unlinkSync(file);
    return original(...args);
  }) as ServerResponse['writeHead'];
}

app.use(async (req, res, next) => {
  const file = join(root, req.url!.slice(1));
  if (req.url === '/race.mp4') removeOnHeaders(res, file);
  if (req.url === '/cancel.mp4') {
    cancelDone = serveDiskFile(req, res, file).catch((error: NodeJS.ErrnoException) => error);
    return;
  }
  if (req.url?.endsWith('.mp4') || req.url?.endsWith('.svg')) return serveDiskFile(req, res, file);
  if (req.url === '/race.js') removeOnHeaders(res, file);
  next();
});
app.use(distStaticMiddleware(root));
const server = createServer((req, res) => app.handle(req, res));

try {
  await mkdir(join(root, 'assets'));
  for (const file of ['clip.mp4', 'race.mp4', 'app.js', 'race.js']) await writeFile(join(root, file), content);
  await writeFile(join(root, 'empty.mp4'), '');
  await writeFile(join(root, 'art.svg'), '<svg/>');
  await writeFile(join(root, 'index.html'), '<html>fixture</html>');
  await writeFile(join(root, 'cancel.mp4'), Buffer.alloc(8 * 1024 * 1024));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  for (const path of ['/clip.mp4', '/app.js']) {
    const full = await fetch(origin + path);
    assert.equal(full.status, 200);
    assert.equal(full.headers.get('content-length'), '10');
    assert.equal(await full.text(), content);
    const head = await fetch(origin + path, { method: 'HEAD' });
    assert.equal(head.headers.get('content-length'), '10');
    assert.equal(await head.text(), '');
  }
  for (const [range, expected, contentRange] of [
    ['bytes=2-5', '2345', 'bytes 2-5/10'], ['bytes=-3', '789', 'bytes 7-9/10'], ['bytes=7-', '789', 'bytes 7-9/10'],
  ]) {
    const response = await fetch(`${origin}/clip.mp4`, { headers: { range: range! } });
    assert.equal(response.status, 206);
    assert.equal(response.headers.get('content-range'), contentRange);
    assert.equal(await response.text(), expected);
  }
  for (const path of ['/clip.mp4', '/empty.mp4']) {
    const response = await fetch(origin + path, { headers: { range: 'bytes=10-20' } });
    assert.equal(response.status, 416);
    await response.text();
  }
  const empty = await fetch(`${origin}/empty.mp4`);
  assert.equal(empty.status, 200);
  assert.equal(empty.headers.get('content-length'), '0');
  assert.equal(await empty.text(), '');
  const svg = await fetch(`${origin}/art.svg`, { headers: { 'sec-fetch-dest': 'document' } });
  assert.equal(svg.headers.get('content-security-policy'), 'sandbox');
  assert.ok(svg.headers.get('content-disposition')?.startsWith('attachment;'));
  await svg.text();
  assert.equal(await (await fetch(`${origin}/editor-route`)).text(), '<html>fixture</html>');
  for (const path of ['/race.mp4', '/race.js']) {
    await assert.rejects(async () => { await (await fetch(origin + path)).text(); });
  }
  assert.deepEqual(errors.map((error) => error.code), ['ENOENT', 'ENOENT'], 'async source errors reach existing middleware catch');
  await new Promise<void>((resolve, reject) => {
    get(`${origin}/cancel.mp4`, (res) => {
      res.once('data', () => { res.destroy(); resolve(); });
      res.on('error', () => undefined);
    }).on('error', reject);
  });
  assert.ok(cancelDone);
  const cancelled = await cancelDone as NodeJS.ErrnoException;
  assert.equal(cancelled.code, 'ERR_STREAM_PREMATURE_CLOSE', 'client disconnect stops the source and settles the handler');
  console.log('media-stream.verify: ok (GET/HEAD/Range/empty/SVG/SPA, read failures, client cancellation)');
} finally {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  await rm(root, { recursive: true, force: true });
}
