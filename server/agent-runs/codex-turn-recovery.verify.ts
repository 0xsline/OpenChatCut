import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeServerCodexTurn, type ServerCodexTurnInput, type ServerCodexTurnDeps } from './codex-turn';
import { executeRun, type ServerRunInput } from './executor';
import { createAcceptanceLoop } from './acceptance-loop';
import { canonicalServerRunToolCatalog } from './tool-policy';
import { ToolActivation } from '../../src/agent/tool-activation';
import { ToolFailureTracker } from '../../src/agent/toolFailure';
import { createRunWithCapability, flushRunPersistence, prepareRunAdmission, resetServerRunStoreForTest, claimToolRequest, settleToolResult, type ServerRun } from './store';
import { RunRecoveryStore, RUN_RECOVERY_DB_ENV, resetRunRecoveryStoreForTest } from './run-recovery-store';
import { beginRunRecoveryRuntime, claimRunRecoveryTool, runRecoveryKeyOf, resetRunRecoveryRuntimeForTest } from './run-recovery-runtime';
import { isRunRecoveryFault } from './run-recovery-fault';
import type { CodexTurnStreamEvent } from '../../shared/codex-agent';

const scratch = mkdtempSync(join(tmpdir(), 'codex-recovery-turn-'));
process.env[RUN_RECOVERY_DB_ENV] = join(scratch, 'recovery.sqlite3');
const store = new RunRecoveryStore(process.env[RUN_RECOVERY_DB_ENV]);
resetRunRecoveryStoreForTest(store);
const schemas = canonicalServerRunToolCatalog(false).filter((schema) => ['edit_item', 'read_timeline', 'analyze_music'].includes(schema.name));
const editArgs = { updates: [{ type: 'video', itemId: 'clip-7', durationInFrames: 120 }] };
const unhandled: unknown[] = [];
const onUnhandled = (error: unknown) => { unhandled.push(error); };
process.on('unhandledRejection', onUnhandled);

async function scenario(name: string) {
  resetRunRecoveryRuntimeForTest();
  resetServerRunStoreForTest();
  const projectId = `codex-recovery-${name}`;
  const run = createRunWithCapability({ projectId, sessionGeneration: await prepareRunAdmission(projectId), backend: 'codex', provider: 'openai', model: 'codex-mini-latest' }).run;
  const key = runRecoveryKeyOf(run);
  assert.equal(store.prepareAdmission({ ...key, backend: 'codex', model: run.model, askOnly: false, admissionExpiresAt: Date.now() + 60_000 }), 'admitted');
  const runtime = beginRunRecoveryRuntime(run, { instanceId: `owner-${name}` });
  assert.ok(runtime);
  const input: ServerCodexTurnInput = {
    run, messages: [{ role: 'user', content: 'Trim clip-7 and inspect it.' }], instructions: 'Editor instructions.',
    schemas, model: run.model, askOnly: false, projectId, maxInputTokens: 100_000, maxOutputTokens: 1_000,
    contextWindowTokens: 128_000, contextWindowEstimated: false, signal: new AbortController().signal,
    activation: { current: new ToolActivation(schemas, [], schemas.map((schema) => schema.name)), tail: Promise.resolve(), followupText: null, toolFailures: new ToolFailureTracker(), acceptance: createAcceptanceLoop(false, 3) },
    requestIndex: 1, recovery: runtime.sink,
  };
  return { run, key, input, runtime };
}

async function browser(run: ServerRun, callId: string, result: unknown, error?: string) {
  callId = `codex-1:${callId}`;
  for (let attempt = 0; attempt < 100 && !run.toolRequests.has(callId); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 1));
  const request = run.toolRequests.get(callId);
  assert.ok(request, `browser request ${callId} was published`);
  const binding = { toolCallId: callId, argsDigest: request.argsDigest, claimId: `claim-${callId}` };
  assert.equal(claimRunRecoveryTool(run, binding), 'claimed');
  assert.equal(claimToolRequest(run, binding), 'claimed');
  assert.equal(settleToolResult(run, { ...binding, ...(error === undefined ? { result } : { error }) }), 'accepted');
}

function bridge() {
  const answers: Array<{ callId: string; success: boolean; result: unknown; requestId: string }> = [];
  const waiters = new Map<string, ReturnType<typeof Promise.withResolvers<void>>>();
  const settleToolResult: NonNullable<ServerCodexTurnDeps['settleToolResult']> = (body) => {
    answers.push(body);
    waiters.get(body.callId)?.resolve();
    return 'ok';
  };
  const wait = (callId: string) => {
    if (answers.some((answer) => answer.callId === callId)) return Promise.resolve();
    const pending = Promise.withResolvers<void>();
    waiters.set(callId, pending);
    return pending.promise;
  };
  return { answers, settleToolResult, wait };
}

try {
  // The real outer retry restarts Codex with the durable input and tool result.
  {
    const { run } = await scenario('provider-retry');
    const transport = bridge();
    const requestIds: string[] = [];
    let attempts = 0;
    let edits = 0;
    const input: ServerRunInput = { messages: [{ role: 'user', content: 'Trim clip-7.' }], backend: 'codex', provider: 'openai', model: run.model, openAiApiMode: 'chat', cacheMode: 'short', maxOutputTokens: 1_000, autonomousAcceptance: false, maxAcceptanceIterations: 3, origin: 'http://127.0.0.1', tools: schemas, instructions: 'Editor instructions.' };
    await executeRun(run, input, {
      executeCodexTurn: async (turn) => {
        attempts += 1;
        if (attempts === 2) assert.ok(turn.resumeFrom, 'retry rebuilds the interrupted request');
        return executeServerCodexTurn(turn, { timeoutMs: 500, settleToolResult: transport.settleToolResult, runTurn: async (request, emit) => {
          requestIds.push(request.requestId);
          if (attempts === 1) {
            emit({ type: 'tool-start', callId: 'B', name: 'edit_item', args: editArgs });
            await browser(run, 'B', { applied: true, revision: 12 });
            edits += 1;
            await transport.wait('B');
            throw new TypeError('fetch failed after applying B');
          }
          assert.equal(request.prompt.match(/"revision":12/g)?.length, 1);
          emit({ type: 'tool-start', callId: 'B-new', name: 'edit_item', args: editArgs });
          await transport.wait('B-new');
          emit({ type: 'text-delta', delta: 'Done.' });
          emit({ type: 'done' });
        } });
      },
    });
    assert.equal(attempts, 2);
    assert.equal(run.status, 'completed');
    assert.equal(edits, 1);
    assert.equal(run.toolRequests.has('B-new'), false);
    assert.notEqual(requestIds[0], requestIds[1], 'each temporary Codex thread has a distinct request id');
  }

  // Browser errors and cached local results preserve the outcome boundary.
  {
    const { run, key, input } = await scenario('business-and-cache');
    const transport = bridge();
    await executeServerCodexTurn(input, { timeoutMs: 500, settleToolResult: transport.settleToolResult, runTurn: async (_request, emit) => {
      emit({ type: 'tool-start', callId: 'music-first', name: 'analyze_music', args: {} });
      await browser(run, 'music-first', { bpm: 120 });
      await transport.wait('music-first');
      emit({ type: 'tool-start', callId: 'music-cached', name: 'analyze_music', args: {} });
      await transport.wait('music-cached');
      emit({ type: 'tool-start', callId: 'failure', name: 'read_timeline', args: {} });
      await browser(run, 'failure', null, 'fixture denied');
      await transport.wait('failure');
      emit({ type: 'done' });
    } });
    assert.deepEqual(store.load(key)!.tools.map((tool) => [tool.toolCallId.replace(/^codex-1:/, ''), tool.state, tool.success]), [['music-first', 'outcome', true], ['music-cached', 'outcome', true], ['failure', 'outcome', false]]);
    assert.equal(run.toolRequests.has('codex-1:music-cached'), false);
    assert.equal(transport.answers.find((answer) => answer.callId === 'failure')!.success, false);
  }

  // A failed outcome write aborts the model, blocks queued writes, and never
  // sends the recovery failure to Codex as an ordinary tool error.
  {
    const { run, input, runtime } = await scenario('fatal-write');
    const transport = bridge();
    let lateEmit: ((event: CodexTurnStreamEvent) => void) | undefined;
    let modelSignal: AbortSignal | undefined;
    await assert.rejects(executeServerCodexTurn({ ...input, recovery: { ...runtime.sink, finishTool: async () => { throw new Error('fixture disk failure'); } } }, {
      timeoutMs: 500, settleToolResult: transport.settleToolResult,
      runTurn: async (_request, emit, signal) => {
        lateEmit = emit;
        modelSignal = signal;
        emit({ type: 'tool-start', callId: 'fatal-B', name: 'edit_item', args: editArgs });
        emit({ type: 'tool-start', callId: 'queued-C', name: 'edit_item', args: editArgs });
        await browser(run, 'fatal-B', { applied: true });
        await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
      },
    }), isRunRecoveryFault);
    assert.equal(modelSignal?.aborted, true);
    assert.deepEqual(transport.answers, []);
    assert.equal(run.toolRequests.has('codex-1:queued-C'), false);
    await flushRunPersistence(run);
    const count = run.events.length;
    lateEmit?.({ type: 'tool-start', callId: 'late-D', name: 'edit_item', args: editArgs });
    lateEmit?.({ type: 'text-delta', delta: 'late text' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await flushRunPersistence(run);
    assert.equal(run.events.length, count);
    assert.equal(run.toolRequests.has('codex-1:late-D'), false);
  }

  // Deadlines and terminal events seal callback scopes even if a runner keeps
  // emitting. Outstanding browser work remains unresolved for reconciliation.
  for (const terminal of ['timeout', 'error', 'done', 'abort'] as const) {
    const { run, key, input } = await scenario(`terminal-${terminal}`);
    const transport = bridge();
    const controller = new AbortController();
    let lateEmit: ((event: CodexTurnStreamEvent) => void) | undefined;
    let signal: AbortSignal | undefined;
    const result = executeServerCodexTurn({ ...input, signal: controller.signal }, { timeoutMs: terminal === 'timeout' ? 25 : 1_000, settleToolResult: transport.settleToolResult, runTurn: async (_request, emit, modelSignal) => {
      lateEmit = emit;
      signal = modelSignal;
      if (terminal === 'timeout') return new Promise<void>(() => undefined);
      emit({ type: 'tool-start', callId: 'unfinished', name: 'edit_item', args: editArgs });
      for (let attempt = 0; attempt < 100 && !run.toolRequests.has('codex-1:unfinished'); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 1));
      const request = run.toolRequests.get('codex-1:unfinished')!;
      const binding = { toolCallId: 'codex-1:unfinished', argsDigest: request.argsDigest, claimId: 'unfinished-claim' };
      assert.equal(claimRunRecoveryTool(run, binding), 'claimed');
      assert.equal(claimToolRequest(run, binding), 'claimed');
      if (terminal === 'abort') controller.abort(new Error('fixture caller abort'));
      else if (terminal === 'error') emit({ type: 'error', message: 'fixture provider failure' });
      else emit({ type: 'done' });
    } });
    await assert.rejects(result, terminal === 'timeout' ? /timed out/ : isRunRecoveryFault);
    assert.equal(signal?.aborted, true);
    await flushRunPersistence(run);
    const count = run.events.length;
    lateEmit?.({ type: 'tool-start', callId: 'after-terminal', name: 'edit_item', args: editArgs });
    lateEmit?.({ type: 'done' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await flushRunPersistence(run);
    assert.equal(run.events.length, count);
    assert.equal(run.toolRequests.has('codex-1:after-terminal'), false);
    assert.deepEqual(transport.answers, []);
    if (terminal !== 'timeout') {
      assert.equal(store.load(key)!.tools[0]!.state, 'claimed');
      const request = run.toolRequests.get('codex-1:unfinished')!;
      assert.equal(request.status, 'cancelled');
      assert.equal(settleToolResult(run, { toolCallId: 'codex-1:unfinished', argsDigest: request.argsDigest, claimId: 'unfinished-claim', result: { applied: true } }), 'run-settled', 'late browser evidence cannot revive the closed RPC');
    }
  }
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(unhandled, [], 'closed/aborted callbacks produce no unhandled rejections');
  console.log('codex-turn-recovery.verify: durable retry, one edit, cache/failure outcomes, fatal queue freeze, timeout/error/done/abort closure and late callbacks passed');
} finally {
  process.off('unhandledRejection', onUnhandled);
  resetRunRecoveryRuntimeForTest();
  resetServerRunStoreForTest();
  resetRunRecoveryStoreForTest(null);
  delete process.env[RUN_RECOVERY_DB_ENV];
  rmSync(scratch, { recursive: true, force: true });
}
