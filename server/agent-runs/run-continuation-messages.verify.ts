import assert from 'node:assert/strict';
import { buildRunContinuationMessages } from './run-continuation-messages';
import type { RunRecoveryRun, RunToolRecoveryRow } from './run-recovery-store';

const tool = (opSeq: number, requestIndex: number, overrides: Partial<RunToolRecoveryRow> = {}): RunToolRecoveryRow => ({
  opSeq, requestIndex, toolCallId: `call-${opSeq}`, name: 'edit', argsDigest: `digest-${opSeq}`,
  args: { number: 7, boolean: true, nested: [1, 'a'] }, state: 'outcome', success: true,
  result: { applied: 2 }, ...overrides,
});
const run = { messages: [{ role: 'user', content: 'original' }], requestIndex: 3, requestOpBoundary: 4,
  requestState: 'inflight', tools: [tool(1, 1), tool(4, 3), tool(5, 3),
    tool(6, 3, { success: false, result: { error: 'invalid range' } }),
    tool(7, 3, { state: 'intent' }), tool(8, 2)],
} as unknown as RunRecoveryRun;
const messages = buildRunContinuationMessages(run, 'continue');
assert.equal(messages.length, 4);
assert.deepEqual(messages[1], { role: 'assistant', content: [
  { type: 'tool-call', toolCallId: 'call-5', toolName: 'edit', input: run.tools[2].args },
  { type: 'tool-call', toolCallId: 'call-6', toolName: 'edit', input: run.tools[3].args },
] });
assert.deepEqual(messages[2], { role: 'tool', content: [
  { type: 'tool-result', toolCallId: 'call-5', toolName: 'edit', output: { type: 'json', value: { applied: 2 } } },
  { type: 'tool-result', toolCallId: 'call-6', toolName: 'edit', output: { type: 'error-json', value: { error: 'invalid range' } } },
] });
assert.deepEqual(messages[3], { role: 'user', content: 'continue' });
assert.equal(run.messages!.length, 1, 'building a continuation does not mutate the durable history');
assert.deepEqual(buildRunContinuationMessages({ ...run, requestState: 'pending' }, 'next'), [
  ...run.messages!, { role: 'user', content: 'next' },
]);
assert.deepEqual(buildRunContinuationMessages({ ...run, tools: [] }, 'next'), [
  ...run.messages!, { role: 'user', content: 'next' },
]);
console.log('run-continuation-messages.verify: interrupted confirmed outcomes, typed values, request boundary and pending history passed');
