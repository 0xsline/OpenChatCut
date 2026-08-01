import assert from 'node:assert/strict';
import type { AgentContext } from '../context.ts';
import type { AgentEvent } from '../runtime.ts';
import { INITIAL } from '../../editor/initial.ts';
import { docFromTimeline } from '../../persist/projectStore.ts';
import { runCodexAgent } from './runtime.ts';

const encoder = new TextEncoder();
const originalFetch = globalThis.fetch;
const events: AgentEvent[] = [];
let streamCancelled = false;
let followups = 0;
const submittedResults: Record<string, unknown>[] = [];

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
    [{ role: 'user', content: 'Help me choose.' }],
    context,
    (event) => events.push(event),
    {
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

console.log('codex follow-up verification passed');
