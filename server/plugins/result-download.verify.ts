// Runnable check: `npx tsx server/plugins/result-download.verify.ts`.
// Downloading the finished product is the last step after "the money has been spent", and the cost of failure is the highest. Verification: Transient errors will be retried,
// 4xx does not retry in vain, and the error thrown after exhaustion of retries carries the supplier URL (the task layer retains the paid results accordingly).
import assert from 'node:assert/strict';
import { safePublicFetch, type PublicUrlResolver, type PublicUrlTransport } from '../safe-public-fetch.ts';
import {
  ResultDownloadError,
  downloadBackoffMs,
  fetchGeneratedResult,
  isRetryableDownloadStatus,
} from './result-download.ts';

const ok = (body: BodyInit = 'bytes', contentType = 'video/mp4') => new Response(body, {
  status: 200,
  headers: { 'content-type': contentType },
});
const status = (code: number) => new Response('nope', { status: code });
const URL_ = 'https://provider.example/out.mp4';

/** Record each call and return in sequence according to the preset script (Response returns directly, Error is thrown). */
function scriptedFetch(script: Array<Response | Error>) {
  const calls: string[] = [];
  const waits: number[] = [];
  const fetchImpl = ((url: string) => {
    calls.push(String(url));
    const next = script[calls.length - 1];
    if (next instanceof Error) return Promise.reject(next);
    return Promise.resolve(next ?? status(500));
  }) as unknown as typeof fetch;
  const sleep = (ms: number) => { waits.push(ms); return Promise.resolve(); };
  return { fetchImpl, sleep, calls, waits };
}

async function settleWithin<T>(operation: Promise<T>, timeoutMs = 500): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`verification deadline exceeded after ${timeoutMs}ms`)), timeoutMs);
  });
  try {
    return await Promise.race([operation, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

// ── Backoff and retry determination ──
{
  assert.deepEqual([downloadBackoffMs(1), downloadBackoffMs(2)], [400, 800], '指数退避');
  for (const code of [408, 425, 429, 500, 502, 503, 504]) {
    assert.ok(isRetryableDownloadStatus(code), `${code} 应重试`);
  }
  for (const code of [400, 401, 403, 404, 410, 422]) {
    assert.ok(!isRetryableDownloadStatus(code), `${code} 是请求本身不对,重试只是再烧一遍`);
  }
}

// ── One-time success: no retrying, no waiting ──
{
  const s = scriptedFetch([ok()]);
  const res = await fetchGeneratedResult(URL_, 'video', s);
  assert.equal(res.status, 200);
  assert.equal(s.calls.length, 1);
  assert.deepEqual(s.waits, []);
}

// ── Structured subtitle results keep their own strict JSON MIME contract ──
{
  const s = scriptedFetch([ok('{"subtitles":[]}', 'application/json')]);
  const res = await fetchGeneratedResult('https://provider.example/subtitles.json', 'subtitle', s);
  assert.equal(await res.text(), '{"subtitles":[]}');
}

// ──Success after instant 5xx: This is the half that really saves money──
{
  const s = scriptedFetch([status(502), ok()]);
  const res = await fetchGeneratedResult(URL_, 'video', s);
  assert.equal(res.status, 200, 'CDN 抖动被消化掉,用户无感');
  assert.equal(s.calls.length, 2);
  assert.deepEqual(s.waits, [400]);
}

// ── Retry even if network abnormality occurs ──
{
  const s = scriptedFetch([new Error('ECONNRESET'), ok()]);
  assert.equal((await fetchGeneratedResult(URL_, 'video', s)).status, 200);
  assert.equal(s.calls.length, 2);
}

// ── Each pre-header attempt has a fresh deadline, even when fetch ignores AbortSignal ──
{
  const signals: AbortSignal[] = [];
  let attempts = 0;
  const stalled = fetchGeneratedResult(URL_, 'video', {
    fetchImpl: (_url, init) => {
      attempts += 1;
      signals.push(init.signal);
      return new Promise<Response>(() => undefined);
    },
    sleep: () => Promise.resolve(),
    headerDeadlineMs: 5,
  });
  const error = await settleWithin(stalled, 250).then(() => null, (e: unknown) => e);
  assert.ok(error instanceof ResultDownloadError);
  assert.equal(error.url, URL_);
  assert.equal(error.retryable, true);
  assert.match(error.message, /response headers deadline/);
  assert.equal(attempts, 3, 'a stalled pre-header request still consumes exactly three attempts');
  assert.equal(new Set(signals).size, 3, 'every attempt owns a fresh AbortSignal');
  assert.ok(signals.every((signal) => signal.aborted), 'each expired attempt aborts its transport signal');
}

// ── Retry exhausted: throw ResultDownloadError with URL ──
{
  const s = scriptedFetch([status(503), status(503), status(503)]);
  const error = await fetchGeneratedResult(URL_, 'video', s).then(() => null, (e: unknown) => e);
  assert.ok(error instanceof ResultDownloadError, '必须是可识别的类型,任务层靠它留住结果');
  assert.equal(error.url, URL_, 'URL 要带出来——成品已经生成,钱已经付了');
  assert.match(error.message, /video/, '错误文案说明是哪一类成品');
  assert.match(error.message, /503/, '带上最后一次失败原因');
  assert.equal(s.calls.length, 3, '共三次尝试');
  assert.deepEqual(s.waits, [400, 800]);
}

// ── 4xx Give up immediately, but still bring the URL ──
{
  const s = scriptedFetch([status(404), ok(), ok()]);
  const error = await fetchGeneratedResult(URL_, 'image', s).then(() => null, (e: unknown) => e);
  assert.ok(error instanceof ResultDownloadError);
  assert.equal(error.url, URL_);
  assert.equal(s.calls.length, 1, '404 不重试');
  assert.deepEqual(s.waits, [], '也不该等待');
}

// ── Successful responses must be media, never provider HTML/error payloads ──
{
  let cancelled = 0;
  const body = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new TextEncoder().encode('<html>error</html>')); },
    cancel() { cancelled += 1; },
  });
  const s = scriptedFetch([ok(body, 'text/html; charset=utf-8')]);
  const error = await fetchGeneratedResult(URL_, 'video', s).then(() => null, (e: unknown) => e);
  assert.ok(error instanceof ResultDownloadError);
  assert.equal(error.retryable, false);
  assert.match(error.message, /content type text\/html/);
  assert.equal(s.calls.length, 1, 'MIME policy failures must not be retried');
  assert.equal(cancelled, 1, 'rejected response bodies must be cancelled');
}

// ── Declared and streamed bodies both obey a strict byte ceiling ──
{
  const declared = scriptedFetch([new Response('12345', {
    status: 200,
    headers: { 'content-type': 'image/png', 'content-length': '5' },
  })]);
  const declaredError = await fetchGeneratedResult(URL_, 'image', { ...declared, maxBytes: 4 })
    .then(() => null, (e: unknown) => e);
  assert.ok(declaredError instanceof ResultDownloadError);
  assert.equal(declaredError.retryable, false);
  assert.match(declaredError.message, /content length exceeds 4 byte limit/);

  let pulls = 0;
  let cancels = 0;
  const streamedBody = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls += 1;
      controller.enqueue(Uint8Array.of(1, 2, 3));
    },
    cancel() { cancels += 1; },
  });
  const streamed = scriptedFetch([ok(streamedBody)]);
  const response = await fetchGeneratedResult(URL_, 'video', { ...streamed, maxBytes: 4 });
  const streamedError = await response.arrayBuffer().then(() => null, (e: unknown) => e);
  assert.ok(streamedError instanceof ResultDownloadError);
  assert.equal(streamedError.retryable, false);
  assert.match(streamedError.message, /body exceeds 4 byte limit/);
  assert.equal(cancels, 1, 'the upstream stream must be terminated as soon as the cap is crossed');
}

// ── Body reads use a resettable idle deadline and preserve recoverable URL semantics ──
{
  let cancels = 0;
  const stalledBody = new ReadableStream<Uint8Array>({
    pull() {
      return new Promise<void>(() => undefined);
    },
    cancel() {
      cancels += 1;
      return new Promise<void>(() => undefined);
    },
  });
  const response = await fetchGeneratedResult(URL_, 'video', {
    ...scriptedFetch([ok(stalledBody)]),
    bodyIdleDeadlineMs: 5,
  });
  const error = await settleWithin(response.arrayBuffer(), 250).then(() => null, (e: unknown) => e);
  assert.ok(error instanceof ResultDownloadError);
  assert.equal(error.url, URL_);
  assert.equal(error.retryable, true);
  assert.match(error.message, /body idle deadline/);
  assert.equal(cancels, 1, 'timeout reports before a non-settling upstream cancellation');
}

// ── Network failures after headers remain retryable result-download failures ──
{
  const brokenBody = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.error(new Error('ECONNRESET while reading body'));
    },
  });
  const response = await fetchGeneratedResult(URL_, 'video', scriptedFetch([ok(brokenBody)]));
  const error = await response.arrayBuffer().then(() => null, (e: unknown) => e);
  assert.ok(error instanceof ResultDownloadError);
  assert.equal(error.url, URL_);
  assert.equal(error.retryable, true);
  assert.match(error.message, /ECONNRESET while reading body/);
}

// ── A stream may take longer than one idle window overall when every chunk makes progress ──
{
  let emitted = 0;
  let headerSignal: AbortSignal | undefined;
  const progressingBody = new ReadableStream<Uint8Array>({
    async pull(controller) {
      await new Promise<void>((resolve) => { setTimeout(resolve, 25); });
      if (emitted === 6) {
        controller.close();
        return;
      }
      emitted += 1;
      controller.enqueue(Uint8Array.of(emitted));
    },
  });
  const response = await fetchGeneratedResult(URL_, 'video', {
    fetchImpl: (_url, init) => {
      headerSignal = init.signal;
      return Promise.resolve(ok(progressingBody));
    },
    headerDeadlineMs: 5,
    bodyIdleDeadlineMs: 100,
  });
  const bytes = new Uint8Array(await settleWithin(response.arrayBuffer()));
  assert.deepEqual([...bytes], [1, 2, 3, 4, 5, 6]);
  assert.equal(headerSignal?.aborted, false, 'the header timer is cleared before a long body download');
}

// ── The generated-result entry point retains safePublicFetch DNS/IP/redirect pinning ──
{
  const publicAddress = '93.184.216.34';
  let transports = 0;
  const transport: PublicUrlTransport = async () => {
    transports += 1;
    return ok();
  };
  const guarded = (resolver: PublicUrlResolver, redirecting = false) => (
    async (input: string | URL, init: { signal: AbortSignal }) => safePublicFetch(input, {
      resolver,
      signal: init.signal,
      transport: redirecting
        ? async () => {
          transports += 1;
          return new Response(null, { status: 302, headers: { location: 'https://rebind.example/out.mp4' } });
        }
        : transport,
    })
  );
  const publicResolver: PublicUrlResolver = async () => [{ address: publicAddress, family: 4 }];
  for (const unsafe of [
    'http://127.0.0.1/out.mp4',
    'http://169.254.169.254/latest/meta-data',
    'http://metadata.google.internal/latest/meta-data',
  ]) {
    const error = await fetchGeneratedResult(unsafe, 'video', { fetchImpl: guarded(publicResolver) })
      .then(() => null, (e: unknown) => e);
    assert.ok(error instanceof ResultDownloadError);
    assert.equal(error.retryable, false);
  }
  const privateDnsError = await fetchGeneratedResult('https://private.example/out.mp4', 'video', {
    fetchImpl: guarded(async () => [{ address: '10.0.0.1', family: 4 }]),
  }).then(() => null, (e: unknown) => e);
  assert.ok(privateDnsError instanceof ResultDownloadError);

  let resolutions = 0;
  const redirectRebindError = await fetchGeneratedResult('https://rebind.example/out.mp4', 'video', {
    fetchImpl: guarded(async () => {
      resolutions += 1;
      return resolutions === 1
        ? [{ address: publicAddress, family: 4 }]
        : [{ address: '127.0.0.1', family: 4 }];
    }, true),
  }).then(() => null, (e: unknown) => e);
  assert.ok(redirectRebindError instanceof ResultDownloadError);
  assert.equal(redirectRebindError.retryable, false);
  assert.equal(resolutions, 2, 'every redirect hop must resolve and validate again');
}

console.log('result-download.verify: ok (retry/status policy/header deadline/body idle deadline/MIME/size/URL semantics)');
