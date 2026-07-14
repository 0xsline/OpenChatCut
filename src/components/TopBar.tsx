import { useState } from 'react';
import { theme } from '../theme';
import { Icon, type IconName } from './icons';

interface TopBarProps {
  projectName: string;
  credits: number;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  onExport?: () => void;
  exporting?: boolean;
  onHome?: () => void;
  onRename?: (name: string) => void;
  /** panel-layout toggle (source: collapses/expands the side panel) */
  onToggleLayout?: () => void;
  /** open the design-style (brand) editor (source manage_design_style) */
  onDesignStyle?: () => void;
  /** open the version-history (named snapshots + rollback) panel (source /api/versions) */
  onHistory?: () => void;
}

// one right-side icon button (source: monochrome lucide, hover-lit)
function TBtn({ icon, title, onClick, disabled }: { icon: IconName; title: string; onClick?: () => void; disabled?: boolean }) {
  return (
    <button title={title} onClick={onClick} disabled={disabled}
      style={{ background: 'none', border: 'none', cursor: disabled ? 'default' : 'pointer', padding: 6, borderRadius: 7, lineHeight: 0, display: 'grid', placeItems: 'center', color: theme.textDim, opacity: disabled ? 0.35 : 1 }}
      onMouseEnter={(e) => { if (!disabled) { e.currentTarget.style.color = theme.text; e.currentTarget.style.background = theme.panelAlt; } }}
      onMouseLeave={(e) => { e.currentTarget.style.color = theme.textDim; e.currentTarget.style.background = 'none'; }}>
      <Icon name={icon} size={17} />
    </button>
  );
}

export function TopBar({ projectName, credits, canUndo, canRedo, onUndo, onRedo, onExport, exporting, onHome, onRename, onToggleLayout, onDesignStyle, onHistory }: TopBarProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(projectName);
  const commit = () => { setEditing(false); if (onRename && draft.trim() && draft.trim() !== projectName) onRename(draft.trim()); };

  return (
    <header style={{ gridColumn: '1 / -1', gridRow: 1, height: 48, display: 'flex', alignItems: 'center', padding: '0 12px', borderBottom: `1px solid ${theme.border}`, background: theme.panel, gap: 6 }}>
      {/* home in a rounded chip + a vertical divider (source) */}
      <button title="返回工程列表" onClick={onHome}
        style={{ background: 'none', border: `1px solid ${theme.border}`, borderRadius: 9, cursor: onHome ? 'pointer' : 'default', padding: 7, lineHeight: 0, display: 'grid', placeItems: 'center', color: theme.textDim }}
        onMouseEnter={(e) => { if (onHome) { e.currentTarget.style.color = theme.text; e.currentTarget.style.background = theme.panelAlt; } }}
        onMouseLeave={(e) => { e.currentTarget.style.color = theme.textDim; e.currentTarget.style.background = 'none'; }}>
        <Icon name="home" size={17} />
      </button>
      <span style={{ width: 1, height: 20, background: theme.border, margin: '0 4px' }} />

      {/* center: project title + collaborators (source: users icon) */}
      <div style={{ flex: 1, display: 'flex', gap: 9, justifyContent: 'center', alignItems: 'center', fontSize: 14, color: theme.text }}>
        {editing ? (
          <input autoFocus value={draft} onChange={(e) => setDraft(e.target.value)} onBlur={commit}
            onKeyDown={(e) => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') setEditing(false); }}
            style={{ font: 'inherit', fontSize: 14, textAlign: 'center', background: theme.panelAlt, color: theme.text, border: `1px solid ${theme.accent}`, borderRadius: 5, padding: '2px 8px', minWidth: 200 }} />
        ) : (
          <span onDoubleClick={() => { if (onRename) { setDraft(projectName); setEditing(true); } }} title={onRename ? '双击重命名' : undefined} style={{ cursor: onRename ? 'text' : 'default', fontWeight: 500 }}>{projectName}</span>
        )}
        <button title="协作者" style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 3, lineHeight: 0, color: theme.textDim }}
          onMouseEnter={(e) => { e.currentTarget.style.color = theme.text; }} onMouseLeave={(e) => { e.currentTarget.style.color = theme.textDim; }}>
          <Icon name="users" size={16} />
        </button>
      </div>

      {/* right: undo · redo · history · layout · export · credits · avatar */}
      <TBtn icon="undo" title="撤销" onClick={onUndo} disabled={!canUndo} />
      <TBtn icon="redo" title="重做" onClick={onRedo} disabled={!canRedo} />
      <TBtn icon="palette" title="设计风格(品牌)" onClick={onDesignStyle} />
      <TBtn icon="history" title="历史版本" onClick={onHistory} />
      <TBtn icon="layoutPanel" title="切换面板布局" onClick={onToggleLayout} />
      <button onClick={onExport} disabled={exporting || !onExport} title="导出 MP4"
        style={{ background: theme.accent, color: '#fff', border: 'none', borderRadius: 8, padding: '6px 18px', fontSize: 13.5, fontWeight: 600, cursor: exporting || !onExport ? 'default' : 'pointer', opacity: exporting || !onExport ? 0.6 : 1, marginLeft: 4 }}>
        {exporting ? '导出中…' : '导出'}
      </button>
      <div style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 13, color: theme.text, marginLeft: 6 }} title={`剩余额度 ${credits.toFixed(1)}`}>
        <span style={{ color: theme.accent, lineHeight: 0 }}><Icon name="sparkles" size={15} /></span>
        <span style={{ fontVariantNumeric: 'tabular-nums' }}>{credits.toFixed(1)}</span>
      </div>
      <div title="账户" style={{ width: 26, height: 26, borderRadius: '50%', marginLeft: 4, background: 'conic-gradient(from 210deg, #6d6cff, #ff5f9e, #ffb35f, #6d6cff)', flexShrink: 0 }} />
    </header>
  );
}
