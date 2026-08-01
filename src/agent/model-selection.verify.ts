import assert from 'node:assert/strict';
import { isAgentModelReady, type AgentModelSnapshot } from './model-selection';

const configured: AgentModelSnapshot = {
  loaded: true,
  activeId: 'openai:gpt-test',
  choices: [{
    id: 'openai:gpt-test',
    provider: 'openai',
    providerLabel: 'OpenAI',
    model: 'gpt-test',
  }],
};

assert.equal(isAgentModelReady(configured), true);
assert.equal(isAgentModelReady({ ...configured, loaded: false }), false, 'startup hydration blocks first send');
assert.equal(isAgentModelReady({ ...configured, activeId: '' }), false, 'missing active model blocks send');
assert.equal(isAgentModelReady({ ...configured, activeId: 'openai:missing' }), false, 'stale selection blocks send');
assert.equal(isAgentModelReady({ ...configured, choices: [] }), false, 'unconfigured providers block send');

console.log('model-selection.verify: ok');
