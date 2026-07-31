// Download the finished product: The supplier has already generated the images/pictures/audio (the money has been spent), this step is just to get it back locally.
//
// This leg is particularly expensive to fail. The original processing was to swallow the exception into one sentence, job.error, and even the result URL returned by the supplier.
// Throw it away together - a network jitter or CDN 5xx will make it impossible to get the paid product back, and you can only spend money to generate it again.
// So do two things here:
// ① Instantaneous failure (connection error, 408/429/5xx) automatically retries several times to directly digest most of the jitter;
// ② If the error still fails after retrying, a special error with URL will be thrown, which will be recorded on the job by the task layer as a basis for remediation.
// 4xx (except current limit) does not retry: that is the request itself is wrong, and retrying will just burn money and time again.

/** Failed to download legs. Brings the provider's result URL for task layer retention remediation. */
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

/** Number of milliseconds to wait after the nth failure (exponential backoff): 400 → 800. exported for verify. */
export const downloadBackoffMs = (attempt: number): number => 400 * 2 ** (attempt - 1);

export const isRetryableDownloadStatus = (status: number): boolean => RETRYABLE_STATUS.has(status);

interface FetchResultDeps {
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Retrieve the URL of a generated finished product. Successfully returns Response (the caller reads the body by himself);
 * Throw ResultDownloadError after exhaustion of retries. `label` is only used for error text (such as "video", "image").
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
