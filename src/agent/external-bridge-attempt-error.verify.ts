// Verify: external-bridge 409-stale handling must not infinitely reload when a
// project keeps returning registration 409 (stale editor from a closed page).
import assert from 'node:assert/strict';

let reloadCalls = 0;
(globalThis as unknown as { window?: unknown }).window = {
  location: { reload: () => { reloadCalls += 1; } },
};

const { handleExternalBridgeAttemptError, resetExternalBridgeAttemptStateForTests }
  = await import('./external-bridge-attempt-error.ts');
const { EditorBridgeRequestError } = await import('./external-bridge-registration.ts');

function staleRegistrationError(status: number): unknown {
  return new EditorBridgeRequestError('registration', status);
}

const noopSignal = { aborted: false } as unknown as AbortSignal;
const onError = (_m: string | null) => {};

resetExternalBridgeAttemptStateForTests();
reloadCalls = 0;

// First-time stale 409 -> reload to sync the authoritative revision.
handleExternalBridgeAttemptError(staleRegistrationError(409), noopSignal, onError);
assert.equal(reloadCalls, 1, 'first stale 409 should reload');

// Repeat stale 409 must be bounded (the guard), not reload forever.
for (let i = 0; i < 100; i++) {
  handleExternalBridgeAttemptError(staleRegistrationError(409), noopSignal, onError);
}
assert.ok(reloadCalls <= 4, `repeated stale 409 must not reload unboundedly (got ${reloadCalls})`);
assert.ok(reloadCalls >= 2, 'stale budget reloads a few times before giving up');

// Non-409 error never reloads.
const before = reloadCalls;
const refresh = handleExternalBridgeAttemptError(new Error('boom'), noopSignal, onError);
assert.equal(refresh, false, 'generic error does not demand credential refresh');
assert.equal(reloadCalls, before, 'generic error does not reload');

console.log(`external-bridge-attempt-error.verify: OK (stale 409 reloads bounded at ${reloadCalls})`);
