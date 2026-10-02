import assert from 'node:assert/strict';
import {
  listVisionModels,
  resolveModelCapabilities,
  type ModelIdentity,
} from './model-capabilities';

const identity = (provider: string, modelId: string): ModelIdentity => ({
  backend: 'api',
  provider,
  modelId,
} as unknown as ModelIdentity);

// Exact catalog entries resolve with their declared window.
const exact = resolveModelCapabilities(identity('qwen', 'qwen3.7-plus'));
assert.equal(exact.contextWindowTokens.value, 1_000_000, 'qwen3.7-plus carries its 1M window');
assert.equal(exact.contextWindowTokens.source, 'catalog', 'catalog source, not fallback');

// Snapshot ids share the base model's entry.
const snapshot = resolveModelCapabilities(identity('qwen', 'qwen3.7-plus-2026-05-26'));
assert.equal(snapshot.contextWindowTokens.value, 1_000_000, 'snapshot matches its base model');
assert.equal(snapshot.contextWindowTokens.source, 'catalog', 'snapshot still counts as catalog');
assert.equal(snapshot.maxOutputTokens.value, 65_536, 'snapshot inherits max output');
assert.equal(snapshot.supportsImages.value, true, 'snapshot inherits image support');

// Longest prefix wins when several bases share the prefix.
const ambiguous = resolveModelCapabilities(identity('qwen', 'qwen3-235b-a22b-2507'));
assert.equal(ambiguous.contextWindowTokens.source, 'catalog', 'prefix matching finds the base entry');

// Unknown ids still fall back (no crash) with the statistically grounded
// estimate, marked estimated so the UI can prompt for manual adjustment.
const unknown = resolveModelCapabilities(identity('qwen', 'definitely-not-a-model'));
assert.equal(unknown.contextWindowTokens.source, 'provider-fallback', 'unknown id falls back');
assert.equal(unknown.contextWindowTokens.estimated, true, 'fallback is marked estimated');
assert.equal(unknown.contextWindowTokens.value, 409_600, 'fallback context uses the catalog-grounded estimate');
assert.equal(unknown.maxOutputTokens.value, 65_536, 'fallback output uses the catalog-grounded estimate');

const deepseekVision = resolveModelCapabilities(identity('deepseek', 'deepseek-v4-flash-vision-exp'));
assert.equal(deepseekVision.supportsImages.value, true, 'DeepSeek vision input reaches the multimodal path');
assert.equal(deepseekVision.supportsImages.source, 'catalog');
assert.ok(listVisionModels('deepseek').includes('deepseek-v4-flash-vision-exp'));

// The gateway's default must expose editing tools without a manual override.
const cheaperDefault = identity('cheaperinference', 'gpt-5.4-mini');
assert.deepEqual(
  resolveModelCapabilities(cheaperDefault),
  resolveModelCapabilities(identity('openai', 'gpt-5.4-mini')),
  'Cheaper Inference inherits its known upstream model capabilities',
);
assert.equal(resolveModelCapabilities(cheaperDefault).supportsTools.value, true);
assert.equal(resolveModelCapabilities(identity('cheaperinference', 'claude-sonnet-5')).supportsTools.value, true);
for (const [upstream, modelId] of [['deepseek', 'deepseek-v4-flash'], ['kimi', 'kimi-k3'], ['glm', 'glm-4.7']]) {
  assert.deepEqual(resolveModelCapabilities(identity('cheaperinference', modelId)),
    resolveModelCapabilities(identity(upstream, modelId)), `${modelId} keeps its known upstream capabilities`);
}
assert.deepEqual(listVisionModels('cheaperinference', 'gpt-5.4-mini'), ['gpt-5.4-mini'],
  'only the configured gateway model is offered for vision');
assert.equal(resolveModelCapabilities(identity('cheaperinference', 'unknown-custom-model')).supportsTools.value, false,
  'unknown gateway models keep the conservative fallback');
assert.equal(resolveModelCapabilities(cheaperDefault, [{ ...cheaperDefault, supportsTools: false }]).supportsTools.value,
  false, 'gateway-specific user overrides still win');

console.log('model-capabilities.verify: snapshot prefix matching passed');
