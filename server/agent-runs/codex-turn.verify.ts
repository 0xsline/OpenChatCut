import assert from 'node:assert';
import type { ModelMessage } from 'ai';
import {
  claimToolRequest,
  createRunWithCapability,
  deliverToolResult,
  digestToolArgs,
  flushRunPersistence,
} from './store';
import { executeServerCodexTurn, type ServerCodexTurnDeps } from './codex-turn';
import type { ActivationState } from './executor';
import { ToolActivation } from '../../src/agent/tool-activation';
import { TOOL_SCHEMAS } from '../../src/agent/tools';
import type { AgentToolSchema } from '../../src/agent/tool-schema';
import type { CodexTurnStreamEvent } from '../../shared/codex-agent';
import type { ServerRun } from './store-types';
import { ToolFailureTracker } from '../../src/agent/toolFailure';
import { createAcceptanceLoop } from './acceptance-loop';

const searchMediaSchema = TOOL_SCHEMAS.find((schema) => schema.name === 'search_media')!;
const analyzeMusicSchema = TOOL_SCHEMAS.find((schema) => schema.name === 'analyze_music')!;

function makeRun(): ServerRun {
  return createRunWithCapability({
    projectId: 'codex-verify-project',
    sessionGeneration: 'gen-1',
    backend: 'codex',
    provider: 'openai',
    model: 'codex-mini-latest',
  }).run;
}

function makeInput(run: ServerRun) {
  const activation = {
    current: new ToolActivation(TOOL_SCHEMAS, [], [searchMediaSchema.name]),
    tail: Promise.resolve(),
    followupText: null,
    toolFailures: new ToolFailureTracker(),
    acceptance: createAcceptanceLoop(false, 3),
  };
  const messages: ModelMessage[] = [{ role: 'user', content: 'Find media.' }];
  return {
    run,
    messages,
    instructions: 'You are a video editor agent.',
    schemas: [searchMediaSchema] as readonly AgentToolSchema[],
    model: 'codex-mini-latest',
    askOnly: false,
    projectId: 'codex-verify-project',
    maxInputTokens: 1_000_000,
    maxOutputTokens: 32_768,
    contextWindowTokens: 1_000_000,
    contextWindowEstimated: false,
    signal: new AbortController().signal,
    activation,
    requestIndex: 1,
  };
}

async function deliverWhenRequested(
  run: ServerRun,
  callId: string,
  result: unknown,
): Promise<void> {
  await new Promise<void>((resolve) => {
    const timer = setInterval(() => {
      const request = run.toolRequests.get(callId);
      if (!request) return;
      clearInterval(timer);
      assert.equal(claimToolRequest(run, {
        toolCallId: callId,
        argsDigest: request.argsDigest,
        claimId: `verify-claim-${callId}`,
      }), 'claimed', 'browser claim succeeds');
      assert.equal(deliverToolResult(run, callId, result), true, 'tool result delivery is accepted');
      resolve();
    }, 5);
  });
}

function sequence(events: readonly CodexTurnStreamEvent[]): ServerCodexTurnDeps {
  return {
    runTurn: async (_request, emit) => {
      for (const event of events) emit(event);
    },
  };
}

// ── Text-only turn ────────────────────────────────────────────────────────────
{
  const run = makeRun();
  const input = makeInput(run);
  const deps = sequence([
    { type: 'text-delta', delta: 'I found ' },
    { type: 'thinking-delta', delta: 'checking clip boundaries' },
    { type: 'text-delta', delta: 'the clips.' },
    { type: 'done' },
  ]);
  const outcome = await executeServerCodexTurn(input, deps);
  assert.equal(outcome.text, 'I found the clips.', 'text is collected across deltas');
  assert.equal(outcome.continued, false, 'no tool calls means no continuation');
  assert.deepEqual(
    outcome.messages.map((message) => message.role),
    ['user', 'assistant'],
    'messages rebuild as user + assistant text',
  );
  const assistant = outcome.messages.at(-1)!;
  assert.equal(typeof assistant.content, 'string');
  assert.equal(assistant.content, 'I found the clips.');
  await flushRunPersistence(run);
  const textEnd = run.events.find((event) => event.type === 'text-end');
  assert.ok(textEnd, 'text-end event is pushed');
  const thinking = run.events
    .filter((event) => event.type === 'thinking-delta')
    .map((event) => {
      const data = event.data;
      return data && typeof data === 'object' && 'text' in data && typeof data.text === 'string'
        ? data.text
        : '';
    })
    .join('');
  assert.equal(thinking, 'checking clip boundaries', 'codex thinking-delta reaches run events');
}

// ── Tool turn: tool-start bridges to the browser and settles back ─────────────
{
  const run = makeRun();
  const input = makeInput(run);
  let settled: Array<{ callId: string; success: boolean }> = [];
  const deps: ServerCodexTurnDeps = {
    runTurn: async (_request, emit) => {
      emit({ type: 'text-delta', delta: 'Checking the pool.' });
      emit({
        type: 'tool-start',
        callId: 'call-1',
        name: searchMediaSchema.name,
        args: { query: 'clips' },
      });
      // Browser claims and settles the tool result; the turn continues after it.
      await deliverWhenRequested(run, 'call-1', { items: [{ name: 'a.mp4' }] });
      await new Promise((resolve) => setTimeout(resolve, 20));
      emit({ type: 'text-delta', delta: ' Done.' });
      emit({ type: 'done' });
    },
  };
  // Patch the real turn manager settle so we can observe the settlement shape
  // without an active session (it returns unknown-request for missing sessions).
  const turnManagerModule = await import('../codex/turn-manager');
  const originalSettle = turnManagerModule.codexTurnManager.settleToolResult.bind(
    turnManagerModule.codexTurnManager,
  );
  turnManagerModule.codexTurnManager.settleToolResult = ((body: {
    requestId: string;
    callId: string;
    success: boolean;
    result: unknown;
  }) => {
    settled.push({ callId: body.callId, success: body.success });
    return originalSettle(body as never);
  }) as typeof turnManagerModule.codexTurnManager.settleToolResult;
  try {
    const outcome = await executeServerCodexTurn(input, deps);
    assert.equal(outcome.text, 'Checking the pool. Done.', 'text spans the tool call');
    assert.equal(outcome.continued, false,
      'Codex already resumes after the settled tool and must not replay the completed turn');
    assert.equal(settled.length, 1, 'tool result is settled back into the codex turn');
    assert.equal(settled[0]!.callId, 'call-1');
    assert.equal(settled[0]!.success, true);
    const histories = outcome.messages.filter((message) =>
      typeof message.content === 'string'
      && String(message.content).includes('[tool call: search_media]'));
    assert.equal(histories.length, 1, 'merged tool history entry is rebuilt');
  } finally {
    turnManagerModule.codexTurnManager.settleToolResult = originalSettle;
  }
}

// ── Delayed canonical tool remains registered with Codex ────────────────────
{
  const run = makeRun();
  const input = makeInput(run);
  assert.ok(!input.activation.current.schemas().some((schema) => schema.name === analyzeMusicSchema.name),
    'the delayed tool starts inactive for prompt-token routing');
  let registered = false;
  let settled = false;
  const deps: ServerCodexTurnDeps = {
    runTurn: async (request, emit) => {
      registered = request.tools.some((tool) => tool.name === analyzeMusicSchema.name);
      emit({
        type: 'tool-start',
        callId: 'delayed-call',
        name: analyzeMusicSchema.name,
        args: { assetId: 'asset-1' },
      });
      await deliverWhenRequested(run, 'delayed-call', { bpm: 120 });
      await new Promise((resolve) => setTimeout(resolve, 20));
      emit({ type: 'done' });
    },
  };
  const turnManagerModule = await import('../codex/turn-manager');
  const originalSettle = turnManagerModule.codexTurnManager.settleToolResult.bind(
    turnManagerModule.codexTurnManager,
  );
  turnManagerModule.codexTurnManager.settleToolResult = ((body: { success: boolean }) => {
    settled = body.success;
    return originalSettle(body as never);
  }) as typeof turnManagerModule.codexTurnManager.settleToolResult;
  try {
    const outcome = await executeServerCodexTurn(input, deps);
    assert.equal(registered, true, 'Codex receives the full canonical tool catalog');
    assert.equal(settled, true, 'the delayed call remains admitted through the browser bridge');
    assert.ok(outcome.messages.some((message) => String(message.content).includes(analyzeMusicSchema.name)),
      'the delayed call is preserved in the tool history');
  } finally {
    turnManagerModule.codexTurnManager.settleToolResult = originalSettle;
  }
}

// ── Adjacent pure-tool replay ends the server loop without browser work ──────
{
  const run = makeRun();
  const input = makeInput(run);
  const activation: ActivationState = input.activation;
  const args = { assetId: 'asset-cached' };
  activation.lastSuccessfulPureTool = {
    name: analyzeMusicSchema.name,
    argsDigest: digestToolArgs(args),
    result: { bpm: 120, activatedTools: [] },
  };
  const deps: ServerCodexTurnDeps = {
    runTurn: async (_request, emit) => {
      emit({ type: 'tool-start', callId: 'cached-call', name: analyzeMusicSchema.name, args });
      await new Promise((resolve) => setTimeout(resolve, 20));
      emit({ type: 'done' });
    },
  };
  const outcome = await executeServerCodexTurn(input, deps);
  assert.equal(run.events.some((event) => event.type === 'tool-request'), false,
    'cached analyze_music replay does not request browser execution');
  assert.equal(outcome.continued, false,
    'cached replay ends the outer server turn loop');
  assert.match(activation.repeatGuardNote ?? '', /skipped duplicate browser execution/);
}

// ── Unknown tools remain rejected by the canonical host boundary ─────────────
{
  const run = makeRun();
  const input = makeInput(run);
  const outcome = await executeServerCodexTurn(input, sequence([
    { type: 'tool-start', callId: 'unknown-call', name: 'unknown_editor_tool', args: {} },
    { type: 'done' },
  ]));
  assert.equal(run.events.some((event) => event.type === 'tool-request'), false,
    'an unknown host tool never reaches the browser bridge');
  assert.equal(outcome.continued, false,
    'a terminal Codex turn is not replayed after rejecting an unknown tool');
  assert.equal(input.activation.toolFailures.hasUnresolved, true,
    'an unknown host tool blocks false completion');
}

// ── Business failure result settles Codex on its error channel ───────────────
{
  const run = makeRun();
  const input = makeInput(run);
  let settled: boolean | null = null;
  const deps: ServerCodexTurnDeps = {
    runTurn: async (_request, emit) => {
      emit({
        type: 'tool-start',
        callId: 'failed-call',
        name: searchMediaSchema.name,
        args: { query: 'missing clips' },
      });
      await deliverWhenRequested(run, 'failed-call', { ok: false, error: 'media is unavailable' });
      await new Promise((resolve) => setTimeout(resolve, 20));
      emit({ type: 'done' });
    },
  };
  const turnManagerModule = await import('../codex/turn-manager');
  const originalSettle = turnManagerModule.codexTurnManager.settleToolResult.bind(
    turnManagerModule.codexTurnManager,
  );
  turnManagerModule.codexTurnManager.settleToolResult = ((body: { success: boolean }) => {
    settled = body.success;
    return originalSettle(body as never);
  }) as typeof turnManagerModule.codexTurnManager.settleToolResult;
  try {
    const outcome = await executeServerCodexTurn(input, deps);
    assert.equal(settled, false, 'business failure is settled as an error');
    assert.equal(input.activation.toolFailures.hasUnresolved, true,
      'the failed Codex tool blocks completion until a same-tool retry succeeds');
    assert.ok(outcome.messages.some((message) => String(message.content).includes('success=false')),
      'failure is persisted in the Codex tool history');
  } finally {
    turnManagerModule.codexTurnManager.settleToolResult = originalSettle;
  }
}

// ── Error event fails the turn ────────────────────────────────────────────────
{
  const run = makeRun();
  const input = makeInput(run);
  const deps = sequence([{ type: 'error', message: 'usage limit exceeded' }]);
  await assert.rejects(
    executeServerCodexTurn(input, deps),
    /usage limit exceeded/,
    'a codex error event fails the turn',
  );
}

// ── Missing terminal event fails the turn ─────────────────────────────────────
{
  const run = makeRun();
  const input = makeInput(run);
  const deps = sequence([{ type: 'text-delta', delta: 'half' }]);
  await assert.rejects(
    executeServerCodexTurn(input, deps),
    /without a terminal event/,
    'a turn that never emits done fails',
  );
}

console.log('server agent codex turn verification passed');
