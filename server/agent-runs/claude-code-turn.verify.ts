import assert from 'node:assert';
import type { ModelMessage } from 'ai';
import { createRunWithCapability, flushRunPersistence } from './store';
import { executeServerClaudeCodeTurn, type ServerClaudeCodeTurnDeps } from './claude-code-turn';
import { ToolActivation } from '../../src/agent/tool-activation';
import { TOOL_SCHEMAS } from '../../src/agent/tools';
import type { AgentToolSchema } from '../../src/agent/tool-schema';
import type { ClaudeCodeTurnStreamEvent } from '../../shared/claude-code-agent';
import type { ServerRun } from './store-types';
import { ToolFailureTracker } from '../../src/agent/toolFailure';
import { createAcceptanceLoop } from './acceptance-loop';

const searchMediaSchema = TOOL_SCHEMAS.find((schema) => schema.name === 'search_media')!;

function makeRun(): ServerRun {
  return createRunWithCapability({
    projectId: 'claude-code-verify-project',
    sessionGeneration: 'gen-1',
    backend: 'claude-code',
    provider: 'anthropic',
    model: 'sonnet',
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
    model: 'sonnet',
    askOnly: false,
    projectId: 'claude-code-verify-project',
    maxInputTokens: 1_000_000,
    maxOutputTokens: 32_768,
    contextWindowTokens: 1_000_000,
    contextWindowEstimated: false,
    signal: new AbortController().signal,
    activation,
    requestIndex: 1,
  };
}

function sequence(events: readonly ClaudeCodeTurnStreamEvent[]): ServerClaudeCodeTurnDeps {
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
    { type: 'session', sessionId: 'sess-1' },
    { type: 'text-delta', delta: 'I found ' },
    { type: 'thinking-delta', delta: 'checking clip boundaries' },
    { type: 'text-delta', delta: 'the clips.' },
    { type: 'done' },
  ]);
  const outcome = await executeServerClaudeCodeTurn(input, deps);
  assert.equal(outcome.text, 'I found the clips.', 'text is collected across deltas');
  assert.equal(outcome.continued, false, 'no tool calls means no continuation');
  assert.deepEqual(
    outcome.messages.map((message) => message.role),
    ['user', 'assistant'],
    'messages rebuild as user + assistant text',
  );
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
  assert.equal(thinking, 'checking clip boundaries', 'claude code thinking-delta reaches run events');
}

// ── Tool turn: tool-start/tool-end are display events only, no browser bridge ─
{
  const run = makeRun();
  const input = makeInput(run);
  const deps: ServerClaudeCodeTurnDeps = {
    runTurn: async (_request, emit) => {
      emit({ type: 'text-delta', delta: 'Checking the pool.' });
      emit({
        type: 'tool-start',
        callId: 'call-1',
        name: 'mcp__openchatcut__search_media',
        args: { query: 'clips' },
      });
      // Unlike Codex, Claude Code's own MCP client executes the call itself —
      // OpenChatCut never claims/settles it; the tool-end just arrives.
      emit({
        type: 'tool-end',
        callId: 'call-1',
        name: 'mcp__openchatcut__search_media',
        args: { query: 'clips' },
        result: { items: [{ name: 'a.mp4' }] },
        success: true,
      });
      emit({ type: 'text-delta', delta: ' Done.' });
      emit({ type: 'done' });
    },
  };
  const outcome = await executeServerClaudeCodeTurn(input, deps);
  assert.equal(outcome.text, 'Checking the pool. Done.', 'text spans the tool call');
  assert.equal(outcome.continued, false);
  await flushRunPersistence(run);
  // A 'tool-request' event asks the BROWSER to execute a tool and settle it
  // back; the client answers it by claiming the call via /tool-claim. Claude
  // Code runs its tool calls inside its own MCP client, so nothing is
  // registered server-side to claim: emitting this would 404 the claim and
  // leave an unresolved tool-request that store-recovery.ts retries on every
  // reload. This backend must stay display-only.
  const request = run.events.find((event) => event.type === 'tool-request');
  assert.equal(request, undefined, 'claude-code must never ask the browser to execute a tool');
  const result = run.events.find((event) => event.type === 'tool-result');
  assert.ok(result, 'tool-end is surfaced as a display tool-result event');
  const resultData = result!.data as { toolCallId: string; toolName: string; result?: unknown };
  assert.equal(resultData.toolCallId, 'call-1');
  assert.equal(resultData.toolName, 'mcp__openchatcut__search_media');
  assert.deepEqual(resultData.result, { items: [{ name: 'a.mp4' }] });
  const histories = outcome.messages.filter((message) =>
    typeof message.content === 'string'
    && String(message.content).includes('[tool call: mcp__openchatcut__search_media]'));
  assert.equal(histories.length, 1, 'merged tool history entry is rebuilt for conversation continuity');
}

// ── Failed tool-end is recorded as a display error, not a thrown failure ──────
{
  const run = makeRun();
  const input = makeInput(run);
  const deps = sequence([
    { type: 'tool-start', callId: 'call-2', name: 'mcp__openchatcut__search_media', args: { query: 'missing' } },
    {
      type: 'tool-end', callId: 'call-2', name: 'mcp__openchatcut__search_media',
      args: { query: 'missing' }, result: 'media is unavailable', success: false,
    },
    { type: 'done' },
  ]);
  const outcome = await executeServerClaudeCodeTurn(input, deps);
  await flushRunPersistence(run);
  const result = run.events.find((event) => event.type === 'tool-result');
  const resultData = result!.data as { error?: string };
  assert.equal(resultData.error, 'Claude Code tool call failed.');
  assert.ok(outcome.messages.some((message) => String(message.content).includes('success=false')),
    'failure is persisted in the tool history');
}

// ── Error event fails the turn ────────────────────────────────────────────────
{
  const run = makeRun();
  const input = makeInput(run);
  const deps = sequence([{ type: 'error', message: 'usage limit exceeded' }]);
  await assert.rejects(
    executeServerClaudeCodeTurn(input, deps),
    /usage limit exceeded/,
    'a claude code error event fails the turn',
  );
}

// ── Missing terminal event fails the turn ─────────────────────────────────────
{
  const run = makeRun();
  const input = makeInput(run);
  const deps = sequence([{ type: 'text-delta', delta: 'half' }]);
  await assert.rejects(
    executeServerClaudeCodeTurn(input, deps),
    /without a terminal event/,
    'a turn that never emits done fails',
  );
}

console.log('server agent claude-code turn verification passed');
