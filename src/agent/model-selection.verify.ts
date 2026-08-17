import assert from 'node:assert/strict';
import { isAgentModelReady, type AgentModelSnapshot } from './model-selection';
import {
  parseModelCapabilityOverrides,
  resolveModelCapabilities,
  serializeModelCapabilityOverrides,
} from '../../shared/model-capabilities';

const unknownCapabilities = resolveModelCapabilities({
  backend: 'api', provider: 'openai', modelId: 'custom/model:v2',
});
const configured: AgentModelSnapshot = {
  loaded: true,
  activeId: 'openai:gpt-test',
  choices: [{
    id: 'openai:gpt-test',
    backend: 'api',
    provider: 'openai',
    providerLabel: 'OpenAI',
    model: 'gpt-test',
    capabilities: unknownCapabilities,
  }],
};

assert.equal(isAgentModelReady(configured), true);
assert.equal(isAgentModelReady({ ...configured, loaded: false }), false, 'startup hydration blocks first send');
assert.equal(isAgentModelReady({ ...configured, activeId: '' }), false, 'missing active model blocks send');
assert.equal(isAgentModelReady({ ...configured, activeId: 'openai:missing' }), false, 'stale selection blocks send');
assert.equal(isAgentModelReady({ ...configured, choices: [] }), false, 'unconfigured providers block send');

const known = resolveModelCapabilities({ backend: 'api', provider: 'openai', modelId: 'gpt-5' });
assert.deepEqual(known.contextWindowTokens, { value: 400_000, estimated: false, source: 'catalog' });
assert.deepEqual(known.maxInputTokens, { value: 272_000, estimated: false, source: 'catalog' });
assert.deepEqual(known.maxOutputTokens, { value: 128_000, estimated: false, source: 'catalog' });
assert.deepEqual(known.supportsTools, { value: true, estimated: false, source: 'catalog' });
assert.deepEqual(known.supportsImages, { value: true, estimated: false, source: 'catalog' });
const gpt56 = resolveModelCapabilities({ backend: 'api', provider: 'openai', modelId: 'gpt-5.6-sol' });
assert.deepEqual(gpt56.contextWindowTokens, { value: 1_050_000, estimated: false, source: 'catalog' });
assert.deepEqual(gpt56.maxInputTokens, { value: 922_000, estimated: false, source: 'catalog' });
assert.deepEqual(gpt56.maxOutputTokens, { value: 128_000, estimated: false, source: 'catalog' });

assert.deepEqual(unknownCapabilities.contextWindowTokens, {
  value: 409_600, estimated: true, source: 'provider-fallback',
});
assert.deepEqual(unknownCapabilities.maxInputTokens, {
  value: 344_064, estimated: true, source: 'provider-fallback',
});
assert.deepEqual(unknownCapabilities.maxOutputTokens, {
  value: 65_536, estimated: true, source: 'provider-fallback',
});
assert.deepEqual(unknownCapabilities.supportsImages, {
  value: false, estimated: true, source: 'provider-fallback',
});
assert.deepEqual(unknownCapabilities.supportsTools, {
  value: false, estimated: true, source: 'provider-fallback',
});

const overrides = parseModelCapabilityOverrides(JSON.stringify([{
  backend: 'api',
  provider: 'openai',
  modelId: ' custom/model:v2 ',
  contextWindowTokens: 65_536,
  maxInputTokens: 60_000,
  maxOutputTokens: 4_096,
  supportsTools: false,
  supportsImages: true,
}]));
const overridden = resolveModelCapabilities(
  { backend: 'api', provider: 'openai', modelId: 'custom/model:v2' },
  overrides,
);
assert.deepEqual(overridden.contextWindowTokens, {
  value: 65_536, estimated: false, source: 'settings-override',
});
assert.deepEqual(overridden.maxInputTokens, {
  value: 60_000, estimated: false, source: 'settings-override',
});
assert.deepEqual(overridden.maxOutputTokens, {
  value: 4_096, estimated: false, source: 'settings-override',
});
assert.equal(overridden.supportsTools.value, false);
assert.equal(overridden.supportsImages.value, true);
assert.equal(serializeModelCapabilityOverrides(overrides).includes(' custom/model:v2 '), false);

assert.throws(() => parseModelCapabilityOverrides('[{"backend":"api","provider":"openai","modelId":"x","apiKey":"secret"}]'), /Unknown/);
assert.throws(() => parseModelCapabilityOverrides(JSON.stringify([
  { backend: 'api', provider: 'openai', modelId: 'x', supportsTools: true },
  { backend: 'api', provider: 'openai', modelId: 'x', supportsImages: true },
])), /Duplicate/);
assert.throws(() => parseModelCapabilityOverrides(JSON.stringify([{
  backend: 'api', provider: 'openai', modelId: 'x', supportsReasoning: false, reasoningEfforts: ['high'],
}])), /Disabled reasoning/);
assert.throws(() => parseModelCapabilityOverrides(JSON.stringify([{
  backend: 'api', provider: 'openai', modelId: 'x', contextWindowTokens: 8_192, maxInputTokens: 8_193,
}])), /input limit exceeds/);

console.log('model-selection.verify: ok');
