import { proxyDispatcher } from '../outbound-proxy.ts';
import type { RegisterGenerationProviderTask } from './generation-jobs.ts';
import type { ValidVideoRequest } from './video-validation.ts';

type FetchInit = Parameters<typeof fetch>[1] & { dispatcher?: unknown };
const fetchWithProxy = (url: RequestInfo | URL, init?: FetchInit): Promise<Response> =>
  fetch(url, { ...init, dispatcher: proxyDispatcher() } as RequestInit);

const DEFAULT_BASE_URL = 'https://api.muapi.ai/api/v1';
const DEFAULT_ENDPOINT = 'seedance-lite-t2v';
const DEFAULT_RESOLUTION = '480p';
const DEFAULT_POLL_INTERVAL_MS = 3_000;
const DEFAULT_TIMEOUT_MS = 15 * 60_000;
const RETRYABLE_STATUS_CODES = new Set([408, 425, 429, 500, 502, 503, 504]);
const SUCCESS_STATUSES = new Set(['completed', 'succeeded', 'success']);
const FAILURE_STATUSES = new Set(['failed', 'cancelled', 'canceled', 'expired']);

export interface MuAPIVideoOptions {
  muapiBaseUrl: string;
  muapiApiKey: string;
  muapiVideoEndpoint: string;
  muapiResolution: string;
  /** Test-only timing overrides; production uses the documented defaults. */
  pollIntervalMs?: number;
  timeoutMs?: number;
}

/** A POST may have been accepted even when the client cannot observe its response.
 * Never classify this as retryable: repeating the POST could create a second paid job. */
export class MuAPIUnconfirmedTaskError extends Error {
  readonly code = 'submission_unknown';
  readonly retryable = false;

  constructor(detail: string) {
    super(`MuAPI submission outcome is unknown; do not retry automatically: ${detail}`);
    this.name = 'MuAPIUnconfirmedTaskError';
  }
}

function baseUrl(value: string): string {
  const normalized = (value || DEFAULT_BASE_URL).trim().replace(/\/+$/, '');
  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new Error('MUAPI_BASE_URL must be an absolute HTTP(S) URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('MUAPI_BASE_URL must be an absolute HTTP(S) URL');
  }
  if (parsed.username || parsed.password) throw new Error('MUAPI_BASE_URL must not contain embedded credentials');
  return normalized;
}

function endpoint(value: string): string {
  const normalized = (value || DEFAULT_ENDPOINT).trim().replace(/^\/+|\/+$/g, '');
  if (!normalized || normalized.includes('://') || normalized.includes('?') || normalized.includes('#')
    || !/^[A-Za-z0-9._/-]+$/.test(normalized)) {
    throw new Error('MUAPI_VIDEO_ENDPOINT must be a non-empty relative endpoint path');
  }
  return normalized;
}

async function responseError(response: Response): Promise<string> {
  const text = await response.text();
  try {
    const body = JSON.parse(text) as {
      detail?: unknown;
      message?: unknown;
      error?: unknown;
    };
    const error = body.error;
    const detail = typeof error === 'object' && error !== null
      ? (error as { message?: unknown; detail?: unknown }).message
        ?? (error as { message?: unknown; detail?: unknown }).detail
      : error;
    const message = detail ?? body.detail ?? body.message;
    if (typeof message === 'string' && message.trim()) return message.trim().slice(0, 300);
  } catch {
    // Keep the bounded raw response below for non-JSON provider errors.
  }
  return text.trim().slice(0, 300) || `MuAPI request failed (HTTP ${response.status})`;
}

function isTransientNetworkError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.name === 'AbortError' || error.name === 'TimeoutError'
    || error instanceof TypeError || /fetch failed|network|timed out/i.test(error.message);
}

function outputUrl(body: Record<string, unknown>): string | undefined {
  const outputs = Array.isArray(body.outputs) ? body.outputs : [];
  for (const output of outputs) {
    const candidate = typeof output === 'string'
      ? output
      : output && typeof output === 'object'
        ? (output as { url?: unknown; video_url?: unknown; output_url?: unknown }).url
          ?? (output as { video_url?: unknown }).video_url
          ?? (output as { output_url?: unknown }).output_url
        : undefined;
    if (typeof candidate === 'string' && /^https?:\/\//.test(candidate)) return candidate;
  }
  return undefined;
}

function retryDelayMs(attempt: number): number {
  return Math.min(15_000, 1_000 * 2 ** Math.min(attempt, 4));
}

/** MuAPI uses a stable task id for polling. Transient poll failures retry that
 * same id; the initial POST is intentionally never retried. */
export async function generateMuAPIVideo(
  input: ValidVideoRequest,
  options: MuAPIVideoOptions,
  registerProviderTask: RegisterGenerationProviderTask,
  existingTaskId?: string,
): Promise<string> {
  if (!options.muapiApiKey.trim()) throw new Error('MuAPI generation is not configured. Set MUAPI_API_KEY in .env.local.');
  const root = baseUrl(options.muapiBaseUrl);
  const route = endpoint(options.muapiVideoEndpoint);
  const resolution = options.muapiResolution.trim() || DEFAULT_RESOLUTION;
  const headers = { 'Content-Type': 'application/json', 'x-api-key': options.muapiApiKey };
  let taskId = existingTaskId?.trim();

  if (!taskId) {
    let startedResponse: Response;
    try {
      startedResponse = await fetchWithProxy(`${root}/${route}`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          prompt: input.prompt,
          aspect_ratio: input.ratio,
          resolution,
          duration: input.durationSeconds,
        }),
        signal: AbortSignal.timeout(120_000),
      });
    } catch (error) {
      throw new MuAPIUnconfirmedTaskError(`the submit request failed (${error instanceof Error ? error.message : String(error)})`);
    }
    if (startedResponse.status >= 500) {
      throw new MuAPIUnconfirmedTaskError(`the provider returned HTTP ${startedResponse.status}`);
    }
    if (!startedResponse.ok) throw new Error(await responseError(startedResponse));

    let started: { request_id?: unknown; id?: unknown };
    try {
      started = await startedResponse.json() as { request_id?: unknown; id?: unknown };
    } catch {
      throw new MuAPIUnconfirmedTaskError('the provider returned a successful response without readable JSON');
    }
    const candidate = started.request_id ?? started.id;
    if (typeof candidate !== 'string' || !candidate.trim()) {
      throw new MuAPIUnconfirmedTaskError('the provider returned a successful response without a request id');
    }
    taskId = candidate.trim();
    await registerProviderTask('muapi', taskId);
  }

  const deadline = Date.now() + Math.max(1_000, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const pollInterval = Math.max(0, options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
  let transientFailures = 0;
  while (Date.now() < deadline) {
    try {
      const poll = await fetchWithProxy(`${root}/predictions/${encodeURIComponent(taskId)}/result`, {
        headers,
        signal: AbortSignal.timeout(20_000),
      });
      if (!poll.ok) {
        if (RETRYABLE_STATUS_CODES.has(poll.status) && Date.now() < deadline) {
          transientFailures += 1;
          await new Promise((resolve) => setTimeout(resolve, retryDelayMs(transientFailures)));
          continue;
        }
        throw new Error(await responseError(poll));
      }
      const current = await poll.json() as Record<string, unknown>;
      transientFailures = 0;
      const status = String(current.status ?? '').trim().toLowerCase();
      if (SUCCESS_STATUSES.has(status)) {
        const url = outputUrl(current);
        if (!url) throw new Error('MuAPI generation completed without a video URL');
        return url;
      }
      if (FAILURE_STATUSES.has(status)) {
        const error = current.error;
        const detail = typeof error === 'object' && error !== null
          ? (error as { message?: unknown }).message
          : error;
        throw new Error(`MuAPI generation ${status}${typeof detail === 'string' && detail ? `: ${detail}` : ''}`);
      }
      await new Promise((resolve) => setTimeout(resolve, pollInterval));
    } catch (error) {
      if (!isTransientNetworkError(error) || Date.now() >= deadline) {
        throw error;
      }
      transientFailures += 1;
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs(transientFailures)));
    }
  }
  throw new Error('MuAPI generation timed out');
}
