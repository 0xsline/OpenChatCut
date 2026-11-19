import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { RunRecoveryStore } from './run-recovery-store';
import type { RunRecoveryExecutionInput } from './run-recovery-store';

const dir = mkdtempSync(join(tmpdir(), 'run-continuation-'));
const key = { projectId: 'p', sessionGeneration: 'g', runId: 'run' };
const path = join(dir, 'recovery.sqlite3');
let store = new RunRecoveryStore(path);
const admission = { ...key, backend: 'api', model: 'm', askOnly: false, admissionExpiresAt: Date.now() + 60_000 };
const initialMessages = [{ role: 'user' as const, content: 'create a draft' }];
try {
  store.prepareAdmission(admission);
  let epoch = store.acquireOwnership(key, { instanceId: 'one' }).epoch!;
  assert.equal(store.load(key)!.attemptNumber, 1);
  assert.equal(store.load(key)!.attempts.length, 1);
  store.beginRequest(key, { epoch, requestIndex: 1, prompt: 'input', messages: initialMessages, toolNames: ['edit'] });
  const tool = { toolCallId: 'edit-1', name: 'edit', argsDigest: 'same', args: { amount: 12, enabled: true } };
  const intent = store.beginTool(key, { epoch, intent: tool });
  store.finishTool(key, { epoch, outcome: { ...tool, opSeq: intent.opSeq, success: true, local: true, result: { changed: 2 } } });
  store.pauseAttempt(key, new Error('provider disconnected'), epoch);
  store.releaseOwnership(key, { instanceId: 'one', epoch });
  store.close();
  store = new RunRecoveryStore(path);
  assert.equal(store.load(key)!.phase, 'paused');
  assert.equal(store.load(key)!.lastError, 'provider disconnected');
  assert.equal(store.load(key)!.attempts[0].status, 'paused');
  epoch = store.acquireOwnership(key, { instanceId: 'two' }).epoch!;
  const continueInput = { epoch, continuationId: 'continue-1', message: 'keep going and shorten it' };
  assert.equal(store.continueAttempt(key, { ...continueInput, epoch: epoch - 1 }), 'epoch-stale');
  assert.equal(store.continueAttempt(key, { ...continueInput, expectedRevision: -1 }), 'revision-stale');
  const injection = new DatabaseSync(path);
  injection.exec(`CREATE TRIGGER fail_continuation_checkpoint BEFORE UPDATE ON run_recovery_runs
    WHEN NEW.last_continuation_id = 'fail-checkpoint' BEGIN SELECT RAISE(ABORT, 'simulated checkpoint failure'); END`);
  const beforeFailure = store.load(key)!;
  assert.throws(() => store.continueAttempt(key, { ...continueInput, continuationId: 'fail-checkpoint' }), /simulated checkpoint failure/);
  assert.equal(store.load(key)!.attempts.length, beforeFailure.attempts.length, 'failed checkpoint rolls back attempt insertion');
  assert.equal(store.load(key)!.revision, beforeFailure.revision);
  assert.deepEqual(store.load(key)!.messages, beforeFailure.messages);
  injection.exec('DROP TRIGGER fail_continuation_checkpoint');
  injection.close();
  assert.equal(store.continueAttempt(key, continueInput), 'accepted');
  const checkpoint = store.load(key)!;
  assert.equal(checkpoint.key.runId, key.runId);
  assert.equal(checkpoint.attemptNumber, 2);
  assert.equal(checkpoint.lastContinuationId, continueInput.continuationId);
  assert.equal(checkpoint.lastError, null);
  assert.equal(checkpoint.requestIndex, 2);
  assert.equal(checkpoint.requestState, 'pending');
  assert.equal(checkpoint.requestOpBoundary, intent.opSeq);
  assert.equal(checkpoint.prompt, null);
  assert.equal(checkpoint.messages!.length, 4);
  assert.deepEqual(checkpoint.messages![1], { role: 'assistant', content: [
    { type: 'tool-call', toolCallId: tool.toolCallId, toolName: tool.name, input: tool.args },
  ] });
  assert.deepEqual(checkpoint.messages![2], { role: 'tool', content: [
    { type: 'tool-result', toolCallId: tool.toolCallId, toolName: tool.name, output: { type: 'json', value: { changed: 2 } } },
  ] });
  const revision = checkpoint.revision;
  assert.equal(store.continueAttempt(key, continueInput), 'duplicate');
  assert.equal(store.load(key)!.revision, revision);
  assert.equal(store.continueAttempt(key, { ...continueInput, message: 'different' }), 'conflict');
  assert.equal(store.continueAttempt(key, { ...continueInput, continuationId: 'active' }), 'not-paused');
  // A pending checkpoint already contains the previous tool evidence. It must not be added twice.
  store.pauseAttempt(key, 'again', epoch);
  assert.equal(store.continueAttempt(key, { ...continueInput, continuationId: 'continue-2', message: 'next' }), 'accepted');
  assert.equal(store.load(key)!.messages!.length, 5);
  // The next request may deliberately perform the same effective operation again.
  store.beginRequest(key, { epoch, requestIndex: 3, prompt: 'next', messages: store.load(key)!.messages!, toolNames: ['edit'] });
  assert.equal(store.findOperation(key, { name: 'edit', argsDigest: 'same', requestIndex: 3 }), null);
  const second = { ...tool, toolCallId: 'edit-2' };
  store.beginTool(key, { epoch, intent: second });
  store.claimTool(key, { epoch, toolCallId: second.toolCallId, argsDigest: second.argsDigest, claimId: 'claim' });
  store.pauseAttempt(key, 'unknown browser outcome', epoch);
  assert.equal(store.load(key)!.phase, 'needs_reconcile');
  const third = { ...continueInput, continuationId: 'continue-3' };
  assert.equal(store.continueAttempt(key, third), 'unresolved-claims');
  store.recordBrowserOutcome(key, { toolCallId: second.toolCallId, argsDigest: second.argsDigest, claimId: 'claim', result: { changed: 1 } });
  assert.equal(store.load(key)!.phase, 'paused', 'known browser result keeps the explicit continuation barrier');
  assert.equal(store.continueAttempt(key, third), 'accepted');
  store.finalize(key, Date.now(), epoch);
  assert.equal(store.load(key)!.messages, null);
  assert.ok(store.load(key)!.attempts.every((attempt) => attempt.message === null));
  assert.equal(store.continueAttempt(key, third), 'duplicate', 'finalization retains digest-based idempotency');
  assert.equal(store.continueAttempt(key, { ...third, message: 'different' }), 'conflict');
  assert.equal(store.continueAttempt(key, { ...third, continuationId: 'after-finalize' }), 'run-finalized');
  store.close();

  // A real v3 database has no attempt columns/table; migration backfills its first attempt.
  const db = new DatabaseSync(path);
  db.exec('DROP TABLE run_recovery_attempts');
  for (const name of ['attempt_number', 'last_error', 'last_continuation_id']) db.exec(`ALTER TABLE run_recovery_runs DROP COLUMN ${name}`);
  db.exec('PRAGMA user_version = 3');
  db.close();
  store = new RunRecoveryStore(path);
  assert.equal(store.load(key)!.attemptNumber, 1);
  assert.equal(store.load(key)!.attempts[0].status, 'completed');

  for (const backend of ['api', 'codex']) {
    const configureKey = { ...key, runId: `configuration-${backend}` };
    const bytes = Uint8Array.of(1, 2, 3);
    const executionInput = { messages: [{ role: 'user', content: [
      { type: 'text', text: 'original' }, { type: 'image', image: bytes },
    ] }], toolNames: [], references: [] } as unknown as RunRecoveryExecutionInput;
    store.prepareAdmission({ ...admission, ...configureKey, backend, executionInput });
    const configureEpoch = store.acquireOwnership(configureKey, { instanceId: backend }).epoch!;
    store.pauseAttempt(configureKey, 'model setup failed', configureEpoch);
    assert.equal(store.continueAttempt(configureKey, { epoch: configureEpoch, continuationId: 'setup', message: 'retry' }), 'accepted');
    const restored = store.load(configureKey)!;
    assert.deepEqual(restored.executionInput, executionInput);
    assert.deepEqual(restored.messages, [...executionInput.messages, { role: 'user', content: 'retry' }]);
    assert.equal(restored.requestIndex, 1);
  }
  console.log('run-recovery-store-continuation.verify: attempts, restart, CAS, idempotency, typed checkpoints, claim barrier and v3 migration passed');
} finally {
  store.close();
  rmSync(dir, { recursive: true, force: true });
}
