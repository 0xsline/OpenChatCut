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

const mediaDir = join(root, 'media', 'uploads');
await mkdir(mediaDir, { recursive: true });
await writeFile(join(mediaDir, 'final-cut.mp4'), Buffer.alloc(1024 * 1024, 7));
await writeFile(join(mediaDir, 'notes.txt'), 'not a video');

interface Recorded {
  method: string;
  path: string;
  headers: IncomingMessage['headers'];
  body: string;
}
const requests: Recorded[] = [];
const accepted = new Set<string>();
/** Accepted by the fake server but not yet visible on /status (Upload-Post registers async uploads with a delay). */
const pendingVisibility = new Set<string>();
/** Plan for the next /api/upload: an HTTP status, 'empty-2xx', 'drop' (cut the socket), plus latency and acceptance. */
let nextUpload: {
  status?: number | 'empty-2xx' | 'drop';
  acceptAnyway?: boolean;
  visible?: boolean;
  delayMs?: number;
} | null = null;
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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
  if (url.pathname === '/api/uploadposts/users/creator' || url.pathname === '/api/uploadposts/users/brand-b') {
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
    if (!accepted.has(id) || pendingVisibility.has(id)) {
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
    const plan = nextUpload ?? {};
    nextUpload = null;
    if (plan.delayMs) await wait(plan.delayMs);
    if (plan.status === undefined || plan.acceptAnyway || plan.status === 'empty-2xx') {
      accepted.add(id);
      if (plan.visible === false) pendingVisibility.add(id);
    }
    if (plan.status === 'drop') {
      req.socket.destroy();
      return;
    }
    if (plan.status === 'empty-2xx') {
      res.setHeader('Content-Type', 'text/plain');
      res.end('');
      return;
    }
    if (typeof plan.status === 'number') {
      res.statusCode = plan.status;
      res.end(JSON.stringify({ message: `fake ${plan.status}` }));
      return;
    }
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
  const {
    parsePublishRequest, publishToUploadPost, publishStatus, settleBackgroundUploads, trackPublish,
    uploadPostConfig, UploadPostError,
  } = mod;
  const ledgerPath = join(root, 'ledger', 'upload-post-publishes.json');
  const configFor = (profile: string) => uploadPostConfig((name) => ({
    UPLOAD_POST_API_KEY: 'test-key', UPLOAD_POST_PROFILE: profile, UPLOAD_POST_BASE_URL: `${baseUrl}/`,
  } as Record<string, string>)[name] ?? '');
  const config = configFor('creator');
  assert.equal(config.baseUrl, baseUrl, 'trailing slash trimmed');
  type Cfg = Parameters<typeof publishToUploadPost>[0];
  const publish = (cfg: Cfg, req: Parameters<typeof publishToUploadPost>[1]) => publishToUploadPost(cfg, req, { ledgerPath });
  const track = (id: string, cfg: Cfg = config) => trackPublish(cfg, id, ledgerPath);
  const uploadCount = () => requests.filter((request) => request.path === '/api/upload').length;
  /** Preview, then confirm with the preview's requestId — the approved flow. */
  async function previewAndConfirm(fields: Record<string, unknown>, cfg: Cfg = config) {
    const preview = await publish(cfg, parsePublishRequest(fields));
    assert(preview.phase === 'preview');
    const confirmed = await publish(cfg, parsePublishRequest({ ...fields, confirm: true, previewId: preview.requestId }));
    return { preview, confirmed, confirmAgain: () => publish(cfg, parsePublishRequest({ ...fields, confirm: true, previewId: preview.requestId })) };
  }

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
  await assert.rejects(publish(configFor(''), parsed), (error: unknown) => (
    error instanceof UploadPostError && error.status === 412 && error.code === 'upload_post_not_configured'
  ));

  // ── source validation ──
  await assert.rejects(publish(config, parsePublishRequest({ ...base, source: '/etc/passwd' })), /\/media\/uploads\//);
  await assert.rejects(publish(config, parsePublishRequest({ ...base, source: '/media/uploads/notes.txt' })), /video renders/);
  await assert.rejects(publish(config, parsePublishRequest({ ...base, source: '/media/uploads/..%2F..%2Fsecret.mp4' })), /invalid source path/);
  await assert.rejects(
    publish(config, parsePublishRequest({ ...base, source: '/media/uploads/%E0%A4%A.mp4' })),
    (error: unknown) => error instanceof UploadPostError && error.status === 400,
    'a malformed escape is a 400, not a crash',
  );

  // ── preview: no upload, reports what would be skipped ──
  requests.length = 0;
  const preview = await publish(config, parsed);
  assert(preview.phase === 'preview');
  assert.equal(preview.needsConfirm, true);
  assert.deepEqual(preview.missingPlatforms, ['linkedin'], 'empty account entries are not connected');
  assert.deepEqual([...preview.connectedPlatforms].sort(), ['tiktok', 'youtube'], 'non-video platforms are not offered');
  assert.deepEqual(preview.file, { name: 'final-cut.mp4', sizeBytes: 1024 * 1024 });
  assert.equal(preview.profile, 'creator');
  assert.equal(uploadCount(), 0, 'preview never uploads');
  assert.match(preview.requestId, /^ocut-[0-9a-f]{32}$/);

  // ── [P1] the confirmation is bound to the approved preview ──
  requests.length = 0;
  await assert.rejects(
    publish(config, parsePublishRequest({ ...base, confirm: true })),
    (error: unknown) => error instanceof UploadPostError && error.code === 'preview_required',
    'confirm without the preview id is refused',
  );
  // Preview names profile "creator"; the user switches Settings to "brand-b" before confirming.
  await assert.rejects(
    publish(configFor('brand-b'), parsePublishRequest({ ...base, confirm: true, previewId: preview.requestId })),
    (error: unknown) => error instanceof UploadPostError && error.status === 409 && error.code === 'preview_mismatch',
    'a profile switch after the preview is refused',
  );
  await assert.rejects(
    publish(config, parsePublishRequest({ ...base, title: 'Edited after preview', confirm: true, previewId: preview.requestId })),
    /changed since the preview/,
    'a field edited after the preview is refused',
  );
  await utimes(join(mediaDir, 'final-cut.mp4'), new Date(), new Date(Date.now() + 5_000)); // re-rendered file
  await assert.rejects(
    publish(config, parsePublishRequest({ ...base, confirm: true, previewId: preview.requestId })),
    (error: unknown) => error instanceof UploadPostError && error.code === 'preview_mismatch',
    'a file replaced after the preview is refused',
  );
  assert.equal(uploadCount(), 0, 'no mismatched confirm reaches Upload-Post');

  // ── [P4] a confirm is admitted at once; the upload runs in the background ──
  requests.length = 0;
  nextUpload = { delayMs: 1_500 }; // slow upload
  const slowFields = { ...base, title: 'Slow upload', aiGenerated: true, tiktokPrivacy: 'SELF_ONLY' };
  const started = Date.now();
  const { confirmed: admitted, preview: slowPreview, confirmAgain: confirmSlowAgain } = await previewAndConfirm(slowFields);
  assert.equal(admitted.phase, 'admitted');
  assert.equal(admitted.requestId, slowPreview.requestId, 'the admitted id is the previewed id');
  assert.ok(Date.now() - started < 1_000, 'confirm returns before the slow upload finishes');
  assert.equal((await track(admitted.requestId)).status, 'uploading', 'tracking reports the running upload');
  assert.equal((await confirmSlowAgain()).phase, 'admitted', 'a concurrent confirm joins the running upload');
  await settleBackgroundUploads();
  assert.equal(uploadCount(), 1, 'one upload for two confirms');
  const upload = requests.find((request) => request.path === '/api/upload');
  assert(upload);
  assert.equal(upload.headers['idempotency-key'], admitted.requestId, 'request id doubles as Idempotency-Key');
  assert.equal(upload.headers['user-agent'], 'OpenChatCut');
  assert.match(upload.body, /name="video"; filename="final-cut.mp4"/);
  assert.match(upload.body, /name="user"\r\n\r\ncreator\r\n/);
  assert.match(upload.body, /name="async_upload"\r\n\r\ntrue\r\n/);
  assert.match(upload.body, /name="privacyStatus"\r\n\r\nprivate\r\n/);
  assert.match(upload.body, /name="privacy_level"\r\n\r\nSELF_ONLY\r\n/);
  assert.match(upload.body, /name="is_ai_generated"\r\n\r\ntrue\r\n/);
  assert.equal((upload.body.match(/name="platform\[\]"/g) ?? []).length, 3);
  const finished = await track(admitted.requestId);
  assert.equal(finished.status, 'completed', 'the outcome is delivered through tracking');
  assert.equal(finished.results.find((result) => result.platform === 'youtube')?.url, 'https://www.youtube.com/watch?v=yt123');
  assert.equal(finished.results.find((result) => result.platform === 'tiktok')?.error, 'TikTok rejected the video');
  const resumed = await confirmSlowAgain();
  assert.equal(resumed.phase, 'resumed', 'the same approved publish resumes instead of posting twice');
  assert.equal(uploadCount(), 1);
  const previewAgain = await publish(config, parsePublishRequest(slowFields));
  assert(previewAgain.phase === 'preview');
  assert.equal(previewAgain.previouslySubmitted, true);

  // ── dropped connection mid-upload: reconciled against /status, never re-sent ──
  requests.length = 0;
  nextUpload = { status: 'drop', acceptAnyway: true }; // the server got it, the client never sees the answer
  const dropped = await previewAndConfirm({ ...base, title: 'Dropped' });
  await settleBackgroundUploads();
  assert.equal((await track(dropped.confirmed.requestId)).status, 'completed', 'the server had it');
  assert.equal((await dropped.confirmAgain()).phase, 'resumed');
  assert.equal(uploadCount(), 1, 'exactly one upload attempt');

  // ── 503 on submit, accepted but not yet visible on /status → re-confirm → 0 second uploads ──
  requests.length = 0;
  nextUpload = { status: 503, acceptAnyway: true, visible: false };
  const lagged = await previewAndConfirm({ ...base, title: '503 lag' });
  await settleBackgroundUploads();
  const laggedStatus = await track(lagged.confirmed.requestId);
  assert.equal(laggedStatus.status, 'unknown', 'a 5xx is ambiguous, never a definitive failure');
  assert.match(String(laggedStatus.note), /will not be re-sent/);
  assert.equal((await lagged.confirmAgain()).phase, 'unconfirmed_delivery', 'still unknown, and still not re-sent');
  await settleBackgroundUploads();
  assert.equal(uploadCount(), 1, 're-confirming after a 503 never uploads a second time');
  pendingVisibility.clear(); // Upload-Post finally shows it
  assert.equal((await lagged.confirmAgain()).phase, 'resumed');
  assert.equal(uploadCount(), 1);

  // ── 503 that the server really lost: still no automatic re-send ──
  requests.length = 0;
  nextUpload = { status: 503 };
  const lost = await previewAndConfirm({ ...base, title: '503 lost' });
  await settleBackgroundUploads();
  assert.equal((await lost.confirmAgain()).phase, 'unconfirmed_delivery');
  assert.equal(uploadCount(), 1, 'an ambiguous id stays blocked; a new post needs changed fields');

  // ── empty / non-JSON 2xx → accepted ──
  requests.length = 0;
  nextUpload = { status: 'empty-2xx' };
  const empty = await previewAndConfirm({ ...base, title: 'empty body' });
  await settleBackgroundUploads();
  assert.equal((await empty.confirmAgain()).phase, 'resumed', 'any 2xx is an accepted upload');
  assert.equal(uploadCount(), 1);

  // ── definitive pre-acceptance rejection (400/422): reported, and the same publish may be retried ──
  for (const status of [400, 422]) {
    requests.length = 0;
    nextUpload = { status };
    const refused = await previewAndConfirm({ ...base, title: `refused ${status}` });
    await settleBackgroundUploads();
    const refusedStatus = await track(refused.confirmed.requestId);
    assert.equal(refusedStatus.status, 'failed');
    assert.match(String(refusedStatus.error), new RegExp(`^${status}: fake ${status}`));
    assert.equal((await refused.confirmAgain()).phase, 'admitted', `a ${status} lets the fixed publish retry`);
    await settleBackgroundUploads();
    assert.equal(uploadCount(), 2);
  }

  // ── [P2] duplicate protection is never evicted: exactly 1,001 records ──
  const ledger = JSON.parse(await readFile(ledgerPath, 'utf8')) as Record<string, { state: string; at: number }>;
  const stuckId = Object.keys(ledger).find((id) => ledger[id].state === 'ambiguous');
  assert(stuckId, 'ambiguous attempts are recorded');
  const boundary: Record<string, { state: string; at: number }> = {
    [stuckId]: { state: 'ambiguous', at: Date.now() - 30 * 24 * 3600 * 1000 }, // oldest, and past the 24 h Idempotency-Key window
  };
  for (let index = 0; index < 1_000; index += 1) {
    boundary[`ocut-${index.toString(16).padStart(32, '0')}`] = { state: 'accepted', at: Date.now() + index };
  }
  await writeFile(ledgerPath, JSON.stringify(boundary));
  assert.equal(Object.keys(boundary).length, 1_001);
  requests.length = 0;
  nextUpload = { status: 'empty-2xx' };
  await previewAndConfirm({ ...base, title: 'one more write' }); // a further write must not evict the oldest entry
  await settleBackgroundUploads();
  const afterWrite = JSON.parse(await readFile(ledgerPath, 'utf8')) as Record<string, unknown>;
  assert.equal(Object.keys(afterWrite).length, 1_002, 'nothing evicted');
  assert.ok(afterWrite[stuckId], 'the oldest ambiguous record survives');
  requests.length = 0;
  assert.equal((await lost.confirmAgain()).phase, 'unconfirmed_delivery');
  assert.equal(uploadCount(), 0, 'a month-old ambiguous attempt behind 1,000 newer ones is still never re-sent');

  // ── [P2] fail closed when the record cannot be read ──
  await writeFile(ledgerPath, '{"torn');
  requests.length = 0;
  const unreadable = parsePublishRequest({ ...base, title: 'no ledger' });
  await assert.rejects(publish(config, unreadable), (error: unknown) => (
    error instanceof UploadPostError && error.status === 503 && error.code === 'ledger_unavailable'
  ), 'preview refuses too: it cannot tell whether this was already sent');
  const matchingId = mod.publishRequestId('creator', await mod.resolvePublishSource(unreadable.source), unreadable);
  await assert.rejects(
    publish(config, parsePublishRequest({ ...base, title: 'no ledger', confirm: true, previewId: matchingId })),
    (error: unknown) => error instanceof UploadPostError && error.code === 'ledger_unavailable',
    'a correctly bound confirm still refuses without duplicate protection',
  );
  assert.equal(uploadCount(), 0, 'no upload without duplicate protection');
  await rm(ledgerPath);

  // ── provider status + errors ──
  assert.equal((await publishStatus(config, 'ocut-00000000000000000000000000000000')).status, 'not_found');
  await assert.rejects(publish({ ...config, apiKey: 'wrong' }, parsed), (error: unknown) => (
    error instanceof UploadPostError && error.status === 401
  ));
  await assert.rejects(publish(configFor('missing'), parsed), /profile "missing" was not found/);

  const source = await readFile(new URL('./upload-post.ts', import.meta.url), 'utf8');
  assert.match(source, /openAsBlob\(source\.file/);
  assert.doesNotMatch(source, /readFile\(source\.file/, 'video upload must stay file-backed');
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
