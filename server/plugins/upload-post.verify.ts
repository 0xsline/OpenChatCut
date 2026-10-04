import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
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
/** API key → Upload-Post account. test-key-rotated is a new key of the same account. */
const ACCOUNTS: Record<string, string> = {
  'test-key': 'Creator@Example.com',
  'test-key-rotated': 'creator@example.com',
  'key-b': 'other@example.com',
};
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
let beforeNextStatus: (() => Promise<void>) | undefined;

const provider = createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  try {
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
  } catch {
    res.destroy(); // A changed file-backed snapshot aborts the multipart stream.
    return;
  }
  const url = new URL(req.url ?? '/', 'http://localhost');
  const body = Buffer.concat(chunks).toString('latin1');
  requests.push({ method: req.method ?? '', path: url.pathname, headers: req.headers, body });
  res.setHeader('Content-Type', 'application/json');
  const account = ACCOUNTS[String(req.headers.authorization ?? '').replace(/^Apikey /, '')];
  if (!account) {
    res.statusCode = 401;
    res.end(JSON.stringify({ message: 'Invalid API key' }));
    return;
  }
  if (url.pathname === '/api/uploadposts/me') {
    res.end(JSON.stringify({ success: true, message: 'Token is valid', email: account, plan: 'Basic' }));
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
    const beforeStatus = beforeNextStatus;
    beforeNextStatus = undefined;
    await beforeStatus?.();
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
  // These modules snapshot the runtime profile; import after isolating the fixture.
  const mod = await import('./upload-post.ts');
  const {
    parsePublishRequest, pausePublishing, publishToUploadPost, resumePublishingForTests,
    settleBackgroundUploads, trackPublish, uploadPostPlugin,
  } = mod;
  const { accountIdentity, publishStatus, uploadPostConfig, UploadPostError } = await import('./upload-post-client.ts');
  const { publishRequestId, resolvePublishSource } = await import('./upload-post-source.ts');
  const { syncUploadDirectories } = await import('../media-dir.ts');
  const ledgerPath = join(root, 'ledger', 'upload-post-publishes.json');
  const configFor = (profile: string, apiKey = 'test-key', endpoint = `${baseUrl}/`) => uploadPostConfig((name) => ({
    UPLOAD_POST_API_KEY: apiKey, UPLOAD_POST_PROFILE: profile, UPLOAD_POST_BASE_URL: endpoint,
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
  await writeFile(join(mediaDir, 'final-cut.mp4'), Buffer.alloc(1024 * 1024, 9)); // re-rendered: same name and size, new bytes
  await assert.rejects(
    publish(config, parsePublishRequest({ ...base, confirm: true, previewId: preview.requestId })),
    (error: unknown) => error instanceof UploadPostError && error.code === 'preview_mismatch',
    'a file replaced after the preview is refused',
  );
  assert.equal(uploadCount(), 0, 'no mismatched confirm reaches Upload-Post');

  const sameStampFile = join(mediaDir, 'same-stamp.mp4');
  const originalTime = new Date('2025-01-01T00:00:00Z');
  await writeFile(sameStampFile, Buffer.alloc(1024, 1));
  await utimes(sameStampFile, originalTime, originalTime);
  const sameStampFields = { ...base, source: '/media/uploads/same-stamp.mp4' };
  const sameStampPreview = await publish(config, parsePublishRequest(sameStampFields));
  await writeFile(sameStampFile, Buffer.alloc(1024, 2));
  await utimes(sameStampFile, originalTime, originalTime);
  await assert.rejects(
    publish(config, parsePublishRequest({ ...sameStampFields, confirm: true, previewId: sameStampPreview.requestId })),
    (error: unknown) => error instanceof UploadPostError && error.code === 'preview_mismatch',
    'a same-size replacement with restored mtime invalidates the cached content identity',
  );

  const lateFields = { ...base, title: 'Replaced during admission' };
  const latePreview = await publish(config, parsePublishRequest(lateFields));
  beforeNextStatus = () => writeFile(join(mediaDir, 'final-cut.mp4'), Buffer.alloc(1024 * 1024, 4));
  const lateAdmitted = await publish(config, parsePublishRequest({ ...lateFields, confirm: true, previewId: latePreview.requestId }));
  assert.equal(lateAdmitted.phase, 'admitted');
  await settleBackgroundUploads();
  assert.equal(accepted.has(latePreview.requestId), false, 'replacement bytes cannot be posted under the approved identity');
  assert.equal((await track(latePreview.requestId)).status, 'unknown', 'an interrupted transfer remains blocked, never retried');
  assert.equal(uploadCount(), 0, 'the provider receives no complete upload of the replacement');

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
  const stuckId = lost.confirmed.requestId;
  assert.equal(ledger[stuckId]?.state, 'ambiguous', 'the lost attempt is recorded');
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
  const matchingId = publishRequestId(
    await accountIdentity(config), 'creator', await resolvePublishSource(unreadable.source), unreadable,
  );
  await assert.rejects(
    publish(config, parsePublishRequest({ ...base, title: 'no ledger', confirm: true, previewId: matchingId })),
    (error: unknown) => error instanceof UploadPostError && error.code === 'ledger_unavailable',
    'a correctly bound confirm still refuses without duplicate protection',
  );
  assert.equal(uploadCount(), 0, 'no upload without duplicate protection');
  await writeFile(ledgerPath, JSON.stringify({ [matchingId]: null }));
  await assert.rejects(
    publish(config, parsePublishRequest({ ...base, title: 'no ledger', confirm: true, previewId: matchingId })),
    (error: unknown) => error instanceof UploadPostError && error.code === 'ledger_unavailable',
    'a syntactically valid but damaged tombstone must not become permission to upload',
  );
  await rm(ledgerPath);

  // ── [P1] approval and duplicate protection are bound to the endpoint and the account ──
  // Preview under account A, then the key is switched to account B with the same profile name.
  requests.length = 0;
  const accountFields = { ...base, title: 'Account bound' };
  const accountB = configFor('creator', 'key-b');
  const previewA = await publish(config, parsePublishRequest(accountFields));
  assert(previewA.phase === 'preview');
  await assert.rejects(
    publish(accountB, parsePublishRequest({ ...accountFields, confirm: true, previewId: previewA.requestId })),
    (error: unknown) => error instanceof UploadPostError && error.status === 409 && error.code === 'preview_mismatch',
    "account A's approved preview cannot be confirmed under account B",
  );
  assert.equal(uploadCount(), 0, 'nothing is uploaded under B with A\'s approval');
  // B publishes the same fields with its own approval; A's record must not see it.
  const underB = await previewAndConfirm(accountFields, accountB);
  assert.equal(underB.confirmed.phase, 'admitted');
  assert.notEqual(underB.preview.requestId, previewA.requestId, 'another account is another post');
  await settleBackgroundUploads();
  assert.equal(uploadCount(), 1);
  const backToA = await publish(config, parsePublishRequest(accountFields));
  assert(backToA.phase === 'preview');
  assert.equal(backToA.requestId, previewA.requestId);
  assert.equal(backToA.previouslySubmitted, undefined, "B's ledger entry is not reported as A's");
  const confirmedA = await publish(config, parsePublishRequest({ ...accountFields, confirm: true, previewId: previewA.requestId }));
  assert.equal(confirmedA.phase, 'admitted', 'A uploads its own post, not "resumed" from B');
  await settleBackgroundUploads();
  assert.equal(uploadCount(), 2);
  // A rotates its key: same account, so the same id, and duplicate protection holds.
  const rotated = configFor('creator', 'test-key-rotated');
  const previewRotated = await publish(rotated, parsePublishRequest(accountFields));
  assert(previewRotated.phase === 'preview');
  assert.equal(previewRotated.requestId, previewA.requestId, 'a key rotation keeps the publish identity');
  assert.equal(previewRotated.previouslySubmitted, true);
  assert.equal(
    (await publish(rotated, parsePublishRequest({ ...accountFields, confirm: true, previewId: previewA.requestId }))).phase,
    'resumed',
    'the rotated key resumes the post instead of sending it again',
  );
  assert.equal(uploadCount(), 2);
  // Same key and account, another endpoint: a different destination.
  const otherEndpoint = configFor('creator', 'test-key', `${baseUrl.replace('127.0.0.1', 'localhost')}/`);
  await assert.rejects(
    publish(otherEndpoint, parsePublishRequest({ ...accountFields, confirm: true, previewId: previewA.requestId })),
    (error: unknown) => error instanceof UploadPostError && error.code === 'preview_mismatch',
    'an approval for one endpoint is not valid on another',
  );
  assert.equal(uploadCount(), 2);

  // ── [P2] the Pinterest board is required, approved and sent ──
  assert.throws(
    () => parsePublishRequest({ ...base, platforms: ['pinterest'] }),
    /pinterestBoardId is required/,
    'Pinterest without a board is refused before anything else',
  );
  assert.equal(parsePublishRequest({ ...base, pinterestBoardId: 'board-1' }).pinterestBoardId, undefined, 'ignored without Pinterest');
  requests.length = 0;
  const pinFields = { ...base, platforms: ['pinterest', 'youtube'], title: 'Pinned', pinterestBoardId: 'board-1' };
  const pin = await previewAndConfirm(pinFields);
  assert(pin.preview.phase === 'preview');
  assert.equal(pin.preview.pinterestBoardId, 'board-1', 'the preview shows the board the user approves');
  await assert.rejects(
    publish(config, parsePublishRequest({ ...pinFields, pinterestBoardId: 'board-2', confirm: true, previewId: pin.preview.requestId })),
    (error: unknown) => error instanceof UploadPostError && error.code === 'preview_mismatch',
    'another board needs a new approval',
  );
  await settleBackgroundUploads();
  const pinUpload = requests.find((request) => request.path === '/api/upload');
  assert(pinUpload);
  assert.match(pinUpload.body, /name="pinterest_board_id"\r\n\r\nboard-1\r\n/);
  assert.equal(uploadCount(), 1);

  // ── [P2] media migration keeps the publish identity, so the ledger still matches ──
  requests.length = 0;
  const movedFields = { ...base, title: 'Moved media' };
  const beforeMove = await previewAndConfirm(movedFields);
  await settleBackgroundUploads();
  assert.equal(uploadCount(), 1);
  const movedDir = join(root, 'moved-media');
  await syncUploadDirectories(mediaDir, movedDir, () => undefined);
  // Even a destination that does not keep timestamps (coarse filesystem) keeps the identity.
  await utimes(join(movedDir, 'final-cut.mp4'), new Date(), new Date(Date.now() + 60_000));
  const fromMoved = (cfg: Cfg, fields: Record<string, unknown>) => publishToUploadPost(
    cfg, parsePublishRequest(fields), { ledgerPath, resolve: (name) => join(movedDir, name) },
  );
  const movedPreview = await fromMoved(config, movedFields);
  assert(movedPreview.phase === 'preview');
  assert.equal(movedPreview.requestId, beforeMove.preview.requestId, 'same bytes, same publish');
  assert.equal(movedPreview.previouslySubmitted, true, 'the migrated render is recognised as already sent');
  assert.equal(
    (await fromMoved(config, { ...movedFields, confirm: true, previewId: beforeMove.preview.requestId })).phase,
    'resumed',
  );
  await settleBackgroundUploads();
  assert.equal(uploadCount(), 1, 'migrating the media never produces a second upload');

  // ── [P2] storage relocation: never while an upload is in flight, and none admitted until restart ──
  requests.length = 0;
  nextUpload = { delayMs: 800 };
  const busy = await previewAndConfirm({ ...base, title: 'Busy during relocation' });
  assert.equal(busy.confirmed.phase, 'admitted');
  let relocated = false;
  await assert.rejects(
    pausePublishing(async () => { relocated = true; }),
    (error: unknown) => error instanceof UploadPostError && error.code === 'publish_in_progress',
    'a relocation waits for the running upload, so its ledger writes are not left behind',
  );
  assert.equal(relocated, false);
  await settleBackgroundUploads();
  const pausedFields = { ...base, title: 'During relocation' };
  const pausedPreview = await publish(config, parsePublishRequest(pausedFields));
  assert(pausedPreview.phase === 'preview');
  await pausePublishing(async () => {
    await assert.rejects(
      publish(config, parsePublishRequest({ ...pausedFields, confirm: true, previewId: pausedPreview.requestId })),
      (error: unknown) => error instanceof UploadPostError && error.code === 'publish_paused',
      'no upload is admitted while the root is copied',
    );
  });
  await assert.rejects(
    publish(config, parsePublishRequest({ ...pausedFields, confirm: true, previewId: pausedPreview.requestId })),
    /after restarting/,
    'after the copy the old root is still the live one, so publishing waits for the restart',
  );
  assert.equal(uploadCount(), 1, 'only the upload that was already running');
  resumePublishingForTests();
  await assert.rejects(
    pausePublishing(async () => { throw new Error('copy failed'); }),
    /copy failed/,
  );
  assert.equal(
    (await publish(config, parsePublishRequest({ ...pausedFields, confirm: true, previewId: pausedPreview.requestId }))).phase,
    'admitted',
    'a failed relocation resumes publishing',
  );
  await settleBackgroundUploads();

  // ── provider status + errors ──
  assert.equal((await publishStatus(config, 'ocut-00000000000000000000000000000000')).status, 'not_found');
  await assert.rejects(publish({ ...config, apiKey: 'wrong' }, parsed), (error: unknown) => (
    error instanceof UploadPostError && error.status === 401
  ));
  await assert.rejects(publish(configFor('missing'), parsed), /profile "missing" was not found/);

  // Exercise the actual HTTP publish/status handlers behind the request-shape gate.
  const { seedKeystore } = await import('../keystore.ts');
  const { requestShapeAllowed } = await import('./request-shape-gate.ts');
  seedKeystore({ UPLOAD_POST_API_KEY: 'test-key', UPLOAD_POST_PROFILE: 'creator', UPLOAD_POST_BASE_URL: baseUrl });
  let routeHandler!: (req: IncomingMessage, res: ServerResponse) => void;
  const configure = uploadPostPlugin().configureServer;
  assert.equal(typeof configure, 'function');
  if (typeof configure !== 'function') throw new Error('upload-post route was not configured');
  configure({
    config: { logger: { error: () => undefined } },
    middlewares: {
      use(path: string, handler: typeof routeHandler) {
        assert.equal(path, '/api/upload-post');
        routeHandler = handler;
      },
    },
  } as never);
  const local = createServer((req, res) => {
    if (!requestShapeAllowed(req)) {
      res.writeHead(403).end();
      return;
    }
    req.url = req.url?.slice('/api/upload-post'.length);
    routeHandler(req, res);
  });
  local.listen(0, '127.0.0.1');
  await once(local, 'listening');
  const localAddress = local.address();
  assert(localAddress && typeof localAddress === 'object');
  const origin = `http://127.0.0.1:${localAddress.port}`;
  const endpoint = `${origin}/api/upload-post/publish`;
  const routeFields = { ...base, title: 'Local HTTP route' };
  const post = (fields: Record<string, unknown>, trusted = true) => fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(trusted ? { Origin: origin, 'Sec-Fetch-Site': 'same-origin' } : {}),
    },
    body: JSON.stringify(fields),
  });
  try {
    requests.length = 0;
    assert.equal((await post(routeFields, false)).status, 403, 'untrusted HTTP callers cannot publish');
    const previewResponse = await post(routeFields);
    assert.equal(previewResponse.status, 200);
    const routePreview = await previewResponse.json() as { requestId: string; phase: string };
    assert.equal(routePreview.phase, 'preview');
    assert.equal(uploadCount(), 0, 'a real HTTP preview still sends no upload');
    assert.equal((await post({ ...routeFields, confirm: true })).status, 400);
    const confirmResponse = await post({ ...routeFields, confirm: true, previewId: routePreview.requestId });
    assert.equal(confirmResponse.status, 200);
    assert.equal((await confirmResponse.json() as { phase: string }).phase, 'admitted');
    await settleBackgroundUploads();
    const statusResponse = await fetch(`${endpoint}/${routePreview.requestId}`);
    assert.equal(statusResponse.status, 200);
    assert.equal((await statusResponse.json() as { status: string }).status, 'completed');
    const repeatResponse = await post({ ...routeFields, confirm: true, previewId: routePreview.requestId });
    assert.equal((await repeatResponse.json() as { phase: string }).phase, 'resumed');
    assert.equal(uploadCount(), 1, 'the real HTTP route posts once across reconfirmation');
  } finally {
    await settleBackgroundUploads();
    await new Promise<void>((resolve) => local.close(() => resolve()));
  }
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
