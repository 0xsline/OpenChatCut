import type { CSSProperties } from 'react';
import {
  AGENT_CACHE_MODES,
  MG_TIERS,
  type AgentCacheMode,
  type AgentSettings,
  type MgTier,
} from '../../agent/settings/agentSettings';
import { useT } from '../../i18n/locale';
import { theme } from '../../theme';

const TIER_LABELS: Record<MgTier, string> = {
  speed: '速度',
  balance: '均衡',
  quality: '质量',
};
const CACHE_LABELS: Record<AgentCacheMode, string> = {
  short: '短对话',
  long: '长对话',
};

interface AgentComposerSettingsProps {
  readonly autoApply: boolean;
  readonly onAutoApplyChange: (value: boolean) => void;
  readonly settings: AgentSettings;
  readonly onSettingsChange: (patch: Partial<AgentSettings>) => void;
}

function choiceStyle(active: boolean): CSSProperties {
  return {
    flex: 1,
    padding: '4px 0',
    fontSize: 11.5,
    borderRadius: 6,
    cursor: 'pointer',
    border: `0.5px solid ${active ? theme.accent : theme.borderLight}`,
    background: active ? theme.panel : 'none',
    color: active ? theme.text : theme.textDim,
  };
}

export function AgentComposerSettings(props: AgentComposerSettingsProps) {
  const t = useT();
  const { autoApply, onAutoApplyChange, settings, onSettingsChange } = props;
  return (
    <>
      <div style={{ padding: '8px 10px 4px', color: theme.text, fontSize: 12.5 }}>{t('模式')}</div>
      <div style={{ display: 'flex', gap: 4, padding: '0 10px' }}>
        {(['ask', 'yolo'] as const).map((mode) => {
          const active = (mode === 'yolo') === autoApply;
          return (
            <button key={mode} onClick={() => onAutoApplyChange(mode === 'yolo')} style={choiceStyle(active)}>
              {mode === 'ask' ? t('Ask 模式') : t('YOLO 模式')}
            </button>
          );
        })}
      </div>
      <div style={{ fontSize: 11, color: theme.textDim, padding: '0 10px 6px' }}>
        {autoApply
          ? t('YOLO 模式：所有操作直接执行，不会逐条确认（仍可撤销）。')
          : t('Ask 模式：AI 的改动先经你确认；有多个可选项时 AI 会先问你。')}
      </div>
      {!autoApply && (
        <div style={{ fontSize: 11, color: theme.textDim, padding: '0 10px 6px' }}>
          {t('生成/导出/转写/网页抓取等付费操作在 Ask 模式下会先经你确认。')}
        </div>
      )}
      <div style={{ padding: '8px 10px 4px', color: theme.text, fontSize: 12.5 }}>{t('MG 质量')}</div>
      <div style={{ display: 'flex', gap: 4, padding: '0 10px' }}>
        {MG_TIERS.map((tier) => (
          <button key={tier} onClick={() => onSettingsChange({ mgTier: tier })}
            style={choiceStyle(settings.mgTier === tier)}>{t(TIER_LABELS[tier])}</button>
        ))}
      </div>
      <div style={{ fontSize: 11, color: theme.textDim, padding: '4px 10px 6px' }}>
        {t('速度=最快出活 / 均衡 / 质量=打磨动效细节。')}
      </div>
      <div style={{ padding: '8px 10px 4px', color: theme.text, fontSize: 12.5 }}>{t('缓存时长')}</div>
      <div style={{ display: 'flex', gap: 4, padding: '0 10px' }}>
        {AGENT_CACHE_MODES.map((mode) => (
          <button key={mode} onClick={() => onSettingsChange({ cacheMode: mode })}
            style={choiceStyle(settings.cacheMode === mode)}>{t(CACHE_LABELS[mode])}</button>
        ))}
      </div>
      <div style={{ fontSize: 11, color: theme.textDim, padding: '4px 10px 6px' }}>
        {t('短对话使用默认缓存；长对话在支持的模型厂商上请求 1 小时缓存。')}
      </div>
      <label style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', cursor: 'pointer', color: theme.text, fontSize: 12.5 }}>
        <input type="checkbox" checked={settings.planMode}
          onChange={(event) => onSettingsChange({ planMode: event.target.checked })}
          style={{ accentColor: theme.accent }} />
        {t('计划模式')}
      </label>
      <div style={{ fontSize: 11, color: theme.textDim, padding: '0 10px 10px' }}>
        {t('先出编号计划，确认后再动手。')}
      </div>
    </>
  );
}
