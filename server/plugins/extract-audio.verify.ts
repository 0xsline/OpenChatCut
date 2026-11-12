import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdtemp, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createServer, type ViteDevServer } from 'vite';
import { seedKeystore } from '../keystore.ts';
import { ffmpegBin } from '../media-binaries.ts';
import { extractAudioPlugin } from './extract-audio.ts';

const source = await readFile(new URL('./extract-audio.ts', import.meta.url), 'utf8');
assert.doesNotMatch(source, /\bspawn\(ffprobeBin\(\)/, 'ffprobe must use the shared low-priority process launcher');

const directory = await mkdtemp(join(tmpdir(), 'openchatcut-extract-audio-'));
const previousProbe = process.env.OPENCHATCUT_FFPROBE;
const previousFfmpeg = process.env.OPENCHATCUT_FFMPEG;
const tempName = /\.asr\.tmp\.(?:ogg|mp3)$/;
let server: ViteDevServer | undefined;

try {
  // A 1x1 PNG is a valid media file with no audio stream.
  await writeFile(
    join(directory, 'silent.png'),
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      'base64',
    ),
  );
  // A cached ASR artifact lets the probe-failure case complete without
  // depending on a codec implementation in this focused route test.
  await writeFile(join(directory, 'broken-probe.asr.ogg'), Buffer.from('cached-asr'));
  await writeFile(join(directory, 'broken-probe.wav'), Buffer.from('not-used'));
  // A real source with audio, for the failed-encode case below.
  const wav = join(directory, 'take.wav');
  const generated = spawnSync(ffmpegBin(), [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-ac', '1', '-ar', '16000', wav,
  ], { encoding: 'utf8' });
  assert.equal(generated.status, 0, generated.stderr);
  // Orphans from an older build (cleanup unlinked a name the encoder never wrote)
  // stay in the uploads dir forever; the plugin sweeps them at startup, and only
  // the stale ones.
  const staleTemp = join(directory, 'stale.asr.tmp.ogg');
  const freshTemp = join(directory, 'fresh.asr.tmp.ogg');
  await writeFile(staleTemp, Buffer.alloc(32));
  await writeFile(freshTemp, Buffer.alloc(32));
  const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60_000);
  await utimes(staleTemp, twoHoursAgo, twoHoursAgo);
  seedKeystore({ MEDIA_DIR: directory });

  server = await createServer({
    root: directory,
    configFile: false,
    appType: 'custom',
    logLevel: 'silent',
    plugins: [extractAudioPlugin()],
    server: { host: '127.0.0.1', port: 0 },
  });
  await server.listen();
  const address = server.httpServer?.address();
  if (!address || typeof address === 'string') throw new Error('extract-audio verification server has no TCP address');
  const origin = `http://127.0.0.1:${address.port}`;

  for (let attempt = 0; attempt < 100 && existsSync(staleTemp); attempt += 1) await delay(20);
  assert.equal(existsSync(staleTemp), false, 'a stale *.asr.tmp.* file must be swept at startup');
  assert.equal(existsSync(freshTemp), true, 'a fresh temp may belong to a live encode and must be left alone');

  // An encode that dies after creating its temp must not leave the temp behind:
  // the old cleanup unlinked `<file>.part`, a name ffmpeg never wrote.
  const stub = join(directory, 'stub-ffmpeg');
  await writeFile(stub, `#!${process.execPath}
import { writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
if (!args.includes('-i')) process.exit(0);
writeFileSync(args[args.length - 1], Buffer.alloc(20, 7));
process.exit(1);
`);
  await chmod(stub, 0o755);
  process.env.OPENCHATCUT_FFMPEG = stub;
  const failedBody = await fetch(`${origin}/api/extract-audio`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ src: '/media/uploads/take.wav', force: true }),
  });
  assert.equal(failedBody.status >= 400, true, 'a failed encode must be reported');
  const leftovers = (await readdir(directory)).filter((name) => tempName.test(name) || name.includes('.asr.ogg.part'));
  assert.deepEqual(
    leftovers.filter((name) => name.startsWith('take.')),
    [],
    `a failed encode must remove its temp, saw ${leftovers.join(', ')}`,
  );
  assert.equal(existsSync(join(directory, 'take.asr.ogg')), false, 'a failed encode publishes nothing');
  delete process.env.OPENCHATCUT_FFMPEG;

  let response = await fetch(`${origin}/api/extract-audio`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ src: '/media/uploads/silent.png' }),
  });
  const silentBody = await response.text();
  assert.equal(response.status, 422);
  assert.deepEqual(JSON.parse(silentBody), {
    ok: false,
    noAudio: true,
    error: 'source has no audio track: silent.png',
  });

  process.env.OPENCHATCUT_FFPROBE = join(directory, 'missing-ffprobe');
  response = await fetch(`${origin}/api/extract-audio`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ src: '/media/uploads/broken-probe.wav' }),
  });
  assert.equal(response.status, 200, 'probe failures must fall back to extraction/cache instead of no-audio');
  assert.deepEqual(await response.json(), {
    ok: true,
    path: '/media/uploads/broken-probe.asr.ogg',
    bytes: 'cached-asr'.length,
    cached: true,
    source: '/media/uploads/broken-probe.wav',
  });
} finally {
  if (server) {
    await server.close();
  }
  if (previousProbe === undefined) delete process.env.OPENCHATCUT_FFPROBE;
  else process.env.OPENCHATCUT_FFPROBE = previousProbe;
  if (previousFfmpeg === undefined) delete process.env.OPENCHATCUT_FFMPEG;
  else process.env.OPENCHATCUT_FFMPEG = previousFfmpeg;
  await rm(directory, { recursive: true, force: true });
}

console.log('extract-audio.verify: no-audio compatibility, temp cleanup and startup sweep passed');
