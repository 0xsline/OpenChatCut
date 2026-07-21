import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MobileUploadService } from './mobile-upload-service';
import { isLoopbackAddress } from './plugins/mobile-upload';

assert.equal(isLoopbackAddress('127.0.0.1'), true);
assert.equal(isLoopbackAddress('::1'), true);
assert.equal(isLoopbackAddress('::ffff:127.0.0.1'), true);
assert.equal(isLoopbackAddress('192.168.1.20'), false);

const tempDir = await mkdtemp(join(tmpdir(), 'openchatcut-mobile-upload-'));
const service = new MobileUploadService({
  bindHost: '127.0.0.1',
  addresses: () => ['127.0.0.1'],
  uploadDirectory: () => tempDir,
  maxBytes: 16,
  sessionTtlMs: 200,
});

try {
  const session = await service.createSession();
  assert.equal(session.urls.length, 1);
  assert.match(session.urls[0] ?? '', /^http:\/\/127\.0\.0\.1:\d+\/s\/[A-Za-z0-9_-]+$/);

  const page = await fetch(session.urls[0]!);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy') ?? '', /default-src 'self'/);
  assert.match(await page.text(), /OpenChatCut/);

  const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const uploaded = await fetch(`${session.urls[0]}/upload?name=${encodeURIComponent('camera.png')}`, {
    method: 'POST',
    headers: { 'content-type': 'image/png' },
    body: pngBytes,
  });
  assert.equal(uploaded.status, 200);
  const record = await uploaded.json() as { name: string; path: string; bytes: number; mime: string };
  assert.equal(record.name, 'camera.png');
  assert.equal(record.bytes, 8);
  assert.equal(record.mime, 'image/png');
  assert.match(record.path, /^\/media\/uploads\/[0-9a-f-]+\.png$/);
  assert.deepEqual(await readFile(join(tempDir, record.path.split('/').at(-1)!)), pngBytes);

  const snapshot = service.getSession(session.id);
  assert.equal(snapshot?.files.length, 1);
  assert.equal(snapshot?.files[0]?.path, record.path);

  const unsupported = await fetch(`${session.urls[0]}/upload?name=payload.exe`, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream' },
    body: Buffer.from('x'),
  });
  assert.equal(unsupported.status, 415);

  const activeContent = await fetch(`${session.urls[0]}/upload?name=active.svg`, {
    method: 'POST',
    headers: { 'content-type': 'image/svg+xml' },
    body: Buffer.from('<svg/>'),
  });
  assert.equal(activeContent.status, 415);

  const spoofedImage = await fetch(`${session.urls[0]}/upload?name=spoofed.png`, {
    method: 'POST',
    headers: { 'content-type': 'image/png' },
    body: Buffer.from('not-png'),
  });
  assert.equal(spoofedImage.status, 415);

  const heicHeader = Buffer.concat([Buffer.from([0, 0, 0, 16]), Buffer.from('ftypheic')]);
  const heic = await fetch(`${session.urls[0]}/upload?name=photo.heic`, {
    method: 'POST',
    headers: { 'content-type': 'image/heic' },
    body: heicHeader,
  });
  assert.equal(heic.status, 200);

  const englishSession = await service.createSession('en');
  assert.match(await (await fetch(englishSession.urls[0]!)).text(), /Send media to OpenChatCut/);

  const tooLarge = await fetch(`${session.urls[0]}/upload?name=large.mp4`, {
    method: 'POST',
    headers: { 'content-type': 'video/mp4' },
    body: Buffer.alloc(17),
  });
  assert.equal(tooLarge.status, 413);

  const finalSnapshot = await service.closeSession(session.id);
  assert.equal(finalSnapshot?.files.length, 2);
  assert.equal(service.getSession(session.id), null);
  assert.equal((await fetch(session.urls[0]!)).status, 404);

  await new Promise((resolve) => setTimeout(resolve, 230));
  assert.equal(service.getSession(englishSession.id), null);
} finally {
  await service.stop();
  await rm(tempDir, { recursive: true, force: true });
}

console.log('mobile-upload-service.verify: ok');
