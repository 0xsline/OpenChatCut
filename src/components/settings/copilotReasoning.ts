import type { CopilotAgentModel } from '../../../shared/copilot-agent';
import { modelValue, type SelectOption } from './settingsSchema';
import type { FieldCtx } from './settingsVendorPane';

function selectedCopilotModel(ctx: FieldCtx): CopilotAgentModel | undefined {
  const selectedId = ctx.values.COPILOT_MODEL ?? modelValue(ctx.status, 'COPILOT_MODEL');
  return ctx.copilot.models.find((model) => model.id === selectedId)
    ?? (selectedId ? undefined : ctx.copilot.models.find((model) => model.isDefault));
}

/** Copilot reports a flat list of supported efforts and no per-model default. */
export function copilotReasoningOptions(ctx: FieldCtx, defaultLabel: string): readonly SelectOption[] {
  const model = selectedCopilotModel(ctx);
  return [
    { value: '', label: defaultLabel },
    ...(model?.supportedReasoningEfforts.map((effort) => ({ value: effort, label: effort })) ?? []),
  ];
}
