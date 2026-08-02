import { UnsupportedFunctionalityError } from 'ai';
export function errorMessage(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const status = (error as Error & { statusCode?: number; status?: number }).statusCode
    ?? (error as Error & { status?: number }).status;
  return status != null && !error.message.startsWith(String(status))
    ? `${status} ${error.message}`
    : error.message;
}

export interface CompatibleMediaRetryContext {
  protocol: string;
  movedMedia: boolean;
  retryAttempted: boolean;
  outputStarted: boolean;
  aborted: boolean;
  error: unknown;
}

export function isCompatibleMediaFallbackError(error: unknown): boolean {
  if (error == null || (typeof error !== 'object' && typeof error !== 'function')) return false;
  const shaped = error as { name?: unknown; statusCode?: unknown; status?: unknown };
  if (shaped.name === 'AbortError') return false;
  if (UnsupportedFunctionalityError.isInstance(error)) return true;
  return shaped.statusCode === 400 || shaped.status === 400;
}

export function shouldRetryCompatibleMediaRequest({
  protocol,
  movedMedia,
  retryAttempted,
  outputStarted,
  aborted,
  error,
}: CompatibleMediaRetryContext): boolean {
  return protocol === 'openai-compatible'
    && movedMedia
    && !retryAttempted
    && !outputStarted
    && !aborted
    && isCompatibleMediaFallbackError(error);
}

export interface TransientAgentRetryContext {
  retryAttempted: boolean;
  outputStarted: boolean;
  aborted: boolean;
  error: unknown;
}

function isTransientAgentRequestError(error: unknown): boolean {
  if (error == null || (typeof error !== 'object' && typeof error !== 'function')) return false;
  const shaped = error as {
    name?: unknown;
    statusCode?: unknown;
    status?: unknown;
    code?: unknown;
    cause?: unknown;
    message?: unknown;
    isRetryable?: unknown;
  };
  const cause = shaped.cause && typeof shaped.cause === 'object'
    ? shaped.cause as {
      name?: unknown;
      statusCode?: unknown;
      status?: unknown;
      code?: unknown;
      message?: unknown;
      isRetryable?: unknown;
    }
    : null;
  if (shaped.name === 'AbortError' || cause?.name === 'AbortError') return false;
  const status = shaped.statusCode ?? shaped.status ?? cause?.statusCode ?? cause?.status;
  if (status === 502 || status === 503 || status === 504) return true;
  if (status != null) return false;
  if (shaped.isRetryable === true || cause?.isRetryable === true) return true;

  const signal = [shaped.code, shaped.message, cause?.code, cause?.message].map(String).join(' ');
  if (/\b(?:ECONNRESET|ECONNREFUSED|EPIPE|ETIMEDOUT|UND_ERR_SOCKET)\b|upstream request failed/i.test(signal)) {
    return true;
  }
  const browserNetworkFailure = /^(?:failed to fetch|fetch failed|load failed|networkerror(?: when attempting to fetch resource\.?)?)$/i;
  return [shaped, cause].some((candidate) => (
    candidate?.name === 'TypeError'
    && browserNetworkFailure.test(String(candidate.message ?? '').trim())
  ));
}

export function shouldRetryTransientAgentRequest({
  retryAttempted,
  outputStarted,
  aborted,
  error,
}: TransientAgentRetryContext): boolean {
  return !retryAttempted
    && !outputStarted
    && !aborted
    && isTransientAgentRequestError(error);
}

export function streamPartStartsCompatibleMediaOutput(type: string): boolean {
  return type === 'text-start'
    || type === 'text-delta'
    || type === 'text-end'
    || type === 'reasoning-start'
    || type === 'reasoning-delta'
    || type === 'reasoning-end'
    || type === 'reasoning-file'
    || type === 'file'
    || type === 'source'
    || type === 'custom'
    || type === 'tool-input-start'
    || type === 'tool-input-delta'
    || type === 'tool-input-end'
    || type === 'tool-call'
    || type === 'tool-result'
    || type === 'tool-error'
    || type === 'tool-output-denied'
    || type === 'tool-approval-request'
    || type === 'tool-approval-response';
}

type SynchronousStart<T> =
  | { ok: true; value: T }
  | { ok: false; error: unknown };

export function captureSynchronousStart<T>(start: () => T): SynchronousStart<T> {
  try {
    return { ok: true, value: start() };
  } catch (error) {
    return { ok: false, error };
  }
}
