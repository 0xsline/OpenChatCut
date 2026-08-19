import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

type Middleware = (req: IncomingMessage, res: ServerResponse, next: () => void) => void;

const root = await mkdtemp(join(tmpdir(), 'occ-sonilo-sound-'));
const media = join(root, 'media', 'uploads');
await mkdir(media, { recursive: true });
const cut = join(media, 'cut.mp4');
const ffmpeg = (args: string[]) => spawnSync('ffmpeg', ['-loglevel', 'error', '-y', ...args], { encoding: 'utf8' });
assert.equal(ffmpeg(['-f', 'lavfi', '-i', 'color=c=black:s=16x16:d=0.2', '-c:v', 'mpeg4', cut]).status, 0);

const oldEnv = { ...process.env };
process.env.OPENCHATCUT_DATA_DIR = root;
process.env.OPENCHATCUT_DEV_PROFILE_ID = 'ff8ca810-a09d-4dc5-8f41-d978df5338d7';
for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy']) delete process.env[key];

let providerOrigin = '';
let submittedAsync = false;
const provider = createServer(async (req, res) => {
  if (req.method === 'POST' && req.url === '/v1/video-to-sfx') {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    submittedAsync = Buffer.concat(chunks).toString('latin1').includes('name="mode"\r\n\r\nasync');
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ task_id: 'sound-task-1' }));
    return;
  }
  if (req.url === '/v1/tasks/sound-task-1') {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ status: 'failed', error: 'fixture terminal failure' }));
    return;
  }
  res.statusCode = 404;
  res.end();
});

let route: Middleware | undefined;
let app: ReturnType<typeof createServer> | undefined;
try {
  provider.listen(0, '127.0.0.1');
  await once(provider, 'listening');
  const providerAddress = provider.address();
  assert(providerAddress && typeof providerAddress === 'object');
  providerOrigin = `http://127.0.0.1:${providerAddress.port}`;

  const { soundGenerationPlugin } = await import('./sound.ts');
  const { getGenerationJobSnapshot } = await import('./generation-jobs.ts');
  const plugin = soundGenerationPlugin({
    baseUrl: 'https://unused.test', apiKey: '', model: 'eleven_text_to_sound_v2',
    soniloBaseUrl: providerOrigin, soniloApiKey: 'test-key',
  });
  assert.equal(typeof plugin.configureServer, 'function');
  plugin.configureServer?.({
    config: { logger: { error() {} } },
    middlewares: { use(path: string, handler: Middleware) {
      assert.equal(path, '/generate/sound');
      route = handler;
    } },
  } as never);
  assert.ok(route);

  app = createServer((req, res) => route?.(req, res, () => { res.statusCode = 404; res.end(); }));
  app.listen(0, '127.0.0.1');
  await once(app, 'listening');
  const appAddress = app.address();
  assert(appAddress && typeof appAddress === 'object');
  const started = Date.now();
  const response = await fetch(`http://127.0.0.1:${appAddress.port}/generate/sound`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      operationId: 'sound-operation-1', provider: 'sonilo', name: 'Matched SFX',
      sourceAssetPath: '/media/uploads/cut.mp4', sourceAssetKind: 'video', sourceRevisions: ['revision-1'],
    }),
  });
  assert.equal(response.status, 202);
  assert.ok(Date.now() - started < 5_000, 'submission returns before provider completion polling');
  const submission = await response.json() as { jobId: string; status: string };
  assert.deepEqual(submission, { operationId: 'sound-operation-1', jobId: 'sound-operation-1', status: 'queued' });

  let snapshot = getGenerationJobSnapshot(submission.jobId);
  const deadline = Date.now() + 10_000;
  while (snapshot?.status !== 'failed' && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    snapshot = getGenerationJobSnapshot(submission.jobId);
  }
  assert.equal(snapshot?.status, 'failed');
  assert.equal(snapshot?.error, 'fixture terminal failure');
  assert.equal(snapshot?.providerTaskId, 'sound-task-1');
  assert.equal(snapshot?.retryClass, 'provider-terminal');
  assert.equal(submittedAsync, true);
  console.log('sound-sonilo-job.verify OK');
} finally {
  if (app) await new Promise<void>((resolve) => app?.close(() => resolve()));
  await new Promise<void>((resolve) => provider.close(() => resolve()));
  await rm(root, { recursive: true, force: true });
  process.env = oldEnv;
}
