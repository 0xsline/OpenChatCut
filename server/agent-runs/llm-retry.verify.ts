import assert from 'node:assert/strict';
import { APICallError } from 'ai';
import {
  classifyLlmFailure,
  isRetryableLlmFailure,
  MAX_LLM_ATTEMPTS,
  MAX_RETRY_DELAY_MS,
  resolveRetryDelayMs,
} from './llm-retry.ts';

function apiError(statusCode: number, body = '', headers?: Record<string, string>): APICallError {
  return new APICallError({
    message: 'call failed',
    url: 'https://example.invalid/v1/chat',
    requestBodyValues: {},
    statusCode,
    responseBody: body,
    responseHeaders: headers,
    isRetryable: false,
  });
}

// Deterministic failures are never retried.
assert.equal(classifyLlmFailure(apiError(401)).code, 'AUTH');
assert.equal(classifyLlmFailure(apiError(403)).code, 'AUTH');
assert.equal(classifyLlmFailure(apiError(400)).code, 'INVALID_REQUEST');
assert.equal(classifyLlmFailure(apiError(422, '')).code, 'INVALID_REQUEST');
assert.equal(classifyLlmFailure(apiError(402, '')).code, 'QUOTA');
assert.equal(classifyLlmFailure(apiError(200, '{"error":"insufficient_quota"}')).code, 'QUOTA');
assert.equal(classifyLlmFailure(new Error('boom')).code, 'UNKNOWN');

// Context overflow is detected from the response body, not retried.
assert.equal(
  classifyLlmFailure(apiError(400, 'This model\'s maximum context length is 65536 tokens.')).code,
  'CONTEXT_WINDOW_EXCEEDED',
);

// Transient failures are retryable.
assert.equal(classifyLlmFailure(apiError(500)).code, 'SERVER');
assert.equal(classifyLlmFailure(apiError(502)).code, 'SERVER');
assert.equal(classifyLlmFailure(apiError(429, '', { 'retry-after': '3' })).code, 'RATE_LIMIT');
assert.equal(
  classifyLlmFailure(apiError(429, '', { 'retry-after': '3' })).retryAfterMs,
  3000,
);
assert.equal(classifyLlmFailure(new TypeError('fetch failed')).code, 'TRANSPORT');
// AI SDK chunk/step timers abort with a TimeoutError DOMException — transient, retryable.
assert.equal(
  classifyLlmFailure(new DOMException('Chunk timeout of 120000ms exceeded', 'TimeoutError')).code,
  'TIMEOUT',
);
assert.equal(
  classifyLlmFailure(new DOMException('The operation was aborted.', 'AbortError')).code,
  'TIMEOUT',
);
assert.equal(classifyLlmFailure(new (class extends Error {})('x')).code, 'UNKNOWN');
// Retryable set matches the classification above.
for (const code of ['RATE_LIMIT', 'TIMEOUT', 'SERVER', 'TRANSPORT', 'EMPTY_RESPONSE']) {
  assert.equal(isRetryableLlmFailure(code as never), true, code);
}
for (const code of ['AUTH', 'INVALID_REQUEST', 'QUOTA', 'CONTEXT_WINDOW_EXCEEDED', 'UNKNOWN']) {
  assert.equal(isRetryableLlmFailure(code as never), false, code);
}

// Rate-limit retries honor Retry-After within the max cap.
const rateLimited = { code: 'RATE_LIMIT' as const, message: '', retryAfterMs: 3000 };
assert.equal(resolveRetryDelayMs(rateLimited, 0), 3000);
assert.equal(
  resolveRetryDelayMs({ code: 'RATE_LIMIT', message: '', retryAfterMs: 60_000 }, 0),
  MAX_RETRY_DELAY_MS,
);

// Transient backoff grows exponentially and stays within bounds.
for (let attempt = 0; attempt < MAX_LLM_ATTEMPTS; attempt += 1) {
  const delay = resolveRetryDelayMs({ code: 'SERVER', message: '' }, attempt);
  assert.ok(delay >= 0 && delay <= MAX_RETRY_DELAY_MS, `attempt ${attempt}: ${delay}`);
}

console.log('server llm-retry classification checks passed');
