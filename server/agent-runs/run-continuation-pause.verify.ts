import assert from 'node:assert/strict';
import { MockLanguageModelV3 } from 'ai/test';
import { executeRun, type ServerRunInput } from './executor';
import { createRunWithCapability, flushRunPersistence, prepareRunAdmission, resetServerRunStoreForTest } from './store';
import { RunRecoveryStore, resetRunRecoveryStoreForTest } from './run-recovery-store';
import { resetRunRecoveryRuntimeForTest, runRecoveryKeyOf } from './run-recovery-runtime';
import { startResumedRun } from './run-admission';

const store = new RunRecoveryStore(':memory:');
resetRunRecoveryStoreForTest(store);
try {
  const projectId = 'continuation-setup-failure';
  const run = createRunWithCapability({ projectId, sessionGeneration: await prepareRunAdmission(projectId),
    backend: 'api', provider: 'openai', model: 'gpt-4.1' }).run;
  const key = runRecoveryKeyOf(run);
  const input: ServerRunInput = { messages: [{ role: 'user', content: 'Make a trailer.' }],
    backend: 'api', provider: 'openai', model: 'gpt-4.1', openAiApiMode: 'chat', cacheMode: 'short',
    origin: 'http://127.0.0.1', tools: [], maxOutputTokens: 1_024, autonomousAcceptance: false, maxAcceptanceIterations: 1 };
  const { origin: _origin, tools: _tools, ...saved } = input;
  store.prepareAdmission({ ...key, backend: 'api', model: run.model, askOnly: false,
    admissionExpiresAt: Date.now() + 60_000, executionInput: { ...saved, toolNames: [], references: [] } });
  await executeRun(run, input, { createApiModel: () => { throw new Error('fixture credentials need correction'); } });
  await flushRunPersistence(run);
  const paused = store.load(key)!;
  assert.equal(run.status, 'paused');
  assert.equal(paused.phase, 'paused', 'a failure before the first provider request retains a durable pause');
  assert.equal(paused.attempts[0].status, 'paused');
  assert.equal(paused.ownerInstance, null, 'execution authority releases after the paused event is durable');
  assert.deepEqual(paused.executionInput?.messages, input.messages);
  assert.equal(paused.messages, null, 'no fabricated model turn is required to continue a configuration failure');
  assert.equal(run.events.some((event) => event.type === 'done'), false);
  assert.equal(run.events.filter((event) => event.type === 'run-paused').length, 1);
  assert.deepEqual(startResumedRun(run, { mode: 'resume', expectedRevision: paused.revision }, input.origin),
    { ok: false, status: 409, reason: 'send a new message to continue this paused task' });
  const owner = store.acquireOwnership(key, { instanceId: 'corrected-settings' });
  assert.equal(store.continueAttempt(key, { epoch: owner.epoch!, continuationId: 'fixed', message: 'Continue now.' }), 'accepted');
  assert.deepEqual(store.load(key)!.messages, [...input.messages, { role: 'user', content: 'Continue now.' }]);
  const resume = store.load(key)!;
  store.releaseOwnership(key, { instanceId: 'corrected-settings', epoch: owner.epoch! });
  let calls = 0;
  const corrected = new MockLanguageModelV3({ doStream: async ({ prompt }) => {
    calls++;
    const userText = prompt.filter((message) => message.role === 'user')
      .flatMap((message) => message.content).filter((part) => part.type === 'text').map((part) => part.text);
    assert(userText.includes('Make a trailer.'));
    assert(userText.includes('Continue now.'));
    return { warnings: [], stream: new ReadableStream({ start(controller) {
      controller.enqueue({ type: 'text-start', id: 'reply' });
      controller.enqueue({ type: 'text-delta', id: 'reply', delta: 'Done.' });
      controller.enqueue({ type: 'text-end', id: 'reply' });
      controller.enqueue({ type: 'finish', finishReason: { unified: 'stop', raw: 'stop' },
        usage: { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 2, text: 2, reasoning: 0 } } });
      controller.close();
    } }) };
  } });
  await executeRun(run, input, { resume, createApiModel: () => corrected });
  assert.equal(calls, 1, 'corrected configuration reaches the model once');
  assert.equal(run.status, 'completed', run.error ?? 'continued configuration failure must complete');
  assert.equal(store.load(key)!.attemptNumber, 2);
  assert.equal(store.load(key)!.attempts[1].status, 'completed');
  assert.equal(run.events.filter((event) => event.type === 'done').length, 1);
  // An output cutoff is an unfinished attempt, even though the provider returned normally.
  const limited = createRunWithCapability({ projectId, sessionGeneration: run.sessionGeneration,
    backend: 'api', provider: 'openai', model: input.model }).run;
  const limitedKey = runRecoveryKeyOf(limited);
  store.prepareAdmission({ ...limitedKey, backend: 'api', model: limited.model, askOnly: false,
    admissionExpiresAt: Date.now() + 60_000, executionInput: { ...saved, toolNames: [], references: [] } });
  const cutoff = new MockLanguageModelV3({ doStream: async () => ({ warnings: [], stream: new ReadableStream({ start(controller) {
    controller.enqueue({ type: 'text-start', id: 'cutoff' });
    controller.enqueue({ type: 'text-delta', id: 'cutoff', delta: 'Partial work.' });
    controller.enqueue({ type: 'text-end', id: 'cutoff' });
    controller.enqueue({ type: 'finish', finishReason: { unified: 'length', raw: 'length' },
      usage: { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 2, text: 2, reasoning: 0 } } });
    controller.close();
  } }) }) });
  await executeRun(limited, input, { createApiModel: () => cutoff });
  assert.equal(limited.status, 'paused');
  assert.equal(limited.events.some((event) => event.type === 'done'), false);
  const limitedCheckpoint = store.load(limitedKey)!;
  assert.equal(limitedCheckpoint.requestState, 'pending');
  assert.equal(limitedCheckpoint.messages!.at(-1)!.role, 'assistant');
  assert.match(JSON.stringify(limitedCheckpoint.messages!.at(-1)), /Partial work/);
  console.log('run-continuation-pause.verify: configuration failure pauses durably, releases authority, blocks auto-resume completes after configuration correction, and retains output-cutoff tasks');
} finally {
  resetRunRecoveryRuntimeForTest();
  resetServerRunStoreForTest();
  resetRunRecoveryStoreForTest(null);
}
