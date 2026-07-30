// Runnable check: `npx tsx server/plugins/result-download.verify.ts`.
// 成品下载是「钱已经花完」之后的最后一步,失败代价最高。验证:瞬时错误会重试、
// 4xx 不白重试、重试用尽后抛出的错误带着供应商 URL(任务层据此留住已付费的结果)。
import assert from 'node:assert/strict';
import {
  ResultDownloadError,
  downloadBackoffMs,
  fetchGeneratedResult,
  isRetryableDownloadStatus,
} from './result-download.ts';

const ok = () => new Response('bytes', { status: 200 });
const status = (code: number) => new Response('nope', { status: code });
const URL_ = 'https://provider.example/out.mp4';

/** 记录每次调用,按预设脚本依次返回(Response 直接返回,Error 抛出)。 */
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

// ── 退避与可重试判定 ──
{
  assert.deepEqual([downloadBackoffMs(1), downloadBackoffMs(2)], [400, 800], '指数退避');
  for (const code of [408, 425, 429, 500, 502, 503, 504]) {
    assert.ok(isRetryableDownloadStatus(code), `${code} 应重试`);
  }
  for (const code of [400, 401, 403, 404, 410, 422]) {
    assert.ok(!isRetryableDownloadStatus(code), `${code} 是请求本身不对,重试只是再烧一遍`);
  }
}

// ── 一次成功:不重试、不等待 ──
{
  const s = scriptedFetch([ok()]);
  const res = await fetchGeneratedResult(URL_, 'video', s);
  assert.equal(res.status, 200);
  assert.equal(s.calls.length, 1);
  assert.deepEqual(s.waits, []);
}

// ── 瞬时 5xx 后成功:这才是真正省钱的那一半 ──
{
  const s = scriptedFetch([status(502), ok()]);
  const res = await fetchGeneratedResult(URL_, 'video', s);
  assert.equal(res.status, 200, 'CDN 抖动被消化掉,用户无感');
  assert.equal(s.calls.length, 2);
  assert.deepEqual(s.waits, [400]);
}

// ── 网络异常也重试 ──
{
  const s = scriptedFetch([new Error('ECONNRESET'), ok()]);
  assert.equal((await fetchGeneratedResult(URL_, 'video', s)).status, 200);
  assert.equal(s.calls.length, 2);
}

// ── 重试用尽:抛 ResultDownloadError 且带着 URL ──
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

// ── 4xx 立即放弃,但仍然带 URL ──
{
  const s = scriptedFetch([status(404), ok(), ok()]);
  const error = await fetchGeneratedResult(URL_, 'image', s).then(() => null, (e: unknown) => e);
  assert.ok(error instanceof ResultDownloadError);
  assert.equal(error.url, URL_);
  assert.equal(s.calls.length, 1, '404 不重试');
  assert.deepEqual(s.waits, [], '也不该等待');
}

console.log('result-download.verify: ok (退避/可重试判定/瞬时恢复/网络异常/带 URL 的失败/4xx 不重试)');
