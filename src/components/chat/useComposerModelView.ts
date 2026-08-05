import { useSyncExternalStore } from 'react';
import { useT } from '../../i18n/locale';
import type { AgentContextUsage } from '../../agent/context-compaction';
import {
  getAgentModelSnapshot,
  isAgentModelReady,
  subscribeAgentModels,
  type AgentModelChoice,
  type AgentModelSnapshot,
} from '../../agent/model-selection';

function compactTokens(tokens: number): string {
  if (tokens < 1_000) return String(tokens);
  if (tokens < 1_000_000) {
    const thousands = tokens / 1_000;
    return `${thousands < 10 ? thousands.toFixed(1) : Math.round(thousands)}k`;
  }
  const millions = tokens / 1_000_000;
  return `${millions < 10 ? millions.toFixed(1) : Math.round(millions)}m`;
}

export interface ComposerModelView {
  readonly activeModel: AgentModelChoice | undefined;
  readonly contextLabel: string;
  readonly contextTitle: string;
  readonly modelReady: boolean;
  readonly modelState: AgentModelSnapshot;
}

export function useComposerModelView(
  contextUsage: AgentContextUsage | null,
): ComposerModelView {
  const t = useT();
  const modelState = useSyncExternalStore(
    subscribeAgentModels,
    getAgentModelSnapshot,
    getAgentModelSnapshot,
  );
  const activeModel = modelState.choices.find((choice) => choice.id === modelState.activeId);
  const usageMatchesModel = contextUsage?.modelId === activeModel?.id;
  const used = contextUsage && usageMatchesModel ? contextUsage.inputTokens : 0;
  const resolvedContext = activeModel?.capabilities.contextWindowTokens;
  const limit = contextUsage && usageMatchesModel
    ? contextUsage.contextWindowTokens
    : resolvedContext?.value ?? 0;
  const usedEstimated = !usageMatchesModel || contextUsage?.isEstimated !== false;
  const limitEstimated = usageMatchesModel
    ? contextUsage?.contextWindowEstimated !== false
    : resolvedContext?.estimated !== false;
  const contextLabel = activeModel
    ? `${usedEstimated ? '~' : ''}${compactTokens(used)} / ${limitEstimated ? '~' : ''}${compactTokens(limit)}`
    : '';
  const contextTitle = activeModel
    ? t('上下文：{used} / {limit}', {
        used: `${usedEstimated ? '≈' : ''}${compactTokens(used)}`,
        limit: `${limitEstimated ? '≈' : ''}${compactTokens(limit)}`,
      })
    : t('选择模型');
  return {
    activeModel,
    contextLabel,
    contextTitle,
    modelReady: isAgentModelReady(modelState),
    modelState,
  };
}
