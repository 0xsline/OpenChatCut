import { useSyncExternalStore } from 'react';
import { useT } from '../../i18n/locale';
import { theme } from '../../theme';
import type { AgentContextUsage } from '../../agent/context-compaction';
import {
  getAgentModelSnapshot,
  isAgentModelReady,
  selectAgentModel,
  subscribeAgentModels,
  type AgentModelChoice,
  type AgentModelSnapshot,
} from '../../agent/model-selection';
import { Icon } from '../icons';
import { ComposerPopover } from './ComposerPopover';

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
  const limit = contextUsage && usageMatchesModel
    ? contextUsage.contextWindowTokens
    : activeModel?.contextWindowTokens ?? 0;
  const usedEstimated = !usageMatchesModel || contextUsage?.isEstimated !== false;
  const limitEstimated = usageMatchesModel
    ? contextUsage?.contextWindowEstimated !== false
    : activeModel?.contextWindowEstimated !== false;
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

export function ComposerModelPicker({ anchor, onClose, view }: {
  readonly anchor: HTMLElement | null;
  readonly onClose: () => void;
  readonly view: ComposerModelView;
}) {
  const t = useT();
  return (
    <ComposerPopover width={278} anchor={anchor} onClose={onClose}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, fontSize: 10.5, color: theme.textDim, padding: '4px 8px 6px' }}>
        <span>{t('本条对话使用的模型')}</span>
        <span title={view.contextTitle} style={{ fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>{view.contextLabel}</span>
      </div>
      {view.modelState.choices.length === 0 && (
        <div style={{ padding: '7px 9px 9px', color: theme.textDim, fontSize: 11.5, lineHeight: 1.5 }}>
          {view.modelState.loaded ? t('请先在设置中配置一个模型厂商。') : t('正在读取模型配置…')}
        </div>
      )}
      {view.modelState.choices.map((choice) => {
        const active = choice.id === view.modelState.activeId;
        return (
          <button type="button" key={choice.id}
            onClick={() => { selectAgentModel(choice.id); onClose(); }}
            style={{ display: 'flex', alignItems: 'center', gap: 9, width: '100%', padding: '7px 9px', border: 0, borderRadius: 3, background: active ? theme.panel : 'transparent', color: theme.text, cursor: 'pointer', textAlign: 'left' }}>
            <span style={{ flex: 1, minWidth: 0 }}>
              <strong style={{ display: 'block', fontSize: 11.5, fontWeight: 600 }}>{choice.providerLabel}</strong>
              <small style={{ display: 'block', color: theme.textDim, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{choice.model}</small>
            </span>
            {active && <span style={{ color: theme.accent, lineHeight: 0 }}><Icon name="check" size={13} /></span>}
          </button>
        );
      })}
    </ComposerPopover>
  );
}
