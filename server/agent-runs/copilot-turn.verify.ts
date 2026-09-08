import assert from 'node:assert/strict';
import { executeServerCopilotTurn } from './copilot-turn';
import { createRunWithCapability, flushRunPersistence } from './store';
import { createAcceptanceLoop } from './acceptance-loop';
import { ToolActivation } from '../../src/agent/tool-activation';
import { ToolFailureTracker } from '../../src/agent/toolFailure';
import { estimateTextTokens, prepareContext } from '../../src/agent/context-compaction';
import type { AgentToolSchema } from '../../src/agent/tool-schema';
import type { CopilotTurnRequest } from '../../shared/copilot-agent';

const schemas: readonly AgentToolSchema[] = [
  { name: 'read_timeline', description: 'Read timeline.', input_schema: { type: 'object', properties: {} } },
  { name: 'inactive_tool', description: 'Detailed schema information. '.repeat(300),
    input_schema: { type: 'object', properties: { value: { type: 'string' } } } },
];
const current = new ToolActivation(schemas, [], ['read_timeline']);
assert.equal(current.schemas().length, 1, 'the fixture has a narrower active set');
const run = createRunWithCapability({
  projectId: 'copilot-budget-verify', sessionGeneration: 'gen-1',
  backend: 'copilot', provider: 'openai', model: 'auto',
}).run;
let budgetedTokens = 0;
let sentTools: CopilotTurnRequest['tools'] = [];
try {
  await executeServerCopilotTurn({
    run, messages: [{ role: 'user', content: 'Read timeline.' }], instructions: 'Editor agent.',
    schemas: current.schemas(), model: 'auto', askOnly: false, projectId: run.projectId,
    maxInputTokens: 100_000, maxOutputTokens: 1_000, contextWindowTokens: 128_000,
    contextWindowEstimated: false, signal: new AbortController().signal, requestIndex: 1,
    activation: { current, tail: Promise.resolve(), followupText: null,
      toolFailures: new ToolFailureTracker(), acceptance: createAcceptanceLoop(false, 3) },
  }, {
    prepareContext: async (options) => {
      budgetedTokens = options.requestOverheadTokens ?? 0;
      return prepareContext(options);
    },
    runTurn: async (request, emit) => {
      sentTools = request.tools;
      emit({ type: 'context-usage', inputTokens: 5_000, outputTokens: 5 });
      emit({ type: 'text-delta', delta: 'Ready.' });
      emit({ type: 'done' });
    },
  });
  assert.deepEqual(sentTools.map((tool) => tool.name), ['read_timeline', 'inactive_tool']);
  assert.equal(budgetedTokens, estimateTextTokens(JSON.stringify(sentTools)),
    'context preparation reserves the actual full serialized tool payload');
  assert.equal(run.runtimeContext.toolSchemaCount, sentTools.length);
  assert.equal(run.runtimeContext.activeToolCount, sentTools.length);
  assert.equal(run.runtimeContext.toolSchemaChars, JSON.stringify(sentTools).length,
    'usage metadata describes the identical tool payload sent to Copilot');
} finally {
  await flushRunPersistence(run);
}
console.log('copilot-turn.verify: actual full tool payload drives budgeting and usage');
