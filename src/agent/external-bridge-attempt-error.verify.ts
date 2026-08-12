// Verify: an editor-registration/poll HTTP 409 is a recoverable retry condition
// (runBridge re-registers within ~1s) and must not flash a blocking "close the
// other window" message, navigate away, or reload. Non-409 errors still surface.
import assert from 'node:assert/strict';

let reloadCalls = 0;
(globalThis as unknown as { window?: unknown }).window = {
  location: { reload: () => { reloadCalls += 1; } },
};

const { handleExternalBridgeAttemptError } = await import('./external-bridge-attempt-error.ts');
const { EditorBridgeRequestError } = await import('./external-bridge-registration.ts');

function bridgeError(operation: string, status: number): unknown {
  return new EditorBridgeRequestError(operation, status);
}

const noopSignal = { aborted: false } as unknown as AbortSignal;
const errors: string[] = [];
const onError = (message: string | null) => { if (message) errors.push(message); };

reloadCalls = 0;
for (let i = 0; i < 100; i++) {
  handleExternalBridgeAttemptError(bridgeError('registration', 409), noopSignal, onError);
  handleExternalBridgeAttemptError(bridgeError('poll', 409), noopSignal, onError);
  handleExternalBridgeAttemptError(bridgeError('cancellation', 409), noopSignal, onError);
}
assert.equal(reloadCalls, 0, 'recoverable 409 must not navigate away from the editor');
assert.equal(errors.length, 0,
  'a transient 409 must not surface a blocking "close other window" message; runBridge retries it');

const before = reloadCalls;
handleExternalBridgeAttemptError(new Error('boom'), noopSignal, onError);
assert.match(errors.at(-1) ?? '', /boom/, 'a genuine non-409 error still surfaces');
assert.equal(reloadCalls, before, 'generic error does not reload');

console.log('external-bridge-attempt-error.verify: OK (409 retried silently, others surfaced)');
