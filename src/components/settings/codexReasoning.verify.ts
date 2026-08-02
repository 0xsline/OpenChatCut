import assert from 'node:assert/strict';
import type { CodexAgentModel } from '../../../shared/codex-agent.ts';
import { shouldRenderModelPicker, stageFieldValue } from './codexReasoning.ts';
import type { KeyStatusResponse, SettingsField } from './settingsSchema.ts';

const modelField: SettingsField = {
  name: 'CODEX_MODEL', label: 'Codex 模型', kind: 'text',
  defaultLabel: 'Codex 默认模型', discoverableModel: true,
};
const effortField: SettingsField = {
  name: 'CODEX_REASONING_EFFORT', label: '推理强度', kind: 'select',
};
const status: KeyStatusResponse = {
  keys: {
    CODEX_MODEL: { configured: true, source: 'env' },
    CODEX_REASONING_EFFORT: { configured: true, source: 'env' },
  },
  caps: {},
  models: { CODEX_MODEL: 'model-a', CODEX_REASONING_EFFORT: 'high' },
};
const efforts = (values: readonly string[]) => values.map((reasoningEffort) => ({
  reasoningEffort, description: '',
}));
const models: readonly CodexAgentModel[] = [
  {
    id: 'model-a', label: 'Model A', isDefault: true, defaultReasoningEffort: 'high',
    supportedReasoningEfforts: efforts(['low', 'high']),
  },
  {
    id: 'model-b', label: 'Model B', isDefault: false, defaultReasoningEffort: 'low',
    supportedReasoningEfforts: efforts(['low']),
  },
];

let staged = stageFieldValue({}, modelField, 'model-b', status, models, null);
assert.deepEqual(staged, {
  values: { CODEX_MODEL: 'model-b', CODEX_REASONING_EFFORT: '' },
  autoClearedEffort: 'high',
});
staged = stageFieldValue(
  staged.values, modelField, 'model-a', status, models, staged.autoClearedEffort,
);
assert.deepEqual(staged, {
  values: {},
  autoClearedEffort: null,
}, 'switching back restores the saved compatible effort instead of staging its deletion');

staged = stageFieldValue({}, modelField, 'model-b', status, models, null);
staged = stageFieldValue(
  staged.values, effortField, '', status, models, staged.autoClearedEffort,
);
staged = stageFieldValue(
  staged.values, modelField, 'model-a', status, models, staged.autoClearedEffort,
);
assert.deepEqual(staged, {
  values: { CODEX_REASONING_EFFORT: '' },
  autoClearedEffort: null,
}, 'an explicit model-default choice is preserved when switching back');
const defaultModelB = models.map((model) => ({
  ...model,
  isDefault: model.id === 'model-b',
}));
staged = stageFieldValue({}, modelField, '', status, defaultModelB, null);
assert.deepEqual(staged, {
  values: { CODEX_MODEL: '', CODEX_REASONING_EFFORT: '' },
  autoClearedEffort: 'high',
}, 'clearing the saved model also clears an effort unsupported by the default model');
staged = stageFieldValue(
  staged.values, modelField, 'model-a', status, defaultModelB, staged.autoClearedEffort,
);
assert.deepEqual(staged, {
  values: {},
  autoClearedEffort: null,
}, 'cancelling model clear restores the saved model and its compatible effort');

const apiModelField: SettingsField = {
  name: 'LLM_MODEL', label: 'Agent 模型', kind: 'text', discoverableModel: true,
};
assert.equal(
  shouldRenderModelPicker(modelField, 0),
  true,
  'the Codex model picker remains visible while its model list is loading',
);
assert.equal(shouldRenderModelPicker(apiModelField, 0), false);
assert.equal(shouldRenderModelPicker(apiModelField, 1), true);


console.log('codex reasoning settings verification passed');
