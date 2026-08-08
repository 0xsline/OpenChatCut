import assert from 'node:assert/strict';
import type { ModelMessage } from 'ai';
import type { AgentContext } from '../context';
import { INITIAL } from '../../editor/initial';
import { docFromTimeline } from '../../persist/projectStore';
import { ToolActivation } from '../tool-activation';
import type { AgentToolSchema } from '../tool-schema';
import { runCodexAgent } from './runtime';

const originalFetch = globalThis.fetch;
const encoder = new TextEncoder();
const turns: Array<{ tools?: Array<{ name?: string }> }> = [];
const spec = (name: string) => ({ name, inputSchema: { type: 'object' } });
let activeTools = [spec('ToolSearch'), spec('ask_followup_questions')];
const catalog: AgentToolSchema[] = ['ToolSearch', 'ask_followup_questions', 'web_crawl'].map((name) => ({
  name,
  description: name,
  input_schema: { type: 'object', properties: {} },
}));
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
  if (path === '/api/codex/tool-result') return new Response(null, { status: 200 });
  if (path !== '/api/codex/turn') throw new Error(`Unexpected fetch: ${path}`);
  turns.push(JSON.parse(String(init?.body)) as { tools?: Array<{ name?: string }> });
  const name = turns.length === 1 ? 'ToolSearch' : 'ask_followup_questions';
  const event = { type: 'tool-start', callId: `call-${turns.length}`, name, args: {} };
  return new Response(encoder.encode(`${JSON.stringify(event)}\n`), { status: 200 });
}) as typeof fetch;

try {
  const paused = await runCodexAgent(
    [{ role: 'user', content: 'Find the web tool, then ask for a format.' }],
    context,
    () => undefined,
    {
      contextWindowTokens: 64_000,
      contextWindowEstimated: false,
      maxOutputTokens: 4_000,
      tools: activeTools,
      resolveTools: () => activeTools,
      executeTool: async (name) => {
        if (name === 'ToolSearch') {
          activeTools = [spec('ask_followup_questions'), spec('web_crawl')];
          return { success: true, result: { activatedTools: ['web_crawl'] }, refreshTools: true };
        }
        return { success: true, result: { __followup: 'Which format?' }, followupText: 'Which format?' };
      },
    },
  );
  assert.deepEqual(turns[1]?.tools?.map((tool) => tool.name),
    ['ask_followup_questions', 'web_crawl']);
  const resumed = new ToolActivation(catalog, [
    ...paused,
    { role: 'user', content: '1080p' },
  ] as ModelMessage[]);
  assert.ok(resumed.names().includes('web_crawl'),
    'neutral follow-up retains ToolSearch activation for the unfinished request');
  assert.equal(resumed.names().includes('ToolSearch'), false,
    'a paused continuation does not repeat ToolSearch');
} finally {
  globalThis.fetch = originalFetch;
}

console.log('Codex follow-up activation checks passed');
