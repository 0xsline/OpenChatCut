import assert from 'node:assert/strict';
import type { ModelMessage } from 'ai';
import type { AgentContext } from '../context.ts';
import type { AgentEvent } from '../runtime.ts';
import { INITIAL } from '../../editor/initial.ts';
import { docFromTimeline } from '../../persist/projectStore.ts';
import { runCodexAgent, runCodexSummary } from './runtime.ts';

const encoder = new TextEncoder();
const originalFetch = globalThis.fetch;
const events: AgentEvent[] = [];
let streamCancelled = false;
let followups = 0;
const submittedResults: Record<string, unknown>[] = [];
const submittedTurns: Record<string, unknown>[] = [];

const context: AgentContext = {
  commands: {} as AgentContext['commands'],
  getState: () => INITIAL,
  getDoc: () => docFromTimeline(INITIAL),
  getCreativeMode: () => null,
  templates: [],
  audio: [],
  getProjectId: () => 'project-1',
};

globalThis.fetch = (async (input, init) => {
  const path = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (path === '/api/codex/turn') {
    submittedTurns.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(`${JSON.stringify({
          type: 'tool-start',
          callId: 'followup-call',
          name: 'ask_followup_questions',
          args: { questions: [] },
        })}\n`));
      },
      cancel() {
        streamCancelled = true;
      },
    });
    return new Response(stream, { status: 200, headers: { 'content-type': 'application/x-ndjson' } });
  }
  if (path === '/api/codex/tool-result') {
    submittedResults.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return new Response(null, { status: 200 });
  }
  throw new Error(`Unexpected fetch: ${path}`);
}) as typeof fetch;

try {
  const result = await runCodexAgent(
    [
      {
        role: 'assistant',
        content: [{
          type: 'tool-call',
          toolCallId: 'history-call',
          toolName: 'read_timeline',
          input: { track: 1 },
        }],
      },
      {
        role: 'tool',
        content: [{
          type: 'tool-result',
          toolCallId: 'history-call',
          toolName: 'read_timeline',
          output: { type: 'json', value: { clipId: 'clip-7' } },
        }],
      },
      { role: 'user', content: 'Help me choose.' },
    ] as ModelMessage[],
    context,
    (event) => events.push(event),
    {
      model: 'gpt-5.6-sol',
      reasoningEffort: 'xhigh',
      tools: [{
        name: 'ask_followup_questions',
        description: 'Ask for missing input',
        inputSchema: { type: 'object', properties: {} },
      }],
      executeTool: async () => {
        const followupText = 'Which editing style should I use?';
        events.push({ type: 'text-start' });
        events.push({ type: 'text-delta', delta: followupText });
        followups += 1;
        return { success: true, result: { __followup: followupText }, followupText };
      },
    },
  );

  assert.equal(submittedTurns.length, 1);
  assert.equal(submittedTurns[0].model, 'gpt-5.6-sol');
  assert.equal(submittedTurns[0].reasoningEffort, 'xhigh');
  assert.match(String(submittedTurns[0].prompt), /"track":1/);
  assert.match(String(submittedTurns[0].prompt), /"clipId":"clip-7"/);
  assert.equal(followups, 1);
  assert.equal(streamCancelled, true, 'follow-up must cancel the live Codex response stream');
  assert.equal(submittedResults.length, 1);
  assert.match(String(submittedResults[0].requestId), /^[0-9a-f-]{36}$/i);
  assert.deepEqual(submittedResults[0], {
    requestId: submittedResults[0].requestId,
    callId: 'followup-call',
    success: true,
    result: { __followup: 'Which editing style should I use?' },
  });
  assert.equal(result.at(-1)?.role, 'assistant');
  assert.equal(result.at(-1)?.content, 'Which editing style should I use?');
  assert.equal(events.some((event) => event.type === 'error'), false);
  assert.equal(events.filter((event) => event.type === 'tool-input-start').length, 1);
} finally {
  globalThis.fetch = originalFetch;
}

let normalController: ReadableStreamDefaultController<Uint8Array> | null = null;
globalThis.fetch = (async (input, init) => {
  const path = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (path === '/api/codex/turn') {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        normalController = controller;
        controller.enqueue(encoder.encode(`${JSON.stringify({
          type: 'tool-start',
          callId: 'read-call',
          name: 'read_project',
          args: { projectId: 'project-1' },
        })}\n`));
      },
    });
    return new Response(stream, { status: 200, headers: { 'content-type': 'application/x-ndjson' } });
  }
  if (path === '/api/codex/tool-result') {
    const submitted = JSON.parse(String(init?.body)) as unknown;
    assert.ok(submitted && typeof submitted === 'object' && 'result' in submitted);
    assert.deepEqual(submitted.result, { duration: 42 });
    assert.ok(normalController);
    normalController.enqueue(encoder.encode(`${JSON.stringify({
      type: 'text-delta',
      delta: 'Project inspected.',
    })}\n${JSON.stringify({ type: 'done' })}\n`));
    normalController.close();
    return new Response(null, { status: 200 });
  }
  throw new Error(`Unexpected fetch: ${path}`);
}) as typeof fetch;

try {
  const result = await runCodexAgent(
    [{ role: 'user', content: 'Inspect the project.' }],
    context,
    () => undefined,
    {
      tools: [{ name: 'read_project', inputSchema: { type: 'object' } }],
      executeTool: async () => ({ success: true, result: { duration: 42 } }),
    },
  );
  assert.match(String(result.at(-2)?.content), /"projectId":"project-1"/);
  assert.match(String(result.at(-2)?.content), /"duration":42/);
  assert.equal(result.at(-1)?.content, 'Project inspected.');
} finally {
  globalThis.fetch = originalFetch;
}

globalThis.fetch = (async (input) => {
  const path = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (path !== '/api/codex/turn') throw new Error(`Unexpected fetch: ${path}`);
  const payload = [
    { type: 'text-delta', delta: 'X'.repeat(100) },
    { type: 'done' },
  ].map((event) => JSON.stringify(event)).join('\n');
  return new Response(`${payload}\n`, {
    status: 200,
    headers: { 'content-type': 'application/x-ndjson' },
  });
}) as typeof fetch;
try {
  await assert.rejects(
    runCodexSummary({
      system: 'Summarize.',
      prompt: 'Data.',
      projectId: 'project-1',
      maxOutputTokens: 10,
    }),
    /exceeded its output limit/,
  );
} finally {
  globalThis.fetch = originalFetch;
}

console.log('codex follow-up verification passed');
