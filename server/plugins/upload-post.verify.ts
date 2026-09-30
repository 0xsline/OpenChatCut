import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = await mkdtemp(join(tmpdir(), 'occ-upload-post-'));
const profileId = '5b1f5d1e-5a6d-4c3e-9a3b-2f6f1c1d9e01';
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
await writeFile(join(uploads, 'final-cut.mp4'), Buffer.alloc(1024 * 1024, 7));
await writeFile(join(uploads, 'notes.txt'), 'not a video');

interface Recorded {
  method: string;
  path: string;
  headers: IncomingMessage['headers'];
  body: string;
}
const requests: Recorded[] = [];
const accepted = new Set<string>();
let failNextUpload = false;

const provider = createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const url = new URL(req.url ?? '/', 'http://localhost');
  const body = Buffer.concat(chunks).toString('latin1');
  requests.push({ method: req.method ?? '', path: url.pathname, headers: req.headers, body });
  res.setHeader('Content-Type', 'application/json');
  if (req.headers.authorization !== 'Apikey test-key') {
    res.statusCode = 401;
    res.end(JSON.stringify({ message: 'Invalid API key' }));
    return;
  }
  if (url.pathname === '/api/uploadposts/users/creator') {
    res.end(JSON.stringify({ success: true, profile: { social_accounts: { tiktok: { handle: 'a' }, youtube: { handle: 'b' }, linkedin: '', reddit: { handle: 'c' } } } }));
    return;
  }
  if (url.pathname === '/api/uploadposts/users/missing') {
    res.statusCode = 404;
    res.end(JSON.stringify({ message: 'Profile not found' }));
    return;
  }
  if (url.pathname === '/api/uploadposts/status') {
    const id = url.searchParams.get('request_id') ?? '';
    if (!accepted.has(id)) {
      res.statusCode = 404;
      res.end(JSON.stringify({ status: 'not_found' }));
      return;
    }
    res.end(JSON.stringify({
      request_id: id, status: 'completed', completed: 2, total: 2,
      results: [
        { platform: 'youtube', success: true, platform_post_id: 'yt123', post_url: 'Post uploaded as Private. No public URL available.' },
        { platform: 'tiktok', success: false, error_message: 'TikTok rejected the video' },
      ],
    }));
    return;
  }
  if (url.pathname === '/api/upload' && req.method === 'POST') {
    const id = String(req.headers['idempotency-key'] ?? '');
    if (failNextUpload) {
      failNextUpload = false;
      accepted.add(id); // the server got it, but the client never sees the answer
      req.socket.destroy();
      return;
    }
    accepted.add(id);
    res.end(JSON.stringify({ success: true, request_id: id }));
    return;
  }
  res.statusCode = 404;
  res.end('{}');
});

try {
  provider.listen(0, '127.0.0.1');
  await once(provider, 'listening');
  const address = provider.address();
  assert(address && typeof address === 'object');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const mod = await import('./upload-post.ts');
  const { parsePublishRequest, publishToUploadPost, publishStatus, uploadPostConfig, UploadPostError } = mod;
  const config = uploadPostConfig((name) => ({
    UPLOAD_POST_API_KEY: 'test-key', UPLOAD_POST_PROFILE: 'creator', UPLOAD_POST_BASE_URL: `${baseUrl}/`,
  } as Record<string, string>)[name] ?? '');
  assert.equal(config.baseUrl, baseUrl, 'trailing slash trimmed');

  // ── request parsing ──
  const base = { source: '/media/uploads/final-cut.mp4', platforms: ['tiktok', 'shorts', 'linkedin'], title: 'Launch day' };
  const parsed = parsePublishRequest(base);
  assert.deepEqual(parsed.platforms, ['tiktok', 'youtube', 'linkedin'], 'aliases resolve, order kept');
  assert.equal(parsed.youtubePrivacy, 'private', 'YouTube defaults to private');
  assert.equal(parsed.confirm, false, 'confirm is opt-in');
  assert.throws(() => parsePublishRequest({ ...base, platforms: ['myspace'] }), UploadPostError);
  assert.throws(() => parsePublishRequest({ ...base, platforms: ['youtube'], title: 'x'.repeat(101) }), /100 characters/);
  assert.throws(() => parsePublishRequest({ ...base, youtubePrivacy: 'secret' }), /youtubePrivacy/);

  // ── unconfigured → actionable 412, before touching the file or the network ──
  const unconfigured = uploadPostConfig(() => '');
  await assert.rejects(publishToUploadPost(unconfigured, parsed), (error: unknown) => (
    error instanceof UploadPostError && error.status === 412 && error.code === 'upload_post_not_configured'
  ));

  // ── source validation ──
  await assert.rejects(
    publishToUploadPost(config, parsePublishRequest({ ...base, source: '/etc/passwd' })),
    /\/media\/uploads\//,
  );
  await assert.rejects(
    publishToUploadPost(config, parsePublishRequest({ ...base, source: '/media/uploads/notes.txt' })),
    /video renders/,
  );
  await assert.rejects(
    publishToUploadPost(config, parsePublishRequest({ ...base, source: '/media/uploads/..%2F..%2Fsecret.mp4' })),
    /invalid source path/,
  );
  await assert.rejects(
    publishToUploadPost(config, parsePublishRequest({ ...base, source: '/media/uploads/%E0%A4%A.mp4' })),
    (error: unknown) => error instanceof UploadPostError && error.status === 400,
    'a malformed escape is a 400, not a crash',
  );

  // ── preview: no upload, reports what would be skipped ──
  requests.length = 0;
  const preview = await publishToUploadPost(config, parsed);
  assert.equal(preview.phase, 'preview');
  assert(preview.phase === 'preview');
  assert.equal(preview.needsConfirm, true);
  assert.deepEqual(preview.missingPlatforms, ['linkedin'], 'empty account entries are not connected');
  assert.deepEqual([...preview.connectedPlatforms].sort(), ['tiktok', 'youtube'], 'non-video platforms are not offered');
  assert.deepEqual(preview.file, { name: 'final-cut.mp4', sizeBytes: 1024 * 1024 });
  assert.equal(preview.youtubePrivacy, 'private');
  assert(!requests.some((request) => request.path === '/api/upload'), 'preview never uploads');
  assert.match(preview.requestId, /^ocut-[0-9a-f]{32}$/);

  // ── confirmed publish: file-backed multipart with the idempotency key ──
  requests.length = 0;
  const confirmed = parsePublishRequest({ ...base, confirm: true, aiGenerated: true, tiktokPrivacy: 'SELF_ONLY' });
  const submitted = await publishToUploadPost(config, confirmed);
  assert.equal(submitted.phase, 'submitted');
  const upload = requests.find((request) => request.path === '/api/upload');
  assert(upload, 'uploaded once');
  assert.equal(upload.headers['idempotency-key'], submitted.requestId, 'request id doubles as Idempotency-Key');
  assert.equal(upload.headers['user-agent'], 'OpenChatCut');
  assert.match(upload.body, /name="video"; filename="final-cut.mp4"/);
  assert.match(upload.body, /name="user"\r\n\r\ncreator\r\n/);
  assert.match(upload.body, /name="async_upload"\r\n\r\ntrue\r\n/);
  assert.match(upload.body, /name="privacyStatus"\r\n\r\nprivate\r\n/);
  assert.match(upload.body, /name="privacy_level"\r\n\r\nSELF_ONLY\r\n/);
  assert.match(upload.body, /name="is_ai_generated"\r\n\r\ntrue\r\n/);
  assert.equal((upload.body.match(/name="platform\[\]"/g) ?? []).length, 3);
  assert.notEqual(submitted.requestId, preview.requestId, 'changed publish fields → a different post id');

  // ── the same approved publish again resumes it instead of posting twice ──
  requests.length = 0;
  const again = await publishToUploadPost(config, confirmed);
  assert.equal(again.phase, 'resumed');
  assert.equal(again.requestId, submitted.requestId);
  assert(!requests.some((request) => request.path === '/api/upload'), 'resuming never re-uploads');

  // ── a new render file (different mtime) is a different post ──
  await utimes(join(uploads, 'final-cut.mp4'), new Date(), new Date(Date.now() + 5_000));
  const newer = await publishToUploadPost(config, parsePublishRequest({ ...base }));
  assert(newer.phase === 'preview');
  assert.notEqual(newer.requestId, preview.requestId, 'the id tracks the file, not only its name');

  // ── dropped connection mid-upload: report, never re-send ──
  requests.length = 0;
  failNextUpload = true;
  const dropped = await publishToUploadPost(config, parsePublishRequest({ ...base, title: 'Dropped', confirm: true }));
  assert.equal(dropped.phase, 'unconfirmed_delivery');
  assert.equal(requests.filter((request) => request.path === '/api/upload').length, 1, 'exactly one upload attempt');
  const settled = await publishToUploadPost(config, parsePublishRequest({ ...base, title: 'Dropped', confirm: true }));
  assert.equal(settled.phase, 'resumed', 'retrying the same publish finds the delivered upload');
  assert.equal(requests.filter((request) => request.path === '/api/upload').length, 1, 'still one upload');

  // ── status normalization ──
  const status = await publishStatus(config, submitted.requestId);
  assert.equal(status.status, 'completed');
  const youtube = status.results.find((result) => result.platform === 'youtube');
  assert.equal(youtube?.url, 'https://www.youtube.com/watch?v=yt123', 'private YouTube still gets an owner URL');
  assert.equal(youtube?.note, undefined, 'text post_url replaced by the owner URL');
  const tiktok = status.results.find((result) => result.platform === 'tiktok');
  assert.equal(tiktok?.status, 'failed');
  assert.equal(tiktok?.error, 'TikTok rejected the video');
  assert.equal((await publishStatus(config, 'ocut-00000000000000000000000000000000')).status, 'not_found');

  // ── provider errors are specific ──
  const badKey = { ...config, apiKey: 'wrong' };
  await assert.rejects(publishToUploadPost(badKey, parsed), (error: unknown) => (
    error instanceof UploadPostError && error.status === 401
  ));
  await assert.rejects(publishToUploadPost({ ...config, profile: 'missing' }, parsed), /profile "missing" was not found/);

  const source = await readFile(new URL('./upload-post.ts', import.meta.url), 'utf8');
  assert.match(source, /openAsBlob\(source\.file/);
  assert.doesNotMatch(source, /await readFile\(/, 'video upload must stay file-backed');
  console.log('upload-post.verify OK');
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
