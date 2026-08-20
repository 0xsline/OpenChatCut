import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type ViteDevServer } from 'vite';
import { seedKeystore } from '../keystore.ts';
import { extractAudioPlugin } from './extract-audio.ts';

const source = await readFile(new URL('./extract-audio.ts', import.meta.url), 'utf8');
assert.doesNotMatch(source, /\bspawn\(ffprobeBin\(\)/, 'ffprobe must use the shared low-priority process launcher');

const directory = await mkdtemp(join(tmpdir(), 'openchatcut-extract-audio-'));
const previousProbe = process.env.OPENCHATCUT_FFPROBE;
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
  await rm(directory, { recursive: true, force: true });
}

console.log('extract-audio.verify: no-audio compatibility passed');
