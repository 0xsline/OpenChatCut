import assert from 'node:assert/strict';
import { parseCopilotTurnRequest } from '../plugins/copilot-agent.ts';
import { isSupportedCopilotVersion } from './installation.ts';
import { KEY_NAMES, seedKeystore } from '../keystore.ts';
import {
  copilotProviderForModel,
  resolveCopilotModelCapabilities,
  type ModelIdentity,
} from '../../shared/model-capabilities.ts';

seedKeystore({
  ...Object.fromEntries(KEY_NAMES.map((name) => [name, ''])),
  COPILOT_MODEL: 'claude-sonnet-5',
  COPILOT_REASONING_EFFORT: 'high',
});

// ── turn request parsing ────────────────────────────────────────────────────
const turnBody = {
  requestId: 'copilot-turn',
  system: 'System',
  prompt: 'Prompt',
  projectId: 'project-1',
  tools: [],
};

assert.equal(parseCopilotTurnRequest(turnBody).model, 'claude-sonnet-5',
  'callers without a model fall back to the saved setting');
assert.equal(parseCopilotTurnRequest(turnBody).reasoningEffort, 'high',
  'callers without an effort still use the saved setting');
assert.equal(parseCopilotTurnRequest({ ...turnBody, reasoningEffort: null }).reasoningEffort, undefined,
  'an explicit null effort suppresses the saved setting');
assert.equal(parseCopilotTurnRequest({ ...turnBody, model: 'gpt-5.5' }).model, 'gpt-5.5',
  'an explicit model wins over the saved setting');

assert.throws(() => parseCopilotTurnRequest({ ...turnBody, tools: [{ name: 'a b' }] }),
  /tools are invalid/, 'tool names are constrained');
assert.throws(
  () => parseCopilotTurnRequest({
    ...turnBody,
    tools: [
      { name: 'read_timeline', inputSchema: {} },
      { name: 'read_timeline', inputSchema: {} },
    ],
  }),
  /unique/,
  'duplicate tool names are rejected before they reach the model',
);
assert.throws(() => parseCopilotTurnRequest({ ...turnBody, reasoningEffort: 'not valid!' }),
  /reasoningEffort is invalid/, 'reasoning effort is pattern-checked');

// ── provider attribution ────────────────────────────────────────────────────
// Copilot serves several vendors behind one subscription; attributing each
// model keeps capability overrides and vision-model selection working.
assert.equal(copilotProviderForModel('claude-opus-5'), 'anthropic');
assert.equal(copilotProviderForModel('gemini-3.8-flash'), 'gemini');
assert.equal(copilotProviderForModel('grok-4.6'), 'xai');
assert.equal(copilotProviderForModel('gpt-5.5'), 'openai');
assert.equal(copilotProviderForModel('mai-code-1.1-flash'), 'openai',
  'unknown vendors fall back to openai rather than throwing');

// ── capabilities come from the runtime, not the bundled catalog ─────────────
const identity: ModelIdentity = {
  backend: 'copilot',
  provider: 'anthropic',
  modelId: 'claude-sonnet-5',
};
const reported = resolveCopilotModelCapabilities(identity, {
  contextWindowTokens: 1_000_000,
  maxInputTokens: 936_000,
  maxOutputTokens: 64_000,
  supportsTools: true,
  supportsVision: true,
  reasoningEfforts: ['low', 'medium', 'high'],
});
assert.equal(reported.contextWindowTokens.value, 1_000_000);
assert.equal(reported.contextWindowTokens.estimated, false,
  'runtime-reported limits are exact, not estimates');
assert.equal(reported.maxInputTokens.value, 936_000);
assert.equal(reported.maxOutputTokens.value, 64_000);
assert.equal(reported.supportsReasoning.value, true,
  'a non-empty effort list implies reasoning support');

const unknown = resolveCopilotModelCapabilities(identity, {
  contextWindowTokens: null,
  maxInputTokens: null,
  maxOutputTokens: null,
  supportsTools: true,
  supportsVision: false,
  reasoningEfforts: [],
});
assert.equal(unknown.contextWindowTokens.estimated, true,
  'a model the runtime cannot describe falls back to an estimate');
assert.equal(unknown.supportsReasoning.value, false);

const overridden = resolveCopilotModelCapabilities(identity, {
  contextWindowTokens: 1_000_000,
  maxInputTokens: 936_000,
  maxOutputTokens: 64_000,
  supportsTools: true,
  supportsVision: true,
  reasoningEfforts: ['low'],
}, [{ ...identity, contextWindowTokens: 32_000 }]);
assert.equal(overridden.contextWindowTokens.value, 32_000,
  'a user override still outranks the runtime');
assert.equal(overridden.contextWindowTokens.source, 'settings-override');

// ── installation gate ───────────────────────────────────────────────────────
assert.equal(isSupportedCopilotVersion('1.0.82'), true);
assert.equal(isSupportedCopilotVersion('0.9.0'), false);
assert.equal(isSupportedCopilotVersion(null), false,
  'an unreadable version is treated as unsupported, not assumed good');

console.log('copilot-agent.verify: turn parsing, provider attribution, capabilities and version gate OK');
