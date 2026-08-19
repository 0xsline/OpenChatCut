import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = await mkdtemp(join(tmpdir(), 'occ-sonilo-upload-'));
const profileId = '8eafcf20-e80f-4acd-a0ef-9169555ebad7';
const original = {
  dataDir: process.env.OPENCHATCUT_DATA_DIR,
  profileId: process.env.OPENCHATCUT_DEV_PROFILE_ID,
  httpProxy: process.env.HTTP_PROXY,
  httpsProxy: process.env.HTTPS_PROXY,
  lowerHttpProxy: process.env.http_proxy,
  lowerHttpsProxy: process.env.https_proxy,
};
process.env.OPENCHATCUT_DATA_DIR = root;
process.env.OPENCHATCUT_DEV_PROFILE_ID = profileId;
delete process.env.HTTP_PROXY;
delete process.env.HTTPS_PROXY;
delete process.env.http_proxy;
delete process.env.https_proxy;

const uploads = join(root, 'media', 'uploads');
await mkdir(uploads, { recursive: true });
await writeFile(join(uploads, 'cut.mp4'), Buffer.alloc(2 * 1024 * 1024, 7));

let requestBody = '';
const provider = createServer(async (req, res) => {
  assert.equal(req.headers.authorization, 'Bearer test-key');
  assert.equal(req.headers['user-agent'], 'OpenChatCut');
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  requestBody = Buffer.concat(chunks).toString('latin1');
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ task_id: 'task-async' }));
});

try {
  provider.listen(0, '127.0.0.1');
  await once(provider, 'listening');
  const address = provider.address();
  assert(address && typeof address === 'object');
  const { submitSoniloVideoTask } = await import('./sonilo-media.ts');
  const taskId = await submitSoniloVideoTask(
    `http://127.0.0.1:${address.port}`, 'test-key', '/v1/video-to-sfx', '/media/uploads/cut.mp4',
  );
  assert.equal(taskId, 'task-async');
  assert.match(requestBody, /name="mode"\r\n\r\nasync\r\n/);
  assert.match(requestBody, /name="file"; filename="cut.mp4"/);

  const source = await readFile(new URL('./sonilo-media.ts', import.meta.url), 'utf8');
  assert.match(source, /openAsBlob\(file/);
  assert.doesNotMatch(source, /await readFile\(file\)/, 'video upload must stay file-backed');
  console.log('sonilo-media.verify OK');
} finally {
  await new Promise<void>((resolve) => provider.close(() => resolve()));
  await rm(root, { recursive: true, force: true });
  if (original.dataDir === undefined) delete process.env.OPENCHATCUT_DATA_DIR;
  else process.env.OPENCHATCUT_DATA_DIR = original.dataDir;
  if (original.profileId === undefined) delete process.env.OPENCHATCUT_DEV_PROFILE_ID;
  else process.env.OPENCHATCUT_DEV_PROFILE_ID = original.profileId;
  if (original.httpProxy === undefined) delete process.env.HTTP_PROXY;
  else process.env.HTTP_PROXY = original.httpProxy;
  if (original.httpsProxy === undefined) delete process.env.HTTPS_PROXY;
  else process.env.HTTPS_PROXY = original.httpsProxy;
  if (original.lowerHttpProxy === undefined) delete process.env.http_proxy;
  else process.env.http_proxy = original.lowerHttpProxy;
  if (original.lowerHttpsProxy === undefined) delete process.env.https_proxy;
  else process.env.https_proxy = original.lowerHttpsProxy;
}
