import assert from 'node:assert';
import type { ModelMessage } from 'ai';
import { createRunWithCapability, flushRunPersistence } from './store';
import { executeServerClaudeCodeTurn, type ServerClaudeCodeTurnDeps } from './claude-code-turn';
import { ToolActivation } from '../../src/agent/tool-activation';
import { TOOL_SCHEMAS } from '../../src/agent/tools';
import type { AgentToolSchema } from '../../src/agent/tool-schema';
import type { ClaudeCodeTurnRequest, ClaudeCodeTurnStreamEvent } from '../../shared/claude-code-agent';
import { resetClaudeCodeSessionsForTest } from '../claude-code/resume-store';
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

// ── Session resume across runs ────────────────────────────────────────────────
// Every Claude Code turn is a fresh `claude -p` subprocess, so without a
// remembered session id each follow-up message re-boots the CLI, re-runs the
// MCP handshake, and re-sends the whole conversation as a new prompt. These
// guard that the second message resumes instead.
{
  resetClaudeCodeSessionsForTest();
  const requests: ClaudeCodeTurnRequest[] = [];
  const recording = (events: readonly ClaudeCodeTurnStreamEvent[]): ServerClaudeCodeTurnDeps => ({
    runTurn: async (request, emit) => {
      requests.push(request);
      for (const event of events) emit(event);
    },
  });
  const reply = (sessionId: string): readonly ClaudeCodeTurnStreamEvent[] => [
    { type: 'session', sessionId },
    { type: 'text-delta', delta: 'done' },
    { type: 'done' },
  ];

  const first = makeInput(makeRun());
  await executeServerClaudeCodeTurn(first, recording(reply('sess-a')));
  assert.equal(requests[0].sessionId, undefined, 'the first message of a chat cold-starts');
  assert.match(requests[0].prompt, /Find media\./, 'a cold start sends the serialized history');

  const second = makeInput(makeRun());
  second.messages = [
    { role: 'user', content: 'Find media.' },
    { role: 'assistant', content: 'done' },
    { role: 'user', content: 'Now trim it.' },
  ];
  await executeServerClaudeCodeTurn(second, recording(reply('sess-a')));
  assert.equal(requests[1].sessionId, 'sess-a', 'a follow-up in the same chat resumes the CLI session');
  assert.equal(requests[1].prompt, 'USER:\nNow trim it.',
    'a resumed turn sends only the new message, never the history the CLI already holds');

  // A different model is a different transcript, and a rotated generation means
  // the chat was cleared or rewound. Neither may resume the old session.
  const otherModel = makeInput(makeRun());
  otherModel.model = 'opus';
  await executeServerClaudeCodeTurn(otherModel, recording(reply('sess-b')));
  assert.equal(requests[2].sessionId, undefined, 'switching model starts a fresh session');

  const rotated = makeInput(createRunWithCapability({
    projectId: 'claude-code-verify-project',
    sessionGeneration: 'gen-2',
    backend: 'claude-code',
    provider: 'anthropic',
    model: 'sonnet',
  }).run);
  await executeServerClaudeCodeTurn(rotated, recording(reply('sess-c')));
  assert.equal(requests[3].sessionId, undefined, 'a rotated session generation starts a fresh session');
}

// ── A session the CLI cannot load falls back to a cold start ──────────────────
{
  resetClaudeCodeSessionsForTest();
  const requests: ClaudeCodeTurnRequest[] = [];
  const seed = makeInput(makeRun());
  await executeServerClaudeCodeTurn(seed, {
    runTurn: async (request, emit) => {
      requests.push(request);
      emit({ type: 'session', sessionId: 'sess-gone' });
      emit({ type: 'done' });
    },
  });
  assert.equal(requests[0].sessionId, undefined, 'the seeding turn cold-starts');

  const resumed = makeInput(makeRun());
  resumed.messages = [
    { role: 'user', content: 'Find media.' },
    { role: 'user', content: 'Now trim it.' },
  ];
  const outcome = await executeServerClaudeCodeTurn(resumed, {
    // First call: the stale id fails before producing anything, exactly as a
    // CLI that cannot load the transcript does. Second call must be the cold
    // start, and the user must never see the resume failure.
    runTurn: async (request, emit) => {
      requests.push(request);
      if (request.sessionId) {
        emit({ type: 'error', message: 'No conversation found with session ID sess-gone' });
        return;
      }
      emit({ type: 'session', sessionId: 'sess-fresh' });
      emit({ type: 'text-delta', delta: 'trimmed' });
      emit({ type: 'done' });
    },
  });
  assert.equal(requests[1].sessionId, 'sess-gone', 'the follow-up tries the remembered session first');
  assert.equal(requests[2].sessionId, undefined, 'an unloadable session retries as a cold start');
  assert.match(requests[2].prompt, /Find media\./,
    'the cold-start retry sends the full history, not just the new message');
  assert.equal(outcome.text, 'trimmed', 'the retry result reaches the user, not the resume error');
}

// ── A failed turn forgets the session ─────────────────────────────────────────
{
  resetClaudeCodeSessionsForTest();
  const requests: ClaudeCodeTurnRequest[] = [];
  const seed = makeInput(makeRun());
  await executeServerClaudeCodeTurn(seed, {
    runTurn: async (request, emit) => {
      requests.push(request);
      emit({ type: 'session', sessionId: 'sess-doomed' });
      emit({ type: 'text-delta', delta: 'ok' });
      emit({ type: 'done' });
    },
  });
  // A turn that fails after producing output leaves the CLI transcript in an
  // unknown state, so the next message must not resume it.
  const failing = makeInput(makeRun());
  failing.messages = [
    { role: 'user', content: 'Find media.' },
    { role: 'user', content: 'Now trim it.' },
  ];
  await assert.rejects(executeServerClaudeCodeTurn(failing, {
    runTurn: async (request, emit) => {
      requests.push(request);
      emit({ type: 'text-delta', delta: 'partial' });
      emit({ type: 'error', message: 'usage limit exceeded' });
    },
  }));
  assert.equal(requests[1].sessionId, 'sess-doomed', 'the failing turn did resume');

  const next = makeInput(makeRun());
  await executeServerClaudeCodeTurn(next, {
    runTurn: async (request, emit) => {
      requests.push(request);
      emit({ type: 'done' });
    },
  });
  assert.equal(requests[2].sessionId, undefined, 'a failed turn forgets the session id');
}

console.log('claude-code-turn.verify: session resume, fallback and invalidation passed');
