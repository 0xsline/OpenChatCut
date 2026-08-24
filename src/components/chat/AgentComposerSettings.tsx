import type { CSSProperties } from 'react';
import {
  AGENT_CACHE_MODES,
  MAX_ACCEPTANCE_ITERATIONS,
  MIN_ACCEPTANCE_ITERATIONS,
  MG_TIERS,
  normalizeAcceptanceIterations,
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
          ? t('YOLO 模式：提案自动应用，工具直接执行；仅在缺少关键信息时询问。')
          : t('Ask 模式：时间线提案等待你应用；工具直接执行，关键选项仍会询问。')}
      </div>
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
      <label style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', cursor: 'pointer', color: theme.text, fontSize: 12.5 }}>
        <input type="checkbox" checked={settings.autonomousAcceptance}
          onChange={(event) => onSettingsChange({ autonomousAcceptance: event.target.checked })}
          style={{ accentColor: theme.accent }} />
        {t('自主验收')}
      </label>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '0 10px 10px', color: theme.textDim, fontSize: 11 }}>
        <span>{t('修改后主动读取最新工程并检查结果，最多')}</span>
        <input type="number" min={MIN_ACCEPTANCE_ITERATIONS} max={MAX_ACCEPTANCE_ITERATIONS}
          value={settings.maxAcceptanceIterations} disabled={!settings.autonomousAcceptance}
          onChange={(event) => onSettingsChange({ maxAcceptanceIterations: normalizeAcceptanceIterations(Number(event.target.value)) })}
          aria-label={t('自主验收最大轮次')}
          style={{ width: 42, color: theme.text, background: theme.panel, border: `1px solid ${theme.borderLight}`, borderRadius: 5 }} />
        <span>{t('轮')}</span>
      </div>
    </>
  );
}
