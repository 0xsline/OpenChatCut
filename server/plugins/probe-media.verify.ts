// probe_media must work with nothing but the ffprobe that ships with the app: no e2b
// key, no sandbox. The live failure was "probe_media: e2b sandbox is not configured"
// on a machine where every other media route was happily running ffprobe.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdir, mkdtempSync, rm, writeFile } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

// The upload root comes from the runtime profile, which is resolved when media-dir loads.
process.env.OPENCHATCUT_DATA_DIR = mkdtempSync(join(tmpdir(), 'probe-media-verify-'));

const { ffmpegBin } = await import('../media-binaries.ts');
const { uploadDir } = await import('../media-dir.ts');
const { parseProbe } = await import('../../src/agent/tools/probe-tools.ts');
const { probeMediaFile, probeMediaPlugin, resolveProbeSource } = await import('./probe-media.ts');

const mkdirAsync = promisify(mkdir);
const writeFileAsync = promisify(writeFile);
const rmAsync = promisify(rm);

function run(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => { stderr += String(chunk); });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(stderr.slice(-1000)))));
  });
}

// ── source resolution: only our own files and public URLs ──
assert.deepEqual(resolveProbeSource(''), { error: 'source is required' });
assert.deepEqual(resolveProbeSource('  https://example.com/a.mp4 '), { kind: 'remote', url: 'https://example.com/a.mp4' });
assert.match((resolveProbeSource('/media/uploads/../../etc/passwd') as { error: string }).error, /illegal local path/);
assert.match((resolveProbeSource('/media/uploads/missing.mp4') as { error: string }).error, /not found/);
assert.match((resolveProbeSource('file:///etc/passwd') as { error: string }).error, /unsupported source/);
assert.match((resolveProbeSource('/etc/passwd') as { error: string }).error, /not found/, 'absolute paths only resolve inside the product assets dir');

// ── fixtures: an audio-only file, a silent clip, and a file that is not media ──
const uploads = uploadDir();
await mkdirAsync(uploads, { recursive: true });
const tone = join(uploads, 'tone.wav');
const clip = join(uploads, 'clip.mp4');
await run(ffmpegBin(), ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', tone]);
await run(ffmpegBin(), [
  '-hide_banner', '-loglevel', 'error', '-y',
  '-f', 'lavfi', '-i', 'color=c=black:s=64x48:d=1:r=10',
  '-c:v', 'mpeg4', '-pix_fmt', 'yuv420p', clip,
]);
await writeFileAsync(join(uploads, 'garbage.bin'), 'this is not media');

try {
  // ── direct probe: raw ffprobe JSON that the tool's parser understands ──
  const audioOnly = parseProbe(await probeMediaFile(tone));
  assert.equal(audioOnly.hasAudioTrack, true);
  assert.equal(audioOnly.hasVideoTrack, false, 'an mp3/wav has no video stream');
  assert.ok(audioOnly.durationSeconds && Math.abs(audioOnly.durationSeconds - 1) < 0.1, `duration ${audioOnly.durationSeconds}`);

  const silent = parseProbe(await probeMediaFile(clip));
  assert.equal(silent.hasVideoTrack, true);
  assert.equal(silent.hasAudioTrack, false, 'silent b-roll must not start transcription');
  assert.equal(silent.width, 64);
  assert.equal(silent.height, 48);
  assert.equal(silent.fps, 10);

  await assert.rejects(probeMediaFile(join(uploads, 'garbage.bin')), /ffprobe exited/);
  await assert.rejects(probeMediaFile(join(uploads, 'nope.mp4')), /ffprobe exited/);

  // ── the route: what the browser tool actually calls ──
  let routeHandler: ((req: IncomingMessage, res: ServerResponse) => void) | null = null;
  const configureServer = probeMediaPlugin().configureServer;
  if (typeof configureServer !== 'function') throw new Error('probe-media plugin must configure a server route');
  configureServer({
    config: { logger: { error: () => undefined } },
    middlewares: {
      use(path: string, handler: (req: IncomingMessage, res: ServerResponse) => void) {
        assert.equal(path, '/api/probe-media');
        routeHandler = handler;
      },
    },
  } as never);
  assert.ok(routeHandler, 'route registered');

  const server = createServer((req, res) => routeHandler!(req, res));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no port');
  const endpoint = `http://127.0.0.1:${address.port}/api/probe-media`;
  const post = async (body: unknown): Promise<{ status: number; json: Record<string, unknown> }> => {
    const response = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, json: (await response.json()) as Record<string, unknown> };
  };
  try {
    const ok = await post({ source: '/media/uploads/tone.wav' });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.ok, true);
    assert.equal(parseProbe(ok.json.probe).hasAudioTrack, true);
    assert.doesNotMatch(JSON.stringify(ok.json), /e2b|sandbox/i);

    const video = await post({ source: '/media/uploads/clip.mp4' });
    assert.equal(video.status, 200);
    assert.deepEqual(
      [parseProbe(video.json.probe).width, parseProbe(video.json.probe).height],
      [64, 48],
    );

    const traversal = await post({ source: '/media/uploads/../../etc/passwd' });
    assert.equal(traversal.status, 400);
    assert.match(String(traversal.json.error), /illegal local path/);

    const unreadable = await post({ source: '/media/uploads/garbage.bin' });
    assert.equal(unreadable.status, 400);
    assert.match(String(unreadable.json.error), /ffprobe exited/);

    const missing = await post({ source: '/media/uploads/nope.mp4' });
    assert.equal(missing.status, 400);
    assert.match(String(missing.json.error), /not found/);

    const empty = await post({});
    assert.equal(empty.status, 400);
    assert.match(String(empty.json.error), /source is required/);

    const get = await fetch(endpoint);
    assert.equal(get.status, 405);
    await get.body?.cancel();
  } finally {
    server.close();
  }
} finally {
  await rmAsync(process.env.OPENCHATCUT_DATA_DIR!, { recursive: true, force: true });
}

console.log('probe-media checks passed (local ffprobe: audio-only, silent clip, traversal, unreadable, route)');
