import assert from 'node:assert/strict';
import {
  isLocalLlmProvider,
  llmProviderPreset,
  normalizeLlmProvider,
} from '../../shared/llm-providers.ts';
import { KEY_NAMES } from '../../server/keystore.ts';
import {
  SETTINGS_CATEGORIES,
  vendorConfigured,
} from '../components/settings/settingsSchema.ts';
import { applyAgentModelStatus, getAgentModelSnapshot } from './model-selection.ts';

assert.equal(normalizeLlmProvider('ollama'), 'ollama');
assert.equal(normalizeLlmProvider('lmstudio'), 'lmstudio');
assert.equal(isLocalLlmProvider('ollama'), true);
assert.equal(isLocalLlmProvider('anthropic'), false);
assert.equal(llmProviderPreset('ollama').baseUrl, 'http://localhost:11434/v1');
assert.equal(llmProviderPreset('lmstudio').baseUrl, 'http://localhost:1234/v1');

for (const name of [
  'LLM_OLLAMA_API_KEY',
  'LLM_OLLAMA_BASE_URL',
  'LLM_OLLAMA_MODEL',
  'LLM_LMSTUDIO_API_KEY',
  'LLM_LMSTUDIO_BASE_URL',
  'LLM_LMSTUDIO_MODEL',
] as const) {
  assert.ok(KEY_NAMES.includes(name), `${name} must be whitelisted`);
}

const llmGroup = SETTINGS_CATEGORIES.flatMap((category) => category.groups)
  .find((group) => group.key === 'llm');
assert.ok(llmGroup);
const ollamaPage = llmGroup.vendors.find((page) => page.vendor === 'ollama');
assert.ok(ollamaPage);
assert.equal(ollamaPage.fields.find((field) => field.kind === 'secret')?.label, 'API Key（可选）');

applyAgentModelStatus({}, {});
assert.deepEqual(getAgentModelSnapshot(), { activeId: '', choices: [], loaded: true });
assert.equal(vendorConfigured({ keys: {}, caps: {}, models: {} }, ollamaPage), false);

applyAgentModelStatus({}, { LLM_OLLAMA_MODEL: 'llama3.2' });
assert.deepEqual(
  getAgentModelSnapshot().choices.map((choice) => [choice.provider, choice.model]),
  [['ollama', 'llama3.2']],
);
assert.equal(vendorConfigured({
  keys: {},
  caps: {},
  models: { LLM_OLLAMA_MODEL: 'llama3.2' },
}, ollamaPage), true);

applyAgentModelStatus({ LLM_ANTHROPIC_API_KEY: { configured: true } }, {});
assert.equal(getAgentModelSnapshot().choices[0]?.provider, 'anthropic');

console.log('local model verification passed');
