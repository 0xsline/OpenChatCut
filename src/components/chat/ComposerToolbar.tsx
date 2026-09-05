import type { MouseEvent as ReactMouseEvent } from 'react';
import { useT } from '../../i18n/locale';
import { theme } from '../../theme';
import { Icon, type IconName } from '../icons';
import type { ChatMode } from './ChatComposer';
import codexPng from '../../../assets/vendor-icons/codex-color.png';

export type ComposerPopover =
  | 'mode' | 'model' | 'skill' | 'settings' | 'assets' | 'templates' | 'more' | null;

interface ToolbarProps {
  mode: ChatMode;
  activeModel?: { providerLabel: string; model: string; backend: 'api' | 'codex' | 'copilot' };
  contextLabel: string;
  contextTitle: string;
  contextNearLimit: boolean;
  activeSkillName?: string;
  pop: ComposerPopover;
  selecting: boolean;
  enhancing: boolean;
  running: boolean;
  canEnhance: boolean;
  canSend: boolean;
  sendTitle: string;
  onTogglePop: (pop: ComposerPopover, anchor: HTMLElement) => void;
  onToggleSelecting: () => void;
  onEnhance: () => void;
  onSubmit: () => void;
  onStop: () => void;
}

function BarBtn({ icon, title, onClick, active, disabled, className, expanded, hasPopup }: {
  icon: IconName;
  title: string;
  onClick?: (event: ReactMouseEvent<HTMLButtonElement>) => void;
  active?: boolean;
  disabled?: boolean;
  className?: string;
  expanded?: boolean;
  hasPopup?: boolean;
}) {
  return (
    <button type="button" title={title} aria-label={title} onClick={onClick} disabled={disabled}
      aria-expanded={hasPopup ? expanded : undefined} aria-haspopup={hasPopup ? 'menu' : undefined}
      className={className}
      style={{ background: active ? theme.panelAlt : 'none', border: 'none', cursor: disabled ? 'default' : 'pointer', padding: '4px 5px', borderRadius: 4, display: 'flex', alignItems: 'center', gap: 2, lineHeight: 0, color: disabled ? theme.textDim : active ? theme.text : theme.textDim, opacity: disabled ? 0.45 : 1, flexShrink: 0 }}
      onMouseEnter={(event) => { if (!disabled) event.currentTarget.style.color = theme.text; }}
      onMouseLeave={(event) => { event.currentTarget.style.color = disabled ? theme.textDim : active ? theme.text : theme.textDim; }}>
      <Icon name={icon} size={16} />
    </button>
  );
}

export function ComposerToolbar({
  mode, activeModel, activeSkillName, contextLabel, contextTitle, contextNearLimit,
  pop, selecting, enhancing, running, canEnhance, canSend, sendTitle, onTogglePop,
  onToggleSelecting, onEnhance, onSubmit, onStop,
}: ToolbarProps) {
  const t = useT();
  const secondaryActive = selecting || !!activeSkillName
    || pop === 'settings' || pop === 'assets' || pop === 'skill' || pop === 'templates';
  return (
    <div className="cc-chat-composer-bar">
      <div className="cc-chat-composer-bar-tools">
        <button title={t('模式')} onClick={(event) => onTogglePop('mode', event.currentTarget)}
          className="cc-chat-mode-btn"
          style={{ height: 28, display: 'flex', alignItems: 'center', gap: 3, padding: '0 3px', border: 0, borderRadius: 6, background: pop === 'mode' ? theme.panelAlt : 'transparent', color: theme.text, cursor: 'pointer', fontSize: 12, flexShrink: 0 }}>
          <Icon name="sparkles" size={15} /><span className="cc-chat-mode-label">{mode === 'agent' ? 'Agent' : 'Q&A'}</span><Icon name="chevronDown" size={11} />
        </button>
        <button type="button" className="cc-chat-model-btn"
          disabled={running}
          title={activeModel
            ? `${t('当前模型：{name}', { name: `${activeModel.providerLabel} · ${activeModel.model}` })} · ${contextTitle}`
            : t('选择模型')}
          onClick={(event) => onTogglePop('model', event.currentTarget)}
          style={{ height: 28, minWidth: 0, maxWidth: 196, display: 'flex', alignItems: 'center', gap: 4, padding: '0 6px', border: 0, borderRadius: 4, background: pop === 'model' ? theme.panel : 'transparent', color: contextNearLimit ? theme.gold : theme.textDim, cursor: running ? 'default' : 'pointer', fontSize: 11, flexShrink: 1 }}>
          {activeModel?.backend === 'codex' ? (
            <img src={codexPng} alt="" aria-hidden style={{ width: 15, height: 15, borderRadius: 4, objectFit: 'contain', flex: '0 0 auto' }} />
          ) : activeModel?.backend === 'copilot' ? (
            <Icon name="github" size={13} />
          ) : (
            <Icon name="cloud" size={13} />
          )}
          <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{activeModel?.model ?? t('模型')}</span>
          {contextLabel && <span style={{ fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap', fontSize: 10 }}>{contextLabel}</span>}
          <Icon name="chevronDown" size={10} />
        </button>
        <span className="cc-composer-secondary">
          <BarBtn icon="sliders" title={t('设置')} active={pop === 'settings'} onClick={(event) => onTogglePop('settings', event.currentTarget)} />
          <BarBtn icon="cursor" title={t('选择模式：点片段 / 拖画布 / 选文字稿作为引用')} active={selecting} onClick={onToggleSelecting} />
          <BarBtn icon="plus" title={t('引用媒体池素材')} active={pop === 'assets'} onClick={(event) => onTogglePop('assets', event.currentTarget)} />
          <BarBtn icon="wand" title={activeSkillName ? t('创作模式：{name}', { name: activeSkillName }) : t('创作模式')} active={pop === 'skill' || !!activeSkillName} onClick={(event) => onTogglePop('skill', event.currentTarget)} />
          <BarBtn icon="bookOpen" title={t('引用模板库')} active={pop === 'templates'} onClick={(event) => onTogglePop('templates', event.currentTarget)} />
          <BarBtn icon="sparkles" title={enhancing ? t('增强中…') : t('增强提示词')} disabled={!canEnhance} onClick={onEnhance} />
        </span>
        <BarBtn icon="more" title={t('更多工具')} className="cc-composer-more-btn"
          active={pop === 'more' || secondaryActive}
          expanded={pop === 'more'} hasPopup
          onClick={(event) => onTogglePop('more', event.currentTarget)} />
      </div>
      {running ? (
        <button title={t('停止')} onClick={onStop} className="cc-chat-send-btn"
          style={{ width: 28, height: 28, borderRadius: '50%', border: 'none', background: theme.accent, cursor: 'pointer', display: 'grid', placeItems: 'center', flexShrink: 0 }}>
          <span style={{ width: 10, height: 10, background: theme.onAccent, borderRadius: 2 }} />
        </button>
      ) : (
        <button title={sendTitle} onClick={onSubmit} disabled={!canSend} className="cc-chat-send-btn"
          style={{ width: 28, height: 28, borderRadius: '50%', border: 'none', background: canSend ? theme.accent : theme.border, color: canSend ? theme.onAccent : theme.textDim, cursor: canSend ? 'pointer' : 'default', display: 'grid', placeItems: 'center', lineHeight: 0, flexShrink: 0 }}>
          <Icon name="arrowUp" size={16} strokeWidth={2.2} />
        </button>
      )}
    </div>
  );
}

interface MoreMenuProps {
  selecting: boolean;
  activeSkillName?: string;
  canEnhance: boolean;
  enhancing: boolean;
  onChoosePopover: (pop: Exclude<ComposerPopover, 'mode' | 'model' | 'more' | null>) => void;
  onToggleSelecting: () => void;
  onEnhance: () => void;
  onClose: () => void;
}

function MoreItem({ icon, label, active, disabled, onClick }: {
  icon: IconName; label: string; active?: boolean; disabled?: boolean; onClick: () => void;
}) {
  return (
    <button type="button" role="menuitem" className="cc-composer-more-item" disabled={disabled} onClick={onClick}>
      <Icon name={icon} size={15} />
      <span>{label}</span>
      {active && <Icon name="check" size={12} />}
    </button>
  );
}

export function ComposerMoreMenu({
  selecting, activeSkillName, canEnhance, enhancing,
  onChoosePopover, onToggleSelecting, onEnhance, onClose,
}: MoreMenuProps) {
  const t = useT();
  const run = (action: () => void) => { onClose(); action(); };
  return (
    <div className="cc-composer-more-menu" role="menu">
      <MoreItem icon="sliders" label={t('设置')} onClick={() => onChoosePopover('settings')} />
      <MoreItem icon="cursor" label={t('选择引用')} active={selecting} onClick={() => run(onToggleSelecting)} />
      <MoreItem icon="plus" label={t('引用媒体池素材')} onClick={() => onChoosePopover('assets')} />
      <MoreItem icon="wand" label={activeSkillName ? t('创作模式：{name}', { name: activeSkillName }) : t('创作模式')}
        active={!!activeSkillName} onClick={() => onChoosePopover('skill')} />
      <MoreItem icon="bookOpen" label={t('引用模板库')} onClick={() => onChoosePopover('templates')} />
      <MoreItem icon="sparkles" label={enhancing ? t('增强中…') : t('增强提示词')}
        disabled={!canEnhance} onClick={() => run(onEnhance)} />
    </div>
  );
}
