import { safePublicFetch, UnsafePublicUrlError } from '../safe-public-fetch.ts';

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
  readonly retryable: boolean;

  constructor(url: string, message: string, retryable = true) {
    super(message);
    this.name = 'ResultDownloadError';
    this.url = url;
    this.retryable = retryable;
  }
}

const RETRYABLE_STATUS: Readonly<Partial<Record<number, true>>> = {
  408: true,
  425: true,
  429: true,
  500: true,
  502: true,
  503: true,
  504: true,
};
const ATTEMPTS = 3;

export type GeneratedResultKind = 'audio' | 'video' | 'image' | 'subtitle';

export const GENERATED_RESULT_MAX_BYTES: Readonly<Record<GeneratedResultKind, number>> = {
  audio: 1024 * 1024 * 1024,
  video: 10 * 1024 * 1024 * 1024,
  image: 128 * 1024 * 1024,
  subtitle: 5 * 1024 * 1024,
};

const ALLOWED_MIME: Readonly<Record<GeneratedResultKind, Readonly<Partial<Record<string, true>>>>> = {
  audio: {
    'audio/aac': true, 'audio/flac': true, 'audio/mp4': true, 'audio/mpeg': true,
    'audio/ogg': true, 'audio/opus': true, 'audio/wav': true, 'audio/wave': true,
    'audio/webm': true, 'audio/x-flac': true, 'audio/x-m4a': true, 'audio/x-wav': true,
  },
  video: {
    'video/mp4': true, 'video/mpeg': true, 'video/ogg': true,
    'video/quicktime': true, 'video/webm': true, 'video/x-m4v': true,
  },
  image: {
    'image/avif': true, 'image/gif': true, 'image/heic': true, 'image/heif': true,
    'image/jpeg': true, 'image/png': true, 'image/webp': true,
  },
  subtitle: {
    'application/json': true, 'text/json': true,
  },
};

/** Number of milliseconds to wait after the nth failure (exponential backoff): 400 → 800. exported for verify. */
export const downloadBackoffMs = (attempt: number): number => 400 * 2 ** (attempt - 1);

export const isRetryableDownloadStatus = (status: number): boolean => RETRYABLE_STATUS[status] === true;

interface FetchResultDeps {
  fetchImpl?: (input: string | URL) => Promise<Response>;
  sleep?: (ms: number) => Promise<void>;
  maxBytes?: number;
}

function mediaType(response: Response): string {
  return (response.headers.get('content-type') ?? '').split(';', 1)[0]!.trim().toLowerCase();
}

async function rejectResponse(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}

function limitedBody(
  response: Response,
  url: string,
  label: GeneratedResultKind,
  maxBytes: number,
): ReadableStream<Uint8Array> {
  if (!response.body) {
    throw new ResultDownloadError(url, `generated ${label} download failed (empty response body)`, false);
  }
  const reader = response.body.getReader();
  let received = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await reader.read();
        if (next.done) {
          controller.close();
          return;
        }
        received += next.value.byteLength;
        if (received > maxBytes) {
          await reader.cancel().catch(() => undefined);
          controller.error(new ResultDownloadError(
            url,
            `generated ${label} download failed (body exceeds ${maxBytes} byte limit)`,
            false,
          ));
          return;
        }
        controller.enqueue(next.value);
      } catch (error) {
        controller.error(error);
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}

async function validateSuccessfulResponse(
  response: Response,
  url: string,
  label: GeneratedResultKind,
  maxBytes: number,
): Promise<Response> {
  const contentType = mediaType(response);
  if (ALLOWED_MIME[label][contentType] !== true) {
    await rejectResponse(response);
    throw new ResultDownloadError(
      url,
      `generated ${label} download failed (unsupported content type ${contentType || 'missing'})`,
      false,
    );
  }
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    await rejectResponse(response);
    throw new ResultDownloadError(
      url,
      `generated ${label} download failed (content length exceeds ${maxBytes} byte limit)`,
      false,
    );
  }
  return new Response(limitedBody(response, url, label, maxBytes), {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}
/**
 * Retrieve the URL of a generated finished product. Successfully returns Response (the caller reads the body by himself);
 * Throw ResultDownloadError after exhaustion of retries. `label` is only used for error text (such as "video", "image").
 */
export async function fetchGeneratedResult(
  url: string,
  label: GeneratedResultKind,
  deps: FetchResultDeps = {},
): Promise<Response> {
  const doFetch = deps.fetchImpl ?? safePublicFetch;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => { setTimeout(r, ms); }));
  const maxBytes = deps.maxBytes ?? GENERATED_RESULT_MAX_BYTES[label];
  let reason = 'unknown error';
  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    let response: Response | null = null;
    try {
      response = await doFetch(url);
    } catch (error) {
      if (error instanceof UnsafePublicUrlError) {
        throw new ResultDownloadError(url, `generated ${label} download rejected (${error.message})`, false);
      }
      reason = error instanceof Error ? error.message : String(error);
    }
    if (response) {
      if (response.ok) return validateSuccessfulResponse(response, url, label, maxBytes);
      reason = `HTTP ${response.status}`;
      await rejectResponse(response);
      if (RETRYABLE_STATUS[response.status] !== true) break;
    }
    if (attempt < ATTEMPTS) await sleep(downloadBackoffMs(attempt));
  }
  throw new ResultDownloadError(url, `generated ${label} download failed (${reason})`);
}
