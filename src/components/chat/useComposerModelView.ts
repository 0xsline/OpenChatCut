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
  readonly contextNearLimit: boolean;
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
  // Match a usage record to the active model across execution endpoints.
  // Client-side runs stamp contextUsage.modelId with the AgentModelChoice.id
  // ("provider:model"); serverRun echoes model only ("claude-fable-5") because
  // its payload carries `model` (serverRunSend.ts) and the server stamps it
  // verbatim (server/agent-runs/context.ts). Compare identity leniently so the
  // "used / window" readout is correct whether the run executed in the browser
  // or on the server, without ever attributing another model's usage here.
  const usageModelId = contextUsage?.modelId ?? '';
  const usageMatchesModel = !!activeModel && (
    usageModelId === activeModel.id
    || usageModelId === `${activeModel.provider}:${activeModel.model}`
    || usageModelId === activeModel.model
  );
  const used = contextUsage && usageMatchesModel ? contextUsage.inputTokens : 0;
  const resolvedContext = activeModel?.capabilities.contextWindowTokens;
  const limit = contextUsage && usageMatchesModel
    ? contextUsage.contextWindowTokens
    : resolvedContext?.value ?? 0;
  const usedEstimated = !usageMatchesModel || contextUsage?.isEstimated !== false;
  const limitEstimated = usageMatchesModel
    ? contextUsage?.contextWindowEstimated !== false
    : resolvedContext?.estimated !== false;
  const contextNearLimit = limit > 0 && used / limit >= 0.65;
  const contextLabel = activeModel
    ? `${usedEstimated ? '~' : ''}${compactTokens(used)} / ${limitEstimated ? '~' : ''}${compactTokens(limit)}`
    : '';
  const breakdown = contextUsage && usageMatchesModel && contextUsage.systemTokens !== undefined
    ? t('系统 {system} · 工具 {tools}（{toolCount} 个）· 历史 {history}', {
        system: `≈${compactTokens(contextUsage.systemTokens)}`,
        tools: `≈${compactTokens(contextUsage.toolSchemaTokens ?? 0)}`,
        toolCount: String(contextUsage.toolCount ?? 0),
        history: `≈${compactTokens(contextUsage.historyTokens ?? 0)}`,
      })
    : '';
  const cache = contextUsage && usageMatchesModel && contextUsage.cacheReadTokens !== undefined
    ? t('缓存读取 {tokens}', { tokens: compactTokens(contextUsage.cacheReadTokens) })
    : '';
  const contextSummary = activeModel
    ? t('上下文：{used} / {limit}', {
        used: `${usedEstimated ? '≈' : ''}${compactTokens(used)}`,
        limit: `${limitEstimated ? '≈' : ''}${compactTokens(limit)}`,
      })
    : t('选择模型');
  const warning = contextNearLimit
    ? t('上下文接近上限，发送后可能自动压缩较早对话。')
    : '';
  const contextTitle = [contextSummary, warning, breakdown, cache].filter(Boolean).join('\n');
  return {
    activeModel,
    contextLabel,
    contextNearLimit,
    contextTitle,
    modelReady: isAgentModelReady(modelState),
    modelState,
  };
}
