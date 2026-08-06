import { useState } from 'react';
import { theme } from '../theme';
import { Icon } from './icons';
import { ExportHistory } from './ExportHistory';
import { GenerationActivity } from './GenerationActivity';
import { SkinPicker } from './settings/SkinPicker';
import { McpGuideDialog } from './settings/McpGuide';
import { getLocale, setLocale, useT } from '../i18n/locale';
import { invokeAction } from '../shortcuts/actionRegistry';
import { DesktopWindowControls } from './DesktopWindowControls';
import { TopBarIconButton } from './TopBarIconButton';

// Language switching: The text pill displays the current language, click to switch between Chinese and English.
// The editor top bar is shared with the Dashboard top bar (exported from here).
export function LocaleToggle() {
  const t = useT();
  const locale = getLocale();
  return (
    <button
      className="cc-tip cc-tip-r"
      data-tip={t('切换界面语言')}
      aria-label={t('切换界面语言')}
      onClick={() => setLocale(locale === 'zh' ? 'en' : 'zh')}
      style={{ minWidth: 30, height: 22, background: 'none', border: `0.5px solid ${theme.border}`, borderRadius: 4, cursor: 'pointer', padding: '0 5px', fontSize: 11, fontWeight: 600, letterSpacing: 0.3, color: theme.textDim, display: 'grid', placeItems: 'center' }}
      onMouseEnter={(e) => { e.currentTarget.style.color = theme.text; e.currentTarget.style.background = theme.panelAlt; }}
      onMouseLeave={(e) => { e.currentTarget.style.color = theme.textDim; e.currentTarget.style.background = 'none'; }}>
      {locale === 'zh' ? '中' : 'EN'}
    </button>
  );
}

interface TopBarProps {
  projectId: string;
  projectName: string;
  canUndo: boolean;
  canRedo: boolean;
  exporting?: boolean;
  exportJobCount?: number;
  onResumeGeneration?: () => Promise<void>;
  onHome?: () => void;
  onRename?: (name: string) => void;
}

export function TopBar({ projectId, projectName, canUndo, canRedo, exporting, exportJobCount = 0, onHome, onRename, onResumeGeneration }: TopBarProps) {
  const t = useT();
  const isMacDesktop = window.openChatCutDesktop?.platform === 'darwin';
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(projectName);
  const [mcpOpen, setMcpOpen] = useState(false);
  const commit = () => { setEditing(false); if (onRename && draft.trim() && draft.trim() !== projectName) onRename(draft.trim()); };

  return (
    <header className={`cc-topbar cc-window-titlebar${isMacDesktop ? ' cc-window-titlebar--mac' : ''}`} style={{ gridColumn: '1 / -1', gridRow: 1, position: 'relative', height: '100%', display: 'flex', alignItems: 'center', padding: '0 6px', borderBottom: `0.5px solid ${theme.border}`, background: theme.panel, gap: 4 }}>
      <DesktopWindowControls />
      {/* home in a rounded chip + a vertical divider */}
      <button className="cc-tip" data-tip={t('返回工程列表')} aria-label={t('返回工程列表')} onClick={onHome}
        style={{ width: 28, height: 28, background: 'none', border: 'none', borderRadius: 4, cursor: onHome ? 'pointer' : 'default', padding: 0, lineHeight: 0, display: 'grid', placeItems: 'center', color: theme.textDim }}
        onMouseEnter={(e) => { if (onHome) { e.currentTarget.style.color = theme.text; e.currentTarget.style.background = theme.panelAlt; } }}
        onMouseLeave={(e) => { e.currentTarget.style.color = theme.textDim; e.currentTarget.style.background = 'none'; }}>
        <Icon name="home" size={16} />
      </button>
      <span style={{ width: 1, height: 20, background: theme.border, margin: '0 4px' }} />

      {/* center: project title (no collaboration on local single machine, no collaborator users icon)*/}
      <div className="cc-topbar-title" style={{ position: 'absolute', left: '50%', transform: 'translateX(-50%)', display: 'flex', gap: 8, justifyContent: 'center', alignItems: 'center', fontSize: 12, color: theme.text }}>
        {editing ? (
          <input autoFocus value={draft} onChange={(e) => setDraft(e.target.value)} onBlur={commit}
            onKeyDown={(e) => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') setEditing(false); }}
            style={{ font: 'inherit', fontSize: 14, textAlign: 'center', background: theme.panelAlt, color: theme.text, border: `0.5px solid ${theme.accent}`, borderRadius: 5, padding: '2px 8px', minWidth: 200 }} />
        ) : (
          <span onDoubleClick={() => { if (onRename) { setDraft(projectName); setEditing(true); } }} title={onRename ? t('双击重命名') : undefined} style={{ cursor: onRename ? 'text' : 'default' }}>{projectName}</span>
        )}
      </div>

      <div className="cc-topbar-actions">

      {/* right: undo · redo · shortcuts · history · layout · export · avatar */}
      <TopBarIconButton icon="undo" label={t('撤销')} onClick={() => invokeAction('undo', undefined, 'toolbar')} disabled={!canUndo} />
      <TopBarIconButton icon="redo" label={t('重做')} onClick={() => invokeAction('redo', undefined, 'toolbar')} disabled={!canRedo} />
      <TopBarIconButton icon="keyboard" label={t('编辑快捷键')} onClick={() => invokeAction('keyboard-shortcuts', undefined, 'toolbar')} />
      <TopBarIconButton icon="plug" label={t('外部 Agent 接入 (MCP)')} onClick={() => setMcpOpen(true)} />
      <span id="cc-agent-change-log-slot" style={{ display: 'contents' }} />
      <TopBarIconButton icon="palette" label={t('设计风格(品牌)')} onClick={() => invokeAction('open-design', undefined, 'toolbar')} />
      <SkinPicker />
      <GenerationActivity projectId={projectId} onResume={onResumeGeneration} />
      <TopBarIconButton icon="history" label={t('历史版本')} onClick={() => invokeAction('open-history', undefined, 'toolbar')} />
      {/* self-contained: trigger + popover, global export history, zero props */}
      <ExportHistory />
      <LocaleToggle />
      <TopBarIconButton icon="layoutPanel" label={t('切换面板布局')} onClick={() => invokeAction('toggle-layout', undefined, 'toolbar')} />
      <button onClick={() => invokeAction('open-export', undefined, 'toolbar')}
        className="cc-tip cc-tip-r"
        data-tip={exporting ? t('查看后台导出任务') : t('导出 MP4')}
        aria-label={exporting ? t('查看后台导出任务') : t('导出 MP4')}
        style={{ minWidth: 58, height: 26, background: theme.accent, color: theme.onAccent, border: 'none', borderRadius: 2, padding: '0 8px', fontSize: 12, fontWeight: 600, cursor: 'pointer', marginLeft: 4 }}>
        {exporting ? t('{n} 个导出', { n: Math.max(1, exportJobCount) }) : t('导出')}
      </button>
      <div title={t('账户')} style={{ width: 20, height: 20, borderRadius: '50%', marginLeft: 2, background: 'conic-gradient(from 210deg, #6d6cff, #ff5f9e, #ffb35f, #6d6cff)', flexShrink: 0 }} />
      </div>
      {mcpOpen && <McpGuideDialog onClose={() => setMcpOpen(false)} />}
    </header>
  );
}
