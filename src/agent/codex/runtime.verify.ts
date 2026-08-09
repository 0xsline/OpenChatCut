import assert from 'node:assert/strict';
import type { ModelMessage } from 'ai';
import type { AgentContext } from '../context.ts';
import type { AgentEvent } from '../runtime.ts';
import { INITIAL } from '../../editor/initial.ts';
import { docFromTimeline } from '../../persist/projectStore.ts';
import { executeOpenChatCutTool, runCodexAgent, runCodexSummary } from './runtime.ts';
import { TOOL_SCHEMAS } from '../tools.ts';
import { DEFAULT_AGENT_SETTINGS } from '../settings/agentSettings.ts';
import { ToolFailureTracker } from '../toolFailure.ts';

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

const removeItemSchema = TOOL_SCHEMAS.find((schema) => schema.name === 'remove_item');
assert.ok(removeItemSchema);
const rejectedMutation = await executeOpenChatCutTool(
  removeItemSchema,
  { itemId: 'missing' },
  {
    ctx: context,
    onEvent: () => undefined,
    settings: DEFAULT_AGENT_SETTINGS,
    resolveGuard: async () => null,
  },
);
assert.equal(rejectedMutation.success, false);
assert.match(JSON.stringify(rejectedMutation.result), /no item missing/);

const followupSchema = TOOL_SCHEMAS.find((schema) => schema.name === 'ask_followup_questions');
assert.ok(followupSchema);
const settlementOrder: string[] = [];
const settledFollowup = await executeOpenChatCutTool(
  followupSchema,
  { fields: [{ id: 'style', label: 'Which style?', type: 'text' }] },
  {
    ctx: context,
    onEvent: (event) => {
      if (event.type === 'tool') settlementOrder.push(`tool:${event.name}`);
    },
    settings: DEFAULT_AGENT_SETTINGS,
    resolveGuard: async () => null,
    onFollowup: () => settlementOrder.push('followup'),
  },
);
assert.equal(settledFollowup.success, true);
assert.deepEqual(settlementOrder, ['followup', 'tool:ask_followup_questions'],
  'the real tool boundary exposes the follow-up before emitting its tool event');

const followupFailures = new ToolFailureTracker();
followupFailures.record('edit_item', {
  success: false,
  result: { error: 'updates[0]: item not found: missing' },
});

globalThis.fetch = (async (input, init) => {
  const path = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (path === '/api/codex/turn') {
    submittedTurns.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(`${JSON.stringify({
          type: 'context-usage',
          inputTokens: 30_000,
          contextWindowTokens: 400_000,
        })}\n`));
        controller.enqueue(encoder.encode(`${JSON.stringify({
          type: 'text-delta',
          delta: 'I need one choice before editing.',
        })}\n`));
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
      contextWindowTokens: 272_000,
      contextWindowEstimated: false,
      maxOutputTokens: 64_000,
      toolFailures: followupFailures,
      tools: [{
        name: 'ask_followup_questions',
        description: 'Ask for missing input',
        inputSchema: { type: 'object', properties: {} },
      }],
      executeTool: async (_name, _args, _toolCallId, _signal, _harness, onFollowup) => {
        const followupText = '<widget><form-text id="style" label="Which editing style?"/></widget>';
        onFollowup?.(followupText);
        events.push({ type: 'tool', name: 'ask_followup_questions', args: {}, result: { __followup: followupText } });
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
    result: { __followup: '<widget><form-text id="style" label="Which editing style?"/></widget>' },
  });
  assert.equal(result.at(-1)?.role, 'assistant');
  assert.deepEqual(result.at(-1)?.content, [{
    type: 'text',
    text: 'I need one choice before editing.\n\n<widget><form-text id="style" label="Which editing style?"/></widget>',
    providerOptions: {
      openchatcut: { activatedTools: ['ask_followup_questions'] },
    },
  }]);
  assert.ok(JSON.stringify(result).includes('__followup'),
    'follow-up pause preserves the submitted tool result in history');
  assert.equal(events.some((event) => event.type === 'error'), false);
  assert.equal(events.filter((event) => event.type === 'tool-input-start').length, 1);
  const visibleOrder = events.flatMap((event) => event.type === 'text-delta'
    ? [`text:${event.delta}`]
    : event.type === 'tool' ? [`tool:${event.name}`] : []);
  assert.deepEqual(visibleOrder, [
    'text:I need one choice before editing.',
    'tool:ask_followup_questions',
    'text:<widget><form-text id="style" label="Which editing style?"/></widget>',
  ], 'Codex renders the explanation, then the tool call, then the interaction card');
  assert.equal(followupFailures.hasUnresolved, true, 'follow-up must preserve earlier tool failures');
} finally {
  globalThis.fetch = originalFetch;
}

globalThis.fetch = (async (input, init) => {
  const path = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (path !== '/api/codex/turn') throw new Error(`Unexpected fetch: ${path}`);
  const submitted = JSON.parse(String(init?.body)) as { askOnly?: boolean; tools?: Array<{ name?: string }> };
  assert.equal(submitted.askOnly, true);
  assert.deepEqual(submitted.tools?.map((tool) => tool.name), ['load_skill'],
    'Q&A Codex turns retain the read-only tools selected by the shared runtime');
  const payload = [
    { type: 'text-delta', delta: 'The edit was completed successfully.' },
    { type: 'done' },
  ].map((event) => JSON.stringify(event)).join('\n');
  return new Response(`${payload}\n`, {
    status: 200,
    headers: { 'content-type': 'application/x-ndjson' },
  });
}) as typeof fetch;
try {
  const resumedEvents: AgentEvent[] = [];
  const resumed = await runCodexAgent(
    [{ role: 'user', content: 'Continue after the follow-up.' }],
    context,
    (event) => resumedEvents.push(event),
    {
      askOnly: true,
      contextWindowTokens: 64_000,
      contextWindowEstimated: false,
      maxOutputTokens: 64_000,
      toolFailures: followupFailures,
      tools: [{
        name: 'load_skill',
        description: 'Load the selected skill.',
        inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
      }],
      executeTool: async () => ({ success: true, result: null }),
    },
  );
  assert.match(String(resumed.at(-1)?.content), /couldn't complete the requested operation/);
  assert.doesNotMatch(String(resumed.at(-1)?.content), /completed successfully/);
  assert.equal(followupFailures.hasUnresolved, false, 'terminal failure reporting closes the carried failure');
  assert.doesNotMatch(
    resumedEvents
      .filter((event): event is Extract<AgentEvent, { type: 'text-delta' }> => event.type === 'text-delta')
      .map((event) => event.delta)
      .join(''),
    /completed successfully/,
  );
} finally {
  globalThis.fetch = originalFetch;
}

let normalController: ReadableStreamDefaultController<Uint8Array> | null = null;
globalThis.fetch = (async (input, init) => {
  const path = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (path === '/api/codex/turn') {
    const submittedTurn = JSON.parse(String(init?.body)) as Record<string, unknown>;
    assert.equal(submittedTurn.reasoningEffort, null,
      'an omitted resolved effort explicitly suppresses the server-side saved fallback');
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
    })}\n${JSON.stringify({
      type: 'context-usage',
      inputTokens: 1_000,
      contextWindowTokens: 1_000_000,
      outputTokens: 120,
      reasoningTokens: 40,
      cacheReadTokens: 700,
      noCacheInputTokens: 300,
    })}\n${JSON.stringify({ type: 'done' })}\n`));
    normalController.close();
    return new Response(null, { status: 200 });
  }
  throw new Error(`Unexpected fetch: ${path}`);
}) as typeof fetch;
const normalEvents: AgentEvent[] = [];
const normalFailures = new ToolFailureTracker();
const persistedCodexUsages: Extract<AgentEvent, { type: 'context-usage' }>['usage'][] = [];
let persistedCodexTools: readonly { readonly name: string }[] = [];
normalFailures.record('read_project', { success: false, result: { error: 'stale read' } });

try {
  const result = await runCodexAgent(
    [{ role: 'user', content: 'Inspect the project.' }],
    context,
    (event) => normalEvents.push(event),
    {
      modelId: 'codex:custom',
      contextWindowTokens: 64_000,
      contextWindowEstimated: false,
      contextWindowOverride: true,
      maxOutputTokens: 64_000,
      toolFailures: normalFailures,
      tools: [{ name: 'read_project', inputSchema: { type: 'object' } }],
      onContextUsage: async (usage, tools) => {
        await Promise.resolve();
        persistedCodexUsages.push(usage);
        persistedCodexTools = tools;
      },
      executeTool: async () => ({ success: true, result: { duration: 42 } }),
    },
  );
  assert.match(String(result.at(-2)?.content), /"projectId":"project-1"/);
  assert.match(String(result.at(-2)?.content), /"duration":42/);
  assert.equal(result.at(-1)?.content, 'Project inspected.');
  assert.equal(normalFailures.hasUnresolved, false, 'a successful same-tool retry must restore normal output');
  const usageEvent = normalEvents.find((event) => event.type === 'context-usage');
  assert.equal(usageEvent?.type === 'context-usage' ? usageEvent.usage.contextWindowTokens : 0, 64_000,
    'Codex provider usage cannot replace an explicit context override');
  assert.equal(persistedCodexUsages.length, 1,
    'Codex completion persists exactly one observed usage sample');
  const [persistedCodexUsage] = persistedCodexUsages;
  assert.ok(persistedCodexUsage, 'the persisted Codex usage sample must be available for inspection');
  assert.equal(persistedCodexUsage.outputTokens, 120);
  assert.equal(persistedCodexUsage.reasoningTokens, 40);
  assert.equal(persistedCodexUsage.cacheReadTokens, 700);
  assert.equal(persistedCodexUsage.noCacheInputTokens, 300);
  assert.deepEqual(persistedCodexTools.map((tool) => tool.name), ['read_project'],
    'Codex usage persistence receives the exact tool schema shape before completion');
} finally {
  globalThis.fetch = originalFetch;
}

let failureController: ReadableStreamDefaultController<Uint8Array> | null = null;
const failureSubmissions: Record<string, unknown>[] = [];
globalThis.fetch = (async (input, init) => {
  const path = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (path === '/api/codex/turn') {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        failureController = controller;
        controller.enqueue(encoder.encode(`${JSON.stringify({
          type: 'text-delta',
          delta: 'Updated the volume successfully.',
        })}\n`));
        controller.enqueue(encoder.encode(`${JSON.stringify({
          type: 'tool-start',
          callId: 'failed-edit',
          name: 'edit_item',
          args: { updates: [{ itemId: 'missing', volume: 0.42 }] },
        })}\n`));
      },
    });
    return new Response(stream, { status: 200, headers: { 'content-type': 'application/x-ndjson' } });
  }
  if (path === '/api/codex/tool-result') {
    failureSubmissions.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    assert.ok(failureController);
    failureController.enqueue(encoder.encode(`${JSON.stringify({ type: 'done' })}\n`));
    failureController.close();
    return new Response(null, { status: 200 });
  }
  throw new Error(`Unexpected fetch: ${path}`);
}) as typeof fetch;

try {
  const failureEvents: AgentEvent[] = [];
  const result = await runCodexAgent(
    [{ role: 'user', content: 'Set the missing clip volume.' }],
    context,
    (event) => failureEvents.push(event),
    {
      contextWindowTokens: 64_000,
      contextWindowEstimated: false,
      maxOutputTokens: 64_000,
      tools: [{ name: 'edit_item', inputSchema: { type: 'object' } }],
      executeTool: async () => ({
        success: false,
        result: { ok: false, error: 'updates[0]: item not found: missing' },
      }),
    },
  );
  assert.equal(failureSubmissions[0]?.success, false);
  assert.match(String(result.at(-2)?.content), /success=false/);
  assert.match(String(result.at(-1)?.content), /couldn't complete the requested operation/);
  assert.match(String(result.at(-1)?.content), /updates\[0\]: item not found: missing/);
  assert.doesNotMatch(String(result.at(-1)?.content), /successfully/);
  const displayed = failureEvents
    .filter((event): event is Extract<AgentEvent, { type: 'text-delta' }> => event.type === 'text-delta')
    .map((event) => event.delta)
    .join('');
  assert.match(displayed, /couldn't complete the requested operation/);
  assert.doesNotMatch(displayed, /Updated the volume successfully/);
} finally {
  globalThis.fetch = originalFetch;
}

globalThis.fetch = (async (input) => {
  const path = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (path !== '/api/codex/turn') throw new Error(`Unexpected fetch: ${path}`);
  const payload = [
    { type: 'text-delta', delta: 'The unavailable tool completed successfully.' },
    {
      type: 'tool-end',
      callId: 'rejected:request:1',
      name: 'unknown_tool',
      args: { value: 1 },
      result: { error: 'This OpenChatCut tool call is unavailable.' },
      success: false,
    },
    { type: 'done' },
  ].map((event) => JSON.stringify(event)).join('\n');
  return new Response(`${payload}\n`, {
    status: 200,
    headers: { 'content-type': 'application/x-ndjson' },
  });
}) as typeof fetch;
try {
  const rejectedEvents: AgentEvent[] = [];
  const rejected = await runCodexAgent(
    [{ role: 'user', content: 'Use an unavailable tool.' }],
    context,
    (event) => rejectedEvents.push(event),
    {
      askOnly: true,
      contextWindowTokens: 64_000,
      contextWindowEstimated: false,
      maxOutputTokens: 64_000,
      tools: [],
      executeTool: async () => ({ success: true, result: null }),
    },
  );
  assert.match(String(rejected.at(-1)?.content), /couldn't complete the requested operation/);
  assert.doesNotMatch(JSON.stringify(rejected), /completed successfully/);
  assert.doesNotMatch(
    rejectedEvents
      .filter((event): event is Extract<AgentEvent, { type: 'text-delta' }> => event.type === 'text-delta')
      .map((event) => event.delta)
      .join(''),
    /completed successfully/,
  );
} finally {
  globalThis.fetch = originalFetch;
}
globalThis.fetch = (async (input) => {
  const path = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (path !== '/api/codex/turn') throw new Error(`Unexpected fetch: ${path}`);
  const payload = [
    { type: 'text-delta', delta: 'abcd' },
    { type: 'text-delta', delta: 'X'.repeat(40) },
    { type: 'done' },
  ].map((event) => JSON.stringify(event)).join('\n');
  return new Response(`${payload}\n`, {
    status: 200,
    headers: { 'content-type': 'application/x-ndjson' },
  });
}) as typeof fetch;
try {
  const cappedEvents: AgentEvent[] = [];
  const capped = await runCodexAgent(
    [{ role: 'user', content: 'Keep the answer short.' }],
    context,
    (event) => cappedEvents.push(event),
    {
      askOnly: true,
      contextWindowTokens: 64_000,
      contextWindowEstimated: false,
      maxOutputTokens: 10,
      tools: [],
      executeTool: async () => ({ success: true, result: null }),
    },
  );
  assert.equal(capped.at(-1)?.content, 'abcd',
    'Codex Agent stops before a delta would exceed its effective output ceiling');
  assert.equal(cappedEvents.some((event) => event.type === 'error'), false);
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
