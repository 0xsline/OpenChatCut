// Verify: an editor-registration conflict is reported in place and never forces
// a page reload that can trigger beforeunload prompts or a reload loop.
import assert from 'node:assert/strict';

let reloadCalls = 0;
(globalThis as unknown as { window?: unknown }).window = {
  location: { reload: () => { reloadCalls += 1; } },
};

const { handleExternalBridgeAttemptError } = await import('./external-bridge-attempt-error.ts');
const { EditorBridgeRequestError } = await import('./external-bridge-registration.ts');

function staleRegistrationError(status: number): unknown {
  return new EditorBridgeRequestError('registration', status);
}

const noopSignal = { aborted: false } as unknown as AbortSignal;
const errors: string[] = [];
const onError = (message: string | null) => { if (message) errors.push(message); };

reloadCalls = 0;
for (let i = 0; i < 100; i++) {
  handleExternalBridgeAttemptError(staleRegistrationError(409), noopSignal, onError);
}
assert.equal(reloadCalls, 0, 'registration conflicts must not navigate away from the editor');
assert.equal(errors.length, 100, 'each registration conflict must remain visible to the editor');
assert.match(errors[0] ?? '', /手动刷新页面/);

const before = reloadCalls;
const refresh = handleExternalBridgeAttemptError(new Error('boom'), noopSignal, onError);
assert.equal(refresh, false, 'generic error does not demand credential refresh');
assert.equal(reloadCalls, before, 'generic error does not reload');

console.log('external-bridge-attempt-error.verify: OK (registration conflicts stay in place)');
