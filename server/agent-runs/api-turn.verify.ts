import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockLanguageModelV3 } from 'ai/test';
import type { ModelMessage } from 'ai';
import type { LanguageModelV3CallOptions, LanguageModelV3StreamPart } from '@ai-sdk/provider';
import { executeServerApiTurn, type ServerApiTurnInput } from './api-turn';
import { createRunWithCapability, pushRunEvent, flushRunPersistence, claimToolRequest, settleToolResult, prepareRunAdmission, resetServerRunStoreForTest, digestToolArgs, type ServerRun } from './store';
import { canonicalServerRunToolCatalog } from './tool-policy';
import { ToolActivation } from '../../src/agent/tool-activation';
import { ToolFailureTracker } from '../../src/agent/toolFailure';
import { createAcceptanceLoop } from './acceptance-loop';
import { RUN_RECOVERY_DB_ENV, RunRecoveryStore, resetRunRecoveryStoreForTest } from './run-recovery-store';
import { beginRunRecoveryRuntime, claimRunRecoveryTool, runRecoveryKeyOf, resetRunRecoveryRuntimeForTest } from './run-recovery-runtime';
import { isRunRecoveryFault } from './run-recovery-fault';
import { executeRun, type ServerRunInput } from './executor';

const directory = mkdtempSync(join(tmpdir(), 'api-turn-recovery-'));
process.env[RUN_RECOVERY_DB_ENV] = join(directory, 'recovery.sqlite3');
const store = new RunRecoveryStore(process.env[RUN_RECOVERY_DB_ENV]);
resetRunRecoveryStoreForTest(store);
const catalog = canonicalServerRunToolCatalog(false);
const schemas = catalog.filter((schema) => ['edit_item', 'read_timeline', 'analyze_music'].includes(schema.name));
const editArgs = { updates: [{ type: 'video', itemId: 'clip-7', durationInFrames: 120 }] };
const usage = { inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 10, text: 10, reasoning: 0 } };
const finish = (reason: 'stop' | 'tool-calls' | 'length' = 'tool-calls'): LanguageModelV3StreamPart => ({ type: 'finish', finishReason: { unified: reason, raw: reason }, usage });
const call = (id: string, name = 'edit_item', args: unknown = editArgs): LanguageModelV3StreamPart => ({ type: 'tool-call', toolCallId: id, toolName: name, input: JSON.stringify(args) });
const unhandled: unknown[] = [];
const onUnhandled = (error: unknown) => { unhandled.push(error); };
process.on('unhandledRejection', onUnhandled);

async function scenario(name: string, messages: ModelMessage[] = [{ role: 'user', content: 'Trim clip-7.' }]) {
  resetRunRecoveryRuntimeForTest();
  resetServerRunStoreForTest();
  const projectId = `api-turn-${name}`;
  const run = createRunWithCapability({ projectId, sessionGeneration: await prepareRunAdmission(projectId), backend: 'api', provider: 'deepseek', model: 'mock-thinking' }).run;
  const key = runRecoveryKeyOf(run);
  assert.equal(store.prepareAdmission({ ...key, backend: 'api', model: run.model, askOnly: false, admissionExpiresAt: Date.now() + 60_000 }), 'admitted');
  const runtime = beginRunRecoveryRuntime(run, { instanceId: `owner-${name}` });
  assert.ok(runtime);
  const model = new MockLanguageModelV3({ doStream: { warnings: [], stream: new ReadableStream({ start(controller) { controller.enqueue(finish('stop')); controller.close(); } }) } });
  const input: ServerApiTurnInput = {
    run, messages, instructions: 'Fixture editor instructions.', model, provider: 'deepseek', apiMode: 'chat', cacheMode: 'short',
    contextWindowTokens: 128_000, contextWindowEstimated: false, maxInputTokens: 100_000, maxOutputTokens: 1_024,
    signal: new AbortController().signal, requestIndex: 1, recovery: runtime.sink,
    activation: { current: new ToolActivation(schemas, messages, schemas.map((schema) => schema.name)), tail: Promise.resolve(), followupText: null, toolFailures: new ToolFailureTracker(), acceptance: createAcceptanceLoop(false, 3) },
  };
  return { run, key, input, runtime };
}

async function published(run: ServerRun, callId: string) {
  for (let attempt = 0; attempt < 200 && !run.toolRequests.has(callId); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 1));
  const request = run.toolRequests.get(callId);
  assert.ok(request, `${callId} was published`);
  return request;
}
async function browser(run: ServerRun, callId: string, result: unknown, error?: string) {
  const request = await published(run, callId);
  const binding = { toolCallId: callId, argsDigest: request.argsDigest, claimId: `claim-${callId}` };
  assert.equal(claimRunRecoveryTool(run, binding), 'claimed');
  assert.equal(claimToolRequest(run, binding), 'claimed');
  assert.equal(settleToolResult(run, { ...binding, ...(error === undefined ? { result } : { error }) }), 'accepted');
}
function modelStream(parts: LanguageModelV3StreamPart[]) {
  return new MockLanguageModelV3({ doStream: { warnings: [], stream: new ReadableStream({ start(controller) { for (const part of parts) controller.enqueue(part); controller.close(); } }) } });
}

try {
  // A half-round replays its valid structured input, preserving multimodal and
  // signed reasoning metadata. Confirmed results stay in the dispatch ledger.
  {
    const messages: ModelMessage[] = [
      { role: 'user', content: 'Inspect first.' },
      { role: 'assistant', content: [
        { type: 'reasoning', text: 'Prior reasoning.', providerOptions: { fixture: { signature: 'prior-signature' } } },
        { type: 'tool-call', toolCallId: 'prior-call', toolName: 'read_timeline', input: {} },
      ] },
      { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'prior-call', toolName: 'read_timeline', output: { type: 'text', value: '{"items":[]}' } }] },
      { role: 'user', content: [{ type: 'text', text: 'Trim clip-7.' }, { type: 'file', data: 'aGVsbG8=', mediaType: 'image/png' }] },
    ];
    const { run, key, input } = await scenario('structured-retry', messages);
    const firstModel = modelStream([call('B'), finish()]);
    const first = executeServerApiTurn({ ...input, model: firstModel });
    await browser(run, 'api-1:B', { applied: true, revision: 12 });
    await first;
    // Simulate a process exit after the SDK round returned but before the
    // outer executor committed its next-request checkpoint.
    const record = store.load(key)!;
    assert.deepEqual(record.messages, messages);
    assert.equal(record.requestOptions?.maxOutputTokens, 1_024);
    const replay = modelStream([call('B-new'), finish()]);
    const outcome = await executeServerApiTurn({
      ...input, model: replay, maxOutputTokens: 8_000,
      resumeFrom: { requestIndex: 1, prompt: record.prompt!, messages: record.messages!, instructions: record.instructions!, toolNames: record.toolNames!, requestOptions: record.requestOptions ?? undefined, throughOpSeq: record.nextOpSeq - 1, completedTools: record.tools.map((tool) => ({ ...tool, success: tool.success ?? false, result: tool.result })) },
    });
    assert.equal(run.toolRequests.has('api-1:B-new'), false, 'confirmed edit is reused under a new SDK call id');
    assert.equal(store.load(key)!.tools.length, 1);
    assert.deepEqual(replay.doStreamCalls[0]!.prompt, firstModel.doStreamCalls[0]!.prompt, 'provider sees the same valid message structure without fabricated tool pairs');
    assert.equal(replay.doStreamCalls[0]!.maxOutputTokens, 1_024);
    assert.deepEqual(outcome.messages.slice(0, messages.length), messages);
    assert.equal(outcome.continued, true);
    assert.ok(outcome.messages.some((message) => message.role === 'tool'), 'complete SDK response messages remain structured');
    const changed = modelStream([call('B-changed', 'edit_item', { updates: [{ type: 'video', itemId: 'clip-7', durationInFrames: 121 }] }), finish()]);
    await assert.rejects(executeServerApiTurn({
      ...input, model: changed,
      resumeFrom: { requestIndex: 1, prompt: '', messages: record.messages!, toolNames: record.toolNames!, throughOpSeq: record.nextOpSeq - 1, completedTools: record.tools.map((tool) => ({ ...tool, success: tool.success ?? false, result: tool.result })) },
    }), /different write/);
    assert.equal(run.toolRequests.has('api-1:B-changed'), false, 'a changed-argument replay cannot apply another edit');
    assert.equal(store.load(key)!.tools.length, 1);
    await assert.rejects(executeServerApiTurn({
      ...input, model: modelStream([finish('stop')]),
      resumeFrom: { requestIndex: 1, prompt: '', messages: record.messages!, toolNames: record.toolNames!,
        completedTools: record.tools.map((tool) => ({ ...tool, success: tool.success ?? false, result: tool.result })) },
    }), /omitted a confirmed edit/);
    store.completeRequest(key, {
      epoch: store.load(key)!.ownerEpoch,
      nextRequestIndex: 2, messages: outcome.messages,
      executionState: { activeToolNames: schemas.map((schema) => schema.name), acceptance: input.activation.acceptance },
    });
    const nextArgs = { updates: [{ type: 'video', itemId: 'clip-7', durationInFrames: 121 }] };
    const next = executeServerApiTurn({ ...input, requestIndex: 2, messages: outcome.messages, model: modelStream([call('B', 'edit_item', nextArgs), finish()]) });
    await browser(run, 'api-2:B', { applied: true, revision: 13 });
    await next;
    assert.equal(store.load(key)!.tools.length, 2, 'a normal subsequent round may perform an explicitly new edit');

  }

  // A partial multi-tool round may leave a read intent and a completed write
  // in either dispatch order. Replay reuses B and executes a fresh C read.
  {
    const { run, key, input, runtime } = await scenario('parallel-partial');
    await runtime.sink.beginRequest({ requestIndex: 1, prompt: '', messages: input.messages, toolNames: schemas.map((schema) => schema.name), instructions: input.instructions, requestOptions: { maxOutputTokens: 1_024 } });
    await runtime.sink.beginTool({ toolCallId: 'api-1:C-old', name: 'read_timeline', argsDigest: digestToolArgs({}), args: {} });
    const edit = await runtime.sink.beginTool({ toolCallId: 'api-1:B-old', name: 'edit_item', argsDigest: digestToolArgs(editArgs), args: editArgs });
    assert.equal(claimRunRecoveryTool(run, { toolCallId: 'api-1:B-old', argsDigest: digestToolArgs(editArgs), claimId: 'old-claim' }), 'claimed');
    await runtime.sink.finishTool({ opSeq: edit.opSeq, toolCallId: 'api-1:B-old', name: 'edit_item', argsDigest: digestToolArgs(editArgs), success: true, result: { applied: true, activatedTools: [] } });
    const record = store.load(key)!;
    const pending = executeServerApiTurn({ ...input, model: modelStream([call('B-new'), call('C-new', 'read_timeline', {}), finish()]),
      resumeFrom: { requestIndex: 1, prompt: '', messages: record.messages!, toolNames: record.toolNames!, throughOpSeq: record.nextOpSeq - 1, completedTools: record.tools.filter((tool) => tool.state === 'outcome').map((tool) => ({ ...tool, success: tool.success ?? false, result: tool.result })) },
    });
    await browser(run, 'api-1:C-new', [{ id: 'clip-7' }]);
    const outcome = await pending;
    assert.equal(outcome.continued, true);
    assert.equal(run.toolRequests.has('api-1:B-new'), false);
    assert.equal(store.load(key)!.tools.find((tool) => tool.toolCallId === 'api-1:C-new')!.state, 'outcome');
  }

  // SDK business errors and local cache results both settle durable outcomes.
  {
    const { run, key, input } = await scenario('ordinary-failure');
    const pending = executeServerApiTurn({ ...input, model: modelStream([call('failed', 'read_timeline', {}), finish()]) });
    await browser(run, 'api-1:failed', null, 'fixture browser denial');
    const outcome = await pending;
    assert.equal(store.load(key)!.tools[0]!.state, 'outcome');
    assert.equal(store.load(key)!.tools[0]!.success, false);
    assert.equal(outcome.continued, true);
    const record = store.load(key)!;
    const replay = await executeServerApiTurn({ ...input, model: modelStream([call('failed', 'read_timeline', {}), finish()]),
      resumeFrom: { requestIndex: 1, prompt: '', messages: record.messages!, toolNames: record.toolNames!,
        completedTools: record.tools.map((tool) => ({ ...tool, success: tool.success ?? false, result: tool.result })) } });
    assert.match(JSON.stringify(replay.messages.at(-1)), /fixture browser denial/);
    assert.equal(run.events.filter((event) => event.type === 'tool-request').length, 1, 'reused read ID returns its recorded outcome');
    const cacheInput = { ...input, requestIndex: 2, model: modelStream([call('cached', 'analyze_music', {}), finish()]) };
    cacheInput.activation.lastSuccessfulPureTool = { name: 'analyze_music', argsDigest: digestToolArgs({}), result: { bpm: 120 } };
    await executeServerApiTurn(cacheInput);
    assert.equal(run.toolRequests.has('api-2:cached'), false);
    assert.equal(store.load(key)!.tools[1]!.state, 'outcome');
    assert.equal(store.load(key)!.tools[1]!.claimId, undefined);
  }

  // A fatal outcome failure aborts SDK consumption and seals queued callbacks.
  {
    const { run, key, input, runtime } = await scenario('fatal-queue');
    let providerOptions: LanguageModelV3CallOptions | undefined;
    const model = new MockLanguageModelV3({ doStream: async (options) => {
      providerOptions = options;
      return { warnings: [], stream: new ReadableStream({ start(controller) { controller.enqueue(call('first')); controller.enqueue(call('queued')); controller.enqueue(finish()); controller.close(); } }) };
    } });
    const pending = executeServerApiTurn({ ...input, model, recovery: { ...runtime.sink, finishTool: async () => { throw new Error('fixture outcome disk failure'); } } });
    const rejection = assert.rejects(pending, isRunRecoveryFault);
    await browser(run, 'api-1:first', { applied: true });
    await rejection;
    assert.equal(providerOptions!.abortSignal!.aborted, true);
    assert.equal(run.toolRequests.has('api-1:queued'), false);
    assert.equal(store.load(key)!.tools.length, 1);
  }

  // An aborted API request with a claimed write keeps its outcome unknown.
  {
    const { run, key, input } = await scenario('unknown-result');
    const controller = new AbortController();
    const model = modelStream([call('unknown'), finish()]);
    const pending = executeServerApiTurn({ ...input, model, signal: controller.signal });
    const rejection = assert.rejects(pending, isRunRecoveryFault);
    const request = await published(run, 'api-1:unknown');
    const binding = { toolCallId: 'api-1:unknown', argsDigest: request.argsDigest, claimId: 'claim-unknown' };
    assert.equal(claimRunRecoveryTool(run, binding), 'claimed');
    assert.equal(claimToolRequest(run, binding), 'claimed');
    controller.abort(new TypeError('fixture disconnected'));
    await rejection;
    assert.equal(store.load(key)!.tools[0]!.state, 'claimed');
    assert.equal(request.status, 'cancelled');
    assert.equal(settleToolResult(run, { ...binding, result: { applied: true } }), 'run-settled');
  }
  // The next round must retain both visible tool failures and the adjacent
  // pure-tool cache that normally ends an identical analysis request.
  {
    const { run, key, input, runtime } = await scenario('round-state');
    await runtime.sink.beginRequest({ requestIndex: 1, prompt: '', instructions: input.instructions,
      messages: input.messages, toolNames: schemas.map((schema) => schema.name) });
    store.completeRequest(key, { epoch: runtime.epoch, nextRequestIndex: 2, messages: input.messages,
      executionState: { activeToolNames: schemas.map((schema) => schema.name), acceptance: input.activation.acceptance,
        toolFailures: [{ name: 'read_timeline', reason: 'fixture denial' }],
        lastSuccessfulPureTool: { name: 'analyze_music', argsDigest: digestToolArgs({}), result: { bpm: 120 } } } });
    const model = modelStream([call('again', 'analyze_music', {}), finish()]);
    await executeRun(run, { messages: [...input.messages], backend: 'api', provider: 'deepseek', model: run.model,
      openAiApiMode: 'chat', cacheMode: 'short', maxOutputTokens: 1_024, autonomousAcceptance: false,
      maxAcceptanceIterations: 3, origin: 'http://127.0.0.1', tools: schemas },
      { resume: store.load(key)!, createApiModel: () => model });
    assert.equal(run.status, 'completed');
    assert.equal(run.toolRequests.size, 0, 'the recovered adjacent analysis uses its saved result');
    assert.deepEqual(run.events.find((event) => event.type === 'tool-failures')?.data,
      { failures: [{ name: 'read_timeline', reason: 'fixture denial' }] });
  }

  // Keep the target's complete assistant/tool pairing when a provider cuts off
  // before the SDK grants a tool execution authority.
  {
    const { run, key, input } = await scenario('unexecuted-tool-cutoff');
    const outcome = await executeServerApiTurn({ ...input, model: modelStream([call('cut'), finish('length')]) });
    assert.equal(outcome.hitMaxTokens, true);
    assert.equal(run.toolRequests.size, 0, 'a cutoff call never reaches the browser');
    assert.equal(store.load(key)!.tools.length, 0, 'a cutoff has no dispatched tool intent');
    const reply = outcome.messages.find((message) => message.role === 'tool');
    assert(reply && reply.role === 'tool');
    assert(reply.content.some((part) => part.type === 'tool-result' && part.toolCallId === 'cut'
      && part.output.type === 'error-text'), 'the checkpoint retains an explicit unexecuted result');
  }

  // A durable terminal checkpoint repairs only transport state on resume.
  // It must not even construct a provider model, including the finish-written
  // crash window where replaying the answer would duplicate visible text.
  for (const finishAlreadyWritten of [false, true]) {
    const { run, key, input, runtime } = await scenario(`terminal-${finishAlreadyWritten}`);
    await runtime.sink.beginRequest({ requestIndex: 1, prompt: '', instructions: input.instructions, messages: input.messages, toolNames: schemas.map((schema) => schema.name), requestOptions: { maxOutputTokens: 1_024 } });
    store.completeRequest(key, {
      epoch: runtime.epoch, nextRequestIndex: 2,
      messages: [...input.messages, { role: 'assistant', content: 'Done.' }],
      executionState: { activeToolNames: schemas.map((schema) => schema.name), acceptance: input.activation.acceptance },
      completion: { status: 'completed', text: 'Done.' },
    });
    pushRunEvent(run, 'text-start', {});
    pushRunEvent(run, 'text-delta', { text: finishAlreadyWritten ? 'Done.' : 'Do' });
    if (finishAlreadyWritten) pushRunEvent(run, 'finish', { characterCount: 5, utf8Bytes: 5 });
    await flushRunPersistence(run);
    const saved = store.load(key)!;
    const admission: ServerRunInput = { messages: [...input.messages], backend: 'api', provider: 'deepseek', model: run.model, openAiApiMode: 'chat', cacheMode: 'short', maxOutputTokens: 1_024, autonomousAcceptance: false, maxAcceptanceIterations: 3, origin: 'http://127.0.0.1', tools: schemas, instructions: input.instructions };
    await executeRun(run, admission, {
      resume: saved,
      createApiModel: () => { assert.fail('terminal resume must not construct a provider model'); },
      executeApiTurn: async () => { assert.fail('terminal resume must not run the provider'); },
    });
    assert.equal(run.status, 'completed');
    assert.equal(run.events.filter((event) => event.type === 'finish').length, 1);
    assert.equal(run.events.filter((event) => event.type === 'text-delta').map((event) => (event.data as { text: string }).text).join(''), 'Done.');
  }
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(unhandled, []);
  console.log('api-turn.verify: structured SDK replay, signed/multimodal context, one edit, ordinary/local outcomes, fatal queue and unknown result protection passed');
} finally {
  process.off('unhandledRejection', onUnhandled);
  resetRunRecoveryRuntimeForTest();
  resetServerRunStoreForTest();
  resetRunRecoveryStoreForTest(null);
  delete process.env[RUN_RECOVERY_DB_ENV];
  rmSync(directory, { recursive: true, force: true });
}
