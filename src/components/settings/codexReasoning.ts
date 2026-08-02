import type { CodexAgentModel } from '../../../shared/codex-agent';
import {
  isModelField, modelValue, omitKey,
  type KeyStatusResponse, type SettingsField, type StagedValues as Values,
} from './settingsSchema';

export interface StagedFieldResult {
  readonly values: Values;
  readonly autoClearedEffort: string | null;
}
export function shouldRenderModelPicker(
  field: SettingsField,
  discoveredCount: number,
): boolean {
  return field.discoverableModel === true
    && (field.name === 'CODEX_MODEL' || discoveredCount > 0);
}


export function stageFieldValue(
  previous: Values,
  field: SettingsField,
  raw: string,
  status: KeyStatusResponse | null,
  codexModels: readonly CodexAgentModel[],
  autoClearedEffort: string | null,
): StagedFieldResult {
  const baseline = isModelField(field) ? modelValue(status, field.name) : '';
  const next = raw === baseline ? omitKey(previous, field.name) : { ...previous, [field.name]: raw };
  if (field.name === 'CODEX_REASONING_EFFORT') {
    return { values: next, autoClearedEffort: null };
  }
  if (field.name !== 'CODEX_MODEL') return { values: next, autoClearedEffort };
  const savedModel = modelValue(status, 'CODEX_MODEL');
  const savedEffort = modelValue(status, 'CODEX_REASONING_EFFORT');
  const selected = codexModels.find((model) => model.id === raw)
    ?? (raw ? undefined : codexModels.find((model) => model.isDefault));
  const effort = autoClearedEffort ?? (next.CODEX_REASONING_EFFORT ?? savedEffort);
  const supported = selected
    ? selected.supportedReasoningEfforts.some((option) => option.reasoningEffort === effort)
    : raw === savedModel;
  if (effort && supported) {
    const values = effort === savedEffort
      ? omitKey(next, 'CODEX_REASONING_EFFORT')
      : { ...next, CODEX_REASONING_EFFORT: effort };
    return { values, autoClearedEffort: null };
  }
  if (autoClearedEffort || !effort) return { values: next, autoClearedEffort };
  return { values: { ...next, CODEX_REASONING_EFFORT: '' }, autoClearedEffort: effort };
}
