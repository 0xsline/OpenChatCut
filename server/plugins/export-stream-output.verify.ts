// Regression gate for the sync `/export` response path.
//
// The route used to pull the finished render into one Buffer with `readFile`,
// which rejects above 2 GiB (ERR_FS_FILE_TOO_LARGE) — after the render had
// already finished, and with the route's cleanup then deleting the file. These
// checks pin the streaming delivery, the >2 GiB ceiling, and the cleanup rule.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import { connect } from 'node:net';
import { mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { streamExportFile } from './export-http.ts';

const route = await readFile(new URL('./export-job-routes.ts', import.meta.url), 'utf8');
assert.doesNotMatch(
  route,
  /\breadFile\(/,
  'the export route must never buffer a rendered output — readFile refuses files ≥2 GiB',
);
assert.match(
  route,
  /await streamExportFile\(res, finalOutput,/,
  'the route must deliver the finished render through the streaming helper',
);
assert.doesNotMatch(
  route,
  /Content-Length', String\(buffer\.length\)/,
  'Content-Length must come from stat, not from an in-memory buffer',
);
// Cleanup must stay for failed renders, and must not run for a completed one.
assert.match(route, /if \(!keepRenderedOutput\) \{\n {8}if \(outputLocation\)/, 'failed renders must still be deleted');
assert.match(route, /keepRenderedOutput = rendered && !aborted;/, 'a finished render must survive a failed transfer');

const directory = await mkdtemp(join(tmpdir(), 'occ-export-stream-'));
let server: Server | undefined;
try {
  const payload = Buffer.alloc(3 * 1024 * 1024 + 7654);
  for (let index = 0; index < payload.length; index += 1) payload[index] = (index * 31 + 7) % 251;
  const file = join(directory, 'finished.mp4');
  await writeFile(file, payload);
  const empty = join(directory, 'empty.mp4');
  await writeFile(empty, Buffer.alloc(0));
  // Sparse: stat reports >2 GiB without allocating it, which is exactly the
  // boundary `readFile` refuses and the old route could never get past.
  const huge = join(directory, 'hour-long.mp4');
  const hugeSize = 2 * 1024 ** 3 + 4096;
  await sparseFile(huge, hugeSize);
  const slow = join(directory, 'abortable.mp4');
  await sparseFile(slow, 256 * 1024 * 1024);

  const aborted = new AbortController();
  const outcomes = new Map<string, string>();
  server = createServer((req, res) => {
    const url = req.url ?? '/';
    const deliver = url.startsWith('/slow')
      ? streamExportFile(res, slow, { mime: 'video/mp4', filename: 'slow.mp4', signal: aborted.signal })
      : url.startsWith('/huge')
        ? streamExportFile(res, huge, { mime: 'video/mp4', filename: 'hour long 导出.mp4' })
        : streamExportFile(res, url.startsWith('/empty') ? empty : file, {
          mime: 'video/mp4',
          filename: url.startsWith('/empty') ? 'empty.mp4' : 'clip 名.mp4',
        });
    deliver.then(
      () => outcomes.set(url, 'resolved'),
      (error: unknown) => outcomes.set(url, error instanceof Error ? error.message : String(error)),
    ).catch(() => undefined);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no TCP address');
  const port = address.port;

  const full = await rawRequest(port, '/full');
  assert.equal(full.status, 'HTTP/1.1 200 OK');
  assert.equal(full.headers['content-length'], String(payload.length));
  assert.equal(full.headers['content-type'], 'video/mp4');
  assert.match(full.headers['content-disposition'] ?? '', /^attachment; filename="clip _\.mp4"; filename\*=UTF-8''clip%20/);
  assert.equal(full.headers['transfer-encoding'], undefined, 'a known length must not be sent chunked');
  assert.equal(full.body.length, payload.length);
  assert.equal(
    createHash('sha256').update(full.body).digest('hex'),
    createHash('sha256').update(payload).digest('hex'),
    'the streamed bytes must be identical to the rendered file',
  );
  // 3 MiB through a 64 KiB read stream arrives as many writes; one giant write
  // would mean the whole file was buffered before sending.
  assert.ok(full.chunks.length >= 8, `expected a streamed body, saw ${full.chunks.length} write(s)`);
  assert.ok(Math.max(...full.chunks) < payload.length, 'no single write may carry the whole file');
  await delay(50);
  assert.equal(outcomes.get('/full'), 'resolved', 'a delivered file must settle without an error');

  const emptyResponse = await rawRequest(port, '/empty');
  assert.equal(emptyResponse.headers['content-length'], '0');
  assert.equal(emptyResponse.body.length, 0);

  // A >2 GiB output must be advertised and streamed instead of throwing.
  const hugeResponse = await rawRequest(port, '/huge', { destroyAfterBytes: 256 * 1024 });
  assert.equal(hugeResponse.status, 'HTTP/1.1 200 OK');
  assert.equal(hugeResponse.headers['content-length'], String(hugeSize));
  assert.ok(
    hugeResponse.body.length > 128 * 1024 && hugeResponse.body.length < hugeSize,
    `the client read the beginning of the real file (${hugeResponse.body.length} bytes)`,
  );
  await waitFor(() => outcomes.has('/huge'), 'the destroyed transfer must settle');
  assert.notEqual(outcomes.get('/huge'), 'resolved', 'a client that disconnected mid-stream is not a completed delivery');

  // An aborted signal must stop the copy, not leave it running to the end.
  const signalRequest = rawRequest(port, '/slow');
  await delay(20);
  aborted.abort(new DOMException('Client disconnected', 'AbortError'));
  const signalResponse = await signalRequest;
  assert.equal(signalResponse.headers['content-length'], String(256 * 1024 * 1024));
  assert.ok(signalResponse.body.length < 256 * 1024 * 1024, 'the copy stopped early instead of finishing');
  await waitFor(() => outcomes.has('/slow'), 'the aborted transfer must settle');
  assert.match(outcomes.get('/slow') ?? '', /abort/i, `an aborted copy must reject with the abort reason, saw ${outcomes.get('/slow')}`);

  // A signal that is already aborted must not start a response at all.
  const preAborted = new AbortController();
  preAborted.abort(new DOMException('Client disconnected', 'AbortError'));
  await assert.rejects(
    () => streamExportFile(neverWrite(), file, {
      mime: 'video/mp4',
      filename: 'x.mp4',
      signal: preAborted.signal,
    }),
    /abort/i,
  );
} finally {
  if (server) {
    server.close();
    server.closeAllConnections();
  }
  await rm(directory, { recursive: true, force: true });
}

async function sparseFile(path: string, size: number): Promise<void> {
  const handle = await open(path, 'w');
  await handle.truncate(size);
  await handle.close();
}

interface RawResponse {
  status: string;
  headers: Record<string, string>;
  body: Buffer;
  chunks: number[];
}

async function rawRequest(
  port: number,
  path: string,
  options: { destroyAfterBytes?: number } = {},
): Promise<RawResponse> {
  const socket = connect({ port, host: '127.0.0.1' });
  const chunks: Buffer[] = [];
  const sizes: number[] = [];
  let total = 0;
  socket.on('data', (chunk: Buffer) => {
    chunks.push(chunk);
    sizes.push(chunk.length);
    total += chunk.length;
    if (options.destroyAfterBytes !== undefined && total >= options.destroyAfterBytes) socket.destroy();
  });
  await once(socket, 'connect');
  socket.write(`GET ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`);
  await once(socket, 'close');
  const raw = Buffer.concat(chunks);
  const headerEnd = raw.indexOf('\r\n\r\n');
  assert.ok(headerEnd > 0, `no HTTP response for ${path}`);
  const lines = raw.subarray(0, headerEnd).toString('latin1').split('\r\n');
  const headers: Record<string, string> = {};
  for (const line of lines.slice(1)) {
    const index = line.indexOf(':');
    if (index > 0) headers[line.slice(0, index).toLowerCase()] = line.slice(index + 1).trim();
  }
  return {
    status: lines[0] ?? '',
    headers,
    body: raw.subarray(headerEnd + 4),
    chunks: sizes.length > 1 ? sizes.slice(0, -1) : sizes,
  };
}

async function waitFor(check: () => boolean, message: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (check()) return;
    await delay(20);
  }
  assert.fail(message);
}

/** ServerResponse stand-in that fails the test if the pre-abort path writes anything. */
function neverWrite() {
  const state = {
    headersSent: false,
    setHeader: () => { throw new Error('no header may be written for an aborted request'); },
    end: () => { throw new Error('no body may be written for an aborted request'); },
    destroy: () => { throw new Error('nothing was started, so nothing may be destroyed'); },
  };
  return state as unknown as Parameters<typeof streamExportFile>[0];
}

console.log('export streaming verification passed');
