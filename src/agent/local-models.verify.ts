import assert from 'node:assert/strict';
import { LLM_PROVIDER_PRESETS, llmProviderPreset, normalizeLlmProvider } from '../../shared/llm-providers.ts';
import { KEY_NAMES } from '../../server/keystore.ts';
import { applyAgentModelStatus, getAgentModelSnapshot } from './model-selection.ts';

assert.equal(normalizeLlmProvider('ollama'), 'ollama');
assert.equal(normalizeLlmProvider('lmstudio'), 'lmstudio');

const ollamaPreset = llmProviderPreset('ollama');
assert.equal(ollamaPreset.id, 'ollama');
assert.equal(ollamaPreset.baseUrl, 'http://localhost:11434/v1');
assert.equal(ollamaPreset.defaultModel, 'qwen2.5-coder:7b');

const lmstudioPreset = llmProviderPreset('lmstudio');
assert.equal(lmstudioPreset.id, 'lmstudio');
assert.equal(lmstudioPreset.baseUrl, 'http://localhost:1234/v1');
assert.equal(lmstudioPreset.defaultModel, 'qwen2.5-coder-7b-instruct');

// Check keystore whitelisted keys
assert.ok(KEY_NAMES.includes('LLM_OLLAMA_API_KEY'));
assert.ok(KEY_NAMES.includes('LLM_OLLAMA_BASE_URL'));
assert.ok(KEY_NAMES.includes('LLM_OLLAMA_MODEL'));
assert.ok(KEY_NAMES.includes('LLM_LMSTUDIO_API_KEY'));
assert.ok(KEY_NAMES.includes('LLM_LMSTUDIO_BASE_URL'));
assert.ok(KEY_NAMES.includes('LLM_LMSTUDIO_MODEL'));

// Check model selection snapshot without API keys configured
applyAgentModelStatus({}, {});
const snapshot = getAgentModelSnapshot();
const providerIds = snapshot.choices.map((c) => c.provider);
assert.ok(providerIds.includes('ollama'), 'Ollama should be present without API key');
assert.ok(providerIds.includes('lmstudio'), 'LM Studio should be present without API key');

console.log('Local models verification passed successfully!');
