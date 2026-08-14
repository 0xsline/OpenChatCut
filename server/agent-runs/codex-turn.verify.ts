import assert from 'node:assert';
import type { ModelMessage } from 'ai';
import { claimToolRequest, createRunWithCapability, deliverToolResult, flushRunPersistence } from './store';
import { executeServerCodexTurn, type ServerCodexTurnDeps } from './codex-turn';
import { ToolActivation } from '../../src/agent/tool-activation';
import { TOOL_SCHEMAS } from '../../src/agent/tools';
import type { AgentToolSchema } from '../../src/agent/tool-schema';
import type { CodexTurnStreamEvent } from '../../shared/codex-agent';
import type { ServerRun } from './store-types';

const searchMediaSchema = TOOL_SCHEMAS.find((schema) => schema.name === 'search_media')!;

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
      await new Promise<void>((resolve) => {
        const timer = setInterval(() => {
          const request = run.toolRequests.get('call-1');
          if (request) {
            clearInterval(timer);
            const claimed = claimToolRequest(run, {
              toolCallId: 'call-1',
              argsDigest: request.argsDigest,
              claimId: 'verify-claim',
            });
            assert.equal(claimed, 'claimed', 'browser claim succeeds');
            assert.equal(
              deliverToolResult(run, 'call-1', { items: [{ name: 'a.mp4' }] }),
              true,
              'tool result delivery is accepted',
            );
            resolve();
          }
        }, 5);
      });
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
    assert.equal(outcome.continued, true, 'tool calls continue the run');
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
