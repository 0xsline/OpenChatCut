// Cold-load derivative 500s. When a project with freshly imported media first
// renders, React mounts the preview hooks, tears them down (StrictMode remount /
// page reload) and remounts immediately. The teardown aborts the in-flight
// /api/waveform + /api/filmstrip fetch; the server aborts the ffmpeg build.
//
// Two independent defects turned that into "POST /api/waveform 500" on first visit
// (self-healing on refresh):
//   1. DerivativeQueue kept the aborted job registered while the killed child was
//      still exiting, so the remount's retry attached to a promise that was
//      already doomed to reject with AbortError — a live request got the
//      cancellation as its answer.
//   2. handleDerivativeError classified every non-spawn error as 500, including
//      that AbortError.
// Both are asserted below, along with the cache/error behaviour that must not change.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';

// The upload root comes from the runtime profile, resolved when media-dir loads.
process.env.OPENCHATCUT_DATA_DIR = mkdtempSync(join(tmpdir(), 'derivative-queue-verify-'));

const { ffmpegBin } = await import('../server/media-binaries.ts');
const { uploadDir } = await import('../server/media-dir.ts');
const { DerivativeQueue } = await import('../server/derivative-queue.ts');
const {
  handleDerivativeError, isDerivativeCancellation, mediaPreviewPlugin, previewCachePath,
} = await import('../server/plugins/media-preview.ts');

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function abortError(): Error {
  const error = new Error('derivative request cancelled');
  error.name = 'AbortError';
  return error;
}

// ── 1. The regression: a retry during teardown must not inherit AbortError ──
{
  const queue = new DerivativeQueue(1);
  let abortSeen = false;
  const first = queue.acquire('peaks-key', (signal) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => {
      abortSeen = true;
      // ffmpeg dies a few ticks after SIGKILL — exactly the window a remount
      // retry arrives in.
      setTimeout(() => reject(abortError()), 15);
    });
  }));
  void first.promise.catch(() => {}); // the cancelled consumer is gone
  await tick();
  first.release();
  assert.equal(abortSeen, true, 'releasing the last consumer must abort the running build');

  const retry = queue.acquire('peaks-key', () => Promise.resolve('fresh build'));
  assert.equal(
    await retry.promise,
    'fresh build',
    'a request arriving while the cancelled child exits must rebuild, not receive its AbortError',
  );
  retry.release();
}

// ── 2. Unchanged: concurrent requests still share one completed build ──
{
  const queue = new DerivativeQueue(1);
  let runs = 0;
  const work = async () => { runs += 1; return 'v'; };
  const a = queue.acquire('shared-key', work);
  const b = queue.acquire('shared-key', work);
  assert.deepEqual(await Promise.all([a.promise, b.promise]), ['v', 'v']);
  assert.equal(runs, 1, 'concurrent consumers share one build');
  a.release();
  b.release();
}

// ── 3. AbortError is a retryable "not ready", never a 500 ──
interface FakeResponse { statusCode: number; body: string; destroyed: boolean; writableEnded: boolean }
function fakeResponse(): { res: ServerResponse; seen: FakeResponse; headers: Record<string, string> } {
  const headers: Record<string, string> = {};
  const seen: FakeResponse = { statusCode: 0, body: '', destroyed: false, writableEnded: false };
  const res = {
    get statusCode() { return seen.statusCode; },
    set statusCode(value: number) { seen.statusCode = value; },
    get destroyed() { return seen.destroyed; },
    get writableEnded() { return seen.writableEnded; },
    setHeader(name: string, value: string) { headers[name.toLowerCase()] = String(value); },
    end(chunk?: string) { seen.body = String(chunk ?? ''); seen.writableEnded = true; },
  };
  return { res: res as unknown as ServerResponse, seen, headers };
}

assert.equal(isDerivativeCancellation(abortError()), true);
assert.equal(isDerivativeCancellation(new Error('boo')), false);

{
  const { res, seen, headers } = fakeResponse();
  const logged: string[] = [];
  handleDerivativeError(res, (message) => logged.push(message), 'waveform', abortError());
  assert.equal(seen.statusCode, 503, 'a cancelled build must not answer 500');
  assert.equal(headers['retry-after'], '1');
  assert.deepEqual(JSON.parse(seen.body), { error: 'derivative not ready', retryable: true });
  assert.deepEqual(logged, [], 'a client cancellation is not a server error to log');
}

{
  const { res, seen } = fakeResponse();
  const logged: string[] = [];
  handleDerivativeError(res, (message) => logged.push(message), 'waveform', new Error('ffmpeg peaks exit 1: bad input'));
  assert.equal(seen.statusCode, 500, 'a real build failure still surfaces as an error');
  assert.deepEqual(logged, ['[waveform] ffmpeg peaks exit 1: bad input']);
}

{
  const { res, seen } = fakeResponse();
  handleDerivativeError(res, () => undefined, 'filmstrip', new Error('spawn ffmpeg ENOENT'));
  assert.equal(seen.statusCode, 503, 'a missing binary is "unavailable", not "internal error"');
}

{
  const { res, seen } = fakeResponse();
  seen.destroyed = true;
  handleDerivativeError(res, () => undefined, 'waveform', abortError());
  assert.equal(seen.statusCode, 0, 'nothing is written to a socket that is already gone');
}

// ── 4. Live routes: a completed build is cached and served; real errors still error ──
const uploads = uploadDir();
await mkdir(uploads, { recursive: true });
const tone = join(uploads, 'verify-tone.wav');
const garbage = join(uploads, 'verify-garbage.mp4');
await new Promise<void>((resolve, reject) => {
  const child = spawn(ffmpegBin(), ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.5', tone]);
  child.on('error', reject);
  child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exit ${code}`))));
});
await writeFile(garbage, 'this is not media');

const routes = new Map<string, (req: IncomingMessage, res: ServerResponse) => void>();
const logged: string[] = [];
const fakeVite = {
  config: { logger: { error: (message: string) => logged.push(message) } },
  middlewares: { use: (path: string, handler: (req: IncomingMessage, res: ServerResponse) => void) => { routes.set(path, handler); } },
  httpServer: null,
};
const configure = mediaPreviewPlugin().configureServer;
if (typeof configure !== 'function') throw new Error('media-preview plugin must configure routes');
configure(fakeVite as never);
assert.deepEqual([...routes.keys()].sort(), [
  '/api/filmstrip', '/api/media-frame', '/api/media-poster', '/api/preview-proxy', '/api/preview-proxy-file', '/api/waveform',
]);

const server = createServer((req, res) => {
  const path = (req.url ?? '/').split('?', 1)[0]!;
  const handler = routes.get(path);
  if (!handler) { res.statusCode = 404; res.end(); return; }
  handler(req, res);
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const address = server.address();
if (!address || typeof address === 'string') throw new Error('no port');
const origin = `http://127.0.0.1:${address.port}`;
const waveform = (src: string) => fetch(`${origin}/api/waveform?src=${encodeURIComponent(src)}`);

try {
  const first = await waveform('/media/uploads/verify-tone.wav');
  assert.equal(first.status, 200);
  const firstBody = await first.text();

  const cache = previewCachePath('verify-tone.wav', await stat(tone).then((s) => ({ size: s.size, mtimeMs: s.mtimeMs })), 'peaks', 'json');
  assert.ok(await stat(cache).then((s) => s.isFile(), () => false), 'the completed build is cached');

  const second = await waveform('/media/uploads/verify-tone.wav');
  assert.equal(second.status, 200);
  assert.equal(await second.text(), firstBody, 'the cached build is served byte-identically');
  assert.deepEqual(JSON.parse(firstBody).peaksPerSecond, 100);
  assert.ok(JSON.parse(firstBody).peaks.length > 0, 'the tone produced peaks');

  const broken = await waveform('/media/uploads/verify-garbage.mp4');
  assert.equal(broken.status, 500, 'a real ffprobe failure is still an error');
  assert.match(String(((await broken.json()) as { error?: string }).error), /ffprobe/);

  const missing = await waveform('/media/uploads/no-such-file.mp4');
  assert.equal(missing.status, 404);
} finally {
  server.close();
  await rm(process.env.OPENCHATCUT_DATA_DIR!, { recursive: true, force: true });
}

console.log('derivative-queue checks passed (cancelled build stays retryable, completed build cached, real errors surface)');
