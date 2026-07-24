import { useState } from 'react';
import { theme } from '../theme';
import { Icon, type IconName } from './icons';
import { ExportHistory } from './ExportHistory';
import { SkinPicker } from './settings/SkinPicker';
import { getLocale, setLocale, useT } from '../i18n/locale';
import { invokeAction } from '../shortcuts/actionRegistry';

// Language switching: The text pill displays the current language, click to switch between Chinese and English.
// The editor top bar is shared with the Dashboard top bar (exported from here).
export function LocaleToggle() {
  const t = useT();
  const locale = getLocale();
  return (
    <button
      title={t('Switch interface language')}
      aria-label={t('Switch interface language')}
      onClick={() => setLocale(locale === 'zh' ? 'en' : 'zh')}
      style={{ minWidth: 30, height: 22, background: 'none', border: `0.5px solid ${theme.border}`, borderRadius: 4, cursor: 'pointer', padding: '0 5px', fontSize: 11, fontWeight: 600, letterSpacing: 0.3, color: theme.textDim, display: 'grid', placeItems: 'center' }}
      onMouseEnter={(e) => { e.currentTarget.style.color = theme.text; e.currentTarget.style.background = theme.panelAlt; }}
      onMouseLeave={(e) => { e.currentTarget.style.color = theme.textDim; e.currentTarget.style.background = 'none'; }}>
      {locale === 'zh' ? 'in' : 'EN'}
    </button>
  );
}

interface TopBarProps {
  projectName: string;
  canUndo: boolean;
  canRedo: boolean;
  exporting?: boolean;
  onHome?: () => void;
  onRename?: (name: string) => void;
}

// one right-side icon button (monochrome lucide, hover-lit)
function TBtn({ icon, title, onClick, disabled }: { icon: IconName; title: string; onClick?: () => void; disabled?: boolean }) {
  return (
    <button title={title} onClick={onClick} disabled={disabled}
      style={{ width: 28, height: 28, background: 'none', border: 'none', cursor: disabled ? 'default' : 'pointer', padding: 0, borderRadius: 4, lineHeight: 0, display: 'grid', placeItems: 'center', color: theme.textDim, opacity: disabled ? 0.35 : 1 }}
      onMouseEnter={(e) => { if (!disabled) { e.currentTarget.style.color = theme.text; e.currentTarget.style.background = theme.panelAlt; } }}
      onMouseLeave={(e) => { e.currentTarget.style.color = theme.textDim; e.currentTarget.style.background = 'none'; }}>
      <Icon name={icon} size={17} />
    </button>
  );
}

export function TopBar({ projectName, canUndo, canRedo, exporting, onHome, onRename }: TopBarProps) {
  const t = useT();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(projectName);
  const commit = () => { setEditing(false); if (onRename && draft.trim() && draft.trim() !== projectName) onRename(draft.trim()); };

  return (
    <header style={{ gridColumn: '1 / -1', gridRow: 1, position: 'relative', height: '100%', display: 'flex', alignItems: 'center', padding: '0 6px', borderBottom: `0.5px solid ${theme.border}`, background: theme.panel, gap: 4 }}>
      {/* home in a rounded chip + a vertical divider */}
      <button title={t('Return to project list')} onClick={onHome}
        style={{ width: 28, height: 28, background: 'none', border: 'none', borderRadius: 4, cursor: onHome ? 'pointer' : 'default', padding: 0, lineHeight: 0, display: 'grid', placeItems: 'center', color: theme.textDim }}
        onMouseEnter={(e) => { if (onHome) { e.currentTarget.style.color = theme.text; e.currentTarget.style.background = theme.panelAlt; } }}
        onMouseLeave={(e) => { e.currentTarget.style.color = theme.textDim; e.currentTarget.style.background = 'none'; }}>
        <Icon name="home" size={16} />
      </button>
      <span style={{ width: 1, height: 20, background: theme.border, margin: '0 4px' }} />

      {/* center: project title(Local stand-alone no collaboration,Keep collaborators users icon) */}
      <div style={{ position: 'absolute', left: '50%', transform: 'translateX(-50%)', display: 'flex', gap: 8, justifyContent: 'center', alignItems: 'center', fontSize: 12, color: theme.text }}>
        {editing ? (
          <input autoFocus value={draft} onChange={(e) => setDraft(e.target.value)} onBlur={commit}
            onKeyDown={(e) => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') setEditing(false); }}
            style={{ font: 'inherit', fontSize: 14, textAlign: 'center', background: theme.panelAlt, color: theme.text, border: `0.5px solid ${theme.accent}`, borderRadius: 5, padding: '2px 8px', minWidth: 200 }} />
        ) : (
          <span onDoubleClick={() => { if (onRename) { setDraft(projectName); setEditing(true); } }} title={onRename ? t('Double click to rename') : undefined} style={{ cursor: onRename ? 'text' : 'default' }}>{projectName}</span>
        )}
      </div>

      <span style={{ flex: 1 }} />

      {/* right: undo · redo · shortcuts · history · layout · export · avatar */}
      <TBtn icon="undo" title={t('Cancel')} onClick={() => invokeAction('undo', undefined, 'toolbar')} disabled={!canUndo} />
      <TBtn icon="redo" title={t('Redo')} onClick={() => invokeAction('redo', undefined, 'toolbar')} disabled={!canRedo} />
      <TBtn icon="keyboard" title={t('Edit shortcut keys')} onClick={() => invokeAction('keyboard-shortcuts', undefined, 'toolbar')} />
      <TBtn icon="palette" title={t('design style(Brand)')} onClick={() => invokeAction('open-design', undefined, 'toolbar')} />
      <SkinPicker />
      <TBtn icon="history" title={t('Historical version')} onClick={() => invokeAction('open-history', undefined, 'toolbar')} />
      {/* self-contained: trigger + popover, global export history, zero props */}
      <ExportHistory />
      <LocaleToggle />
      <TBtn icon="layoutPanel" title={t('Switch panel layout')} onClick={() => invokeAction('toggle-layout', undefined, 'toolbar')} />
      <button onClick={() => invokeAction('open-export', undefined, 'toolbar')} disabled={exporting} title={t('Export MP4')}
        style={{ width: 58, height: 26, background: theme.accent, color: theme.onAccent, border: 'none', borderRadius: 2, padding: 0, fontSize: 12, fontWeight: 600, cursor: exporting ? 'default' : 'pointer', opacity: exporting ? 0.6 : 1, marginLeft: 4 }}>
        {exporting ? t('Exporting…') : t('Export')}
      </button>
      <div title={t('Account')} style={{ width: 20, height: 20, borderRadius: '50%', marginLeft: 2, background: 'conic-gradient(from 210deg, #6d6cff, #ff5f9e, #ffb35f, #6d6cff)', flexShrink: 0 }} />
    </header>
  );
}
