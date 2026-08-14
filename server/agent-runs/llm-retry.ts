import { APICallError } from 'ai';
import { pushRunEvent, type ServerRun } from './store';

/**
 * Provider-neutral failure classification for server-run LLM turns.
 *
 * Only transient failures are retried. Deterministic failures (bad key, bad
 * request, exhausted quota, context overflow) are never retried: a retry
 * cannot fix them and only burns quota or delays the user.
 */
export type LlmFailureCode =
  | 'RATE_LIMIT'
  | 'TIMEOUT'
  | 'SERVER'
  | 'TRANSPORT'
  | 'EMPTY_RESPONSE'
  | 'AUTH'
  | 'INVALID_REQUEST'
  | 'QUOTA'
  | 'CONTEXT_WINDOW_EXCEEDED'
  | 'UNKNOWN';

export interface LlmFailure {
  readonly code: LlmFailureCode;
  readonly message: string;
  readonly retryAfterMs?: number;
}

const RETRYABLE_CODES: ReadonlySet<LlmFailureCode> = new Set([
  'RATE_LIMIT',
  'TIMEOUT',
  'SERVER',
  'TRANSPORT',
  'EMPTY_RESPONSE',
]);

const QUOTA_BODY_PATTERN = /insufficient_quota|quota exceeded|balance.*(not enough|insufficient)/i;
const CONTEXT_BODY_PATTERN = /maximum context length|context length|tokens.*exceed/i;

export const MAX_LLM_ATTEMPTS = 3; // 1 initial call + 2 retries
export const INITIAL_RETRY_DELAY_MS = 500;
export const MAX_RETRY_DELAY_MS = 10_000;
const RETRY_JITTER = 0.15;

export function classifyLlmFailure(error: unknown): LlmFailure {
  if (error instanceof APICallError) {
    const { statusCode, responseBody } = error;
    const body = typeof responseBody === 'string' ? responseBody : '';
    if (statusCode === 401 || statusCode === 403) {
      return { code: 'AUTH', message: error.message };
    }
    if (statusCode === 429) {
      return {
        code: 'RATE_LIMIT',
        message: error.message,
        retryAfterMs: parseRetryAfter(error.responseHeaders),
      };
    }
    if (statusCode === 400 || statusCode === 404 || statusCode === 413 || statusCode === 422) {
      return {
        code: CONTEXT_BODY_PATTERN.test(body) ? 'CONTEXT_WINDOW_EXCEEDED' : 'INVALID_REQUEST',
        message: error.message,
      };
    }
    if (statusCode === 402 || QUOTA_BODY_PATTERN.test(body)) {
      return { code: 'QUOTA', message: error.message };
    }
    if (statusCode !== undefined && statusCode >= 500) {
      return { code: 'SERVER', message: error.message };
    }
    return { code: 'TRANSPORT', message: error.message };
  }
  const name = error instanceof Error ? error.name : '';
  if (name === 'AbortError' || name === 'TimeoutError') {
    // The caller checks its own abort signal first; reaching this branch
    // means the attempt timed out or was aborted mid-flight by the SDK.
    // The AI SDK chunk/step timers abort with a TimeoutError DOMException,
    // which is transient and retryable exactly like an AbortError.
    return { code: 'TIMEOUT', message: safeMessage(error) };
  }
  if (error instanceof Error && (name === 'TypeError' || name === 'FetchError')) {
    return { code: 'TRANSPORT', message: error.message };
  }
  return { code: 'UNKNOWN', message: safeMessage(error) };
}

export function isRetryableLlmFailure(code: LlmFailureCode): boolean {
  return RETRYABLE_CODES.has(code);
}

export function resolveRetryDelayMs(
  failure: LlmFailure,
  attempt: number,
): number {
  const retryAfterMs = failure.retryAfterMs;
  if (failure.code === 'RATE_LIMIT'
    && retryAfterMs !== undefined
    && Number.isFinite(retryAfterMs)
    && retryAfterMs > 0) {
    return Math.min(retryAfterMs, MAX_RETRY_DELAY_MS);
  }
  const base = Math.min(INITIAL_RETRY_DELAY_MS * 2 ** attempt, MAX_RETRY_DELAY_MS);
  const jitter = base * RETRY_JITTER * (Math.random() * 2 - 1);
  return Math.max(0, Math.round(base + jitter));
}

export async function delayAbortable(ms: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return false;
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      const onAbort = (): void => {
        clearTimeout(timer);
        reject(new Error('aborted'));
      };
      signal.addEventListener('abort', onAbort, { once: true });
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Runs one server LLM turn with bounded transient retries. Returns the turn
 * outcome, or rethrows the original error when the failure is deterministic,
 * the retry budget is exhausted, or the run was aborted.
 */
export async function runServerTurnWithRetry<T>(
  run: ServerRun,
  requestIndex: number,
  signal: AbortSignal,
  attempt: () => Promise<T>,
): Promise<T> {
  for (let call = 0; call < MAX_LLM_ATTEMPTS; call += 1) {
    try {
      return await attempt();
    } catch (error) {
      if (signal.aborted) throw error;
      const failure = classifyLlmFailure(error);
      if (!isRetryableLlmFailure(failure.code) || call === MAX_LLM_ATTEMPTS - 1) {
        throw error;
      }
      const delayMs = resolveRetryDelayMs(failure, call);
      pushRunEvent(run, 'llm-retry', {
        requestIndex,
        attempt: call + 1,
        code: failure.code,
        delayMs,
      });
      if (!(await delayAbortable(delayMs, signal))) throw error;
      pushRunEvent(run, 'llm-retry-start', { requestIndex, attempt: call + 1 });
    }
  }
  /* v8 ignore next -- the loop always returns or throws */
  throw new Error('unreachable');
}

function parseRetryAfter(headers: Record<string, string> | undefined): number | undefined {
  const raw = headers?.['retry-after'];
  if (raw === undefined) return undefined;
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : undefined;
}

function safeMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
