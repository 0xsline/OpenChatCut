// 成品下载:供应商已经把图/片/音频生成出来了(钱已经花掉),这一步只是把它取回本地。
//
// 这条腿失败特别贵。原先的处理是把异常一路吞成一句 job.error,连供应商返回的结果 URL
// 一起丢掉——一次网络抖动或 CDN 5xx 就让已付费的成品彻底拿不回来,只能重新花钱生成。
// 所以这里做两件事:
//   ① 瞬时失败(连接错误、408/429/5xx)自动重试几次,把大多数抖动直接消化掉;
//   ② 重试完仍失败就抛出带 URL 的专用错误,由任务层记在 job 上留作补救依据。
// 4xx(除限流)不重试:那是请求本身不对,重试只是把钱和时间再烧一遍。

/** 下载腿失败。带着供应商的结果 URL,以便任务层留存补救。 */
export class ResultDownloadError extends Error {
  readonly url: string;

  constructor(url: string, message: string) {
    super(message);
    this.name = 'ResultDownloadError';
    this.url = url;
  }
}

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
const ATTEMPTS = 3;

/** 第 n 次失败后的等待毫秒数(指数退避):400 → 800。exported for verify。 */
export const downloadBackoffMs = (attempt: number): number => 400 * 2 ** (attempt - 1);

export const isRetryableDownloadStatus = (status: number): boolean => RETRYABLE_STATUS.has(status);

interface FetchResultDeps {
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * 取回一个已生成成品的 URL。成功返回 Response(调用方自己读 body);
 * 重试用尽后抛 ResultDownloadError。`label` 只用于错误文案(如 "video"、"image")。
 */
export async function fetchGeneratedResult(
  url: string,
  label: string,
  deps: FetchResultDeps = {},
): Promise<Response> {
  const doFetch = deps.fetchImpl ?? fetch;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => { setTimeout(r, ms); }));
  let reason = 'unknown error';
  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    let response: Response | null = null;
    try {
      response = await doFetch(url);
    } catch (error) {
      reason = error instanceof Error ? error.message : String(error);
    }
    if (response) {
      if (response.ok) return response;
      reason = `HTTP ${response.status}`;
      if (!RETRYABLE_STATUS.has(response.status)) break;
    }
    if (attempt < ATTEMPTS) await sleep(downloadBackoffMs(attempt));
  }
  throw new ResultDownloadError(url, `generated ${label} download failed (${reason})`);
}
