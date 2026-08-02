import assert from 'node:assert/strict';
import { isAgentModelReady, type AgentModelSnapshot } from './model-selection';
import { contextWindowForModel, defaultContextWindowForProvider } from '../../shared/llm-providers';

const configured: AgentModelSnapshot = {
  loaded: true,
  activeId: 'openai:gpt-test',
  choices: [{
    id: 'openai:gpt-test',
    backend: 'api',
    provider: 'openai',
    providerLabel: 'OpenAI',
    model: 'gpt-test',
    contextWindowTokens: 128_000,
    contextWindowEstimated: true,
  }],
};

assert.equal(isAgentModelReady(configured), true);
assert.equal(isAgentModelReady({ ...configured, loaded: false }), false, 'startup hydration blocks first send');
assert.equal(isAgentModelReady({ ...configured, activeId: '' }), false, 'missing active model blocks send');
assert.equal(isAgentModelReady({ ...configured, activeId: 'openai:missing' }), false, 'stale selection blocks send');
assert.equal(isAgentModelReady({ ...configured, choices: [] }), false, 'unconfigured providers block send');

assert.equal(defaultContextWindowForProvider('anthropic'), 200_000);
assert.equal(defaultContextWindowForProvider('openai'), 400_000);
assert.equal(defaultContextWindowForProvider('gemini'), 1_048_576);
assert.equal(defaultContextWindowForProvider('ollama'), 32_768);
assert.equal(defaultContextWindowForProvider('unknown-provider'), 200_000);
assert.deepEqual(
  contextWindowForModel('openai', 'custom-model', '65536'),
  { tokens: 65_536, estimated: false },
  'a valid per-model override is exact',
);
assert.deepEqual(
  contextWindowForModel('openai', 'custom-model', ''),
  { tokens: 400_000, estimated: true },
  'custom model fallback limits stay visibly estimated',
);
assert.deepEqual(
  contextWindowForModel('openai', 'custom-model', 'not-a-number'),
  { tokens: 400_000, estimated: true },
  'invalid overrides cannot replace a safe provider fallback',
);

console.log('model-selection.verify: ok');
