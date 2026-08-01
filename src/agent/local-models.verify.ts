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
import {
  applyAgentModelStatus,
  applyCodexAgentStatus,
  getAgentModelSnapshot,
  selectAgentModel,
} from './model-selection.ts';

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

let persistenceCalls = 0;
const originalFetch = globalThis.fetch;
globalThis.fetch = (async () => {
  persistenceCalls += 1;
  return new Response('{}', { status: 200 });
}) as typeof fetch;
applyAgentModelStatus({
  LLM_OPENAI_API_KEY: { configured: true },
  LLM_GEMINI_API_KEY: { configured: true },
}, { LLM_PROVIDER: 'openai' });
const gemini = getAgentModelSnapshot().choices.find((choice) => choice.provider === 'gemini');
assert.ok(gemini);
selectAgentModel(gemini.id);
assert.equal(getAgentModelSnapshot().activeId, gemini.id);
assert.equal(persistenceCalls, 0, 'conversation model switching must not rewrite server settings');

const signedInCodex = {
  installed: true,
  version: '0.146.0',
  account: { type: 'chatgpt' as const, email: 'editor@example.com', planType: 'pro' },
  loginPending: false,
};
applyCodexAgentStatus(signedInCodex, 'gpt-5.4');
const codex = getAgentModelSnapshot().choices.find((choice) => choice.backend === 'codex');
assert.ok(codex);
assert.equal(getAgentModelSnapshot().activeId, gemini.id, 'adding Codex must not replace the active API model');
selectAgentModel(codex.id);
applyAgentModelStatus({
  LLM_OPENAI_API_KEY: { configured: true },
  LLM_GEMINI_API_KEY: { configured: true },
}, { LLM_PROVIDER: 'openai' });
assert.equal(getAgentModelSnapshot().activeId, codex.id, 'key refresh must preserve an active Codex model');

const codexPage = llmGroup.vendors.find((page) => page.connection === 'codex');
assert.ok(codexPage);
assert.equal(vendorConfigured(null, codexPage, signedInCodex), true);
applyCodexAgentStatus({
  installed: true,
  version: '0.146.0',
  account: { type: 'apiKey', email: null, planType: null },
  loginPending: false,
}, 'gpt-5.4');
assert.equal(getAgentModelSnapshot().choices.some((choice) => choice.backend === 'codex'), false);
assert.equal(vendorConfigured(null, codexPage, {
  ...signedInCodex,
  account: { type: 'apiKey', email: null, planType: null },
}), false);
globalThis.fetch = originalFetch;

console.log('local model verification passed');
