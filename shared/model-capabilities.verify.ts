import assert from 'node:assert/strict';
import {
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

// Unknown ids still fall back (no crash).
const unknown = resolveModelCapabilities(identity('qwen', 'definitely-not-a-model'));
assert.equal(unknown.contextWindowTokens.source, 'provider-fallback', 'unknown id falls back');
assert.equal(unknown.contextWindowTokens.estimated, true, 'fallback is marked estimated');

console.log('model-capabilities.verify: snapshot prefix matching passed');
