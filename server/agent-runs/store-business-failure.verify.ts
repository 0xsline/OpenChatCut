import assert from 'node:assert/strict';
import {
  claimToolRequest,
  createRun,
  digestToolArgs,
  flushRunPersistence,
  resetServerRunStoreForTest,
  settleToolResult,
  waitForToolResult,
} from './store.ts';
import { runtimeEvent } from './store-values.ts';

resetServerRunStoreForTest();
const run = createRun({
  projectId: 'server-run-business-failure',
  sessionGeneration: 'legacy',
  provider: 'deepseek',
  model: 'test-model',
});
const argsDigest = digestToolArgs({ itemId: 'missing-clip' });
const result = waitForToolResult(run, 'call-business-failure', 'edit_item', argsDigest);
assert.equal(claimToolRequest(run, {
  toolCallId: 'call-business-failure',
  argsDigest,
  claimId: 'browser-1',
}), 'claimed');
assert.equal(settleToolResult(run, {
  toolCallId: 'call-business-failure',
  argsDigest,
  claimId: 'browser-1',
  result: { ok: false, error: 'unknown item' },
}), 'accepted');
await assert.rejects(result, /unknown item/,
  'business failure objects settle on the error channel instead of succeeding');
await flushRunPersistence(run);
const event = run.events.find((candidate) => candidate.type === 'tool-result');
assert(event, 'the failed result is written to the server ledger');
assert.deepEqual(event.data, {
  toolCallId: 'call-business-failure',
  toolName: 'edit_item',
  argsDigest,
  error: 'unknown item',
});
assert.deepEqual(runtimeEvent(event).outcome, {
  kind: 'terminal_failure',
  summary: 'unknown item',
}, 'the durable runtime ledger preserves the failure outcome');
console.log('server run store business-failure verification passed');
