import type { ReactNode } from 'react';
import { Icon } from '../components/icons';
import type { TimelineState } from '../editor/types';
import { useT } from '../i18n/locale';
import { EXPORT_TABS } from './useExportDialogModel';
import type { ExportTab } from './useExportWorkflow';

interface ExportDialogShellProps {
  base: string;
  state: TimelineState;
  busy: boolean;
  onClose: () => void;
  children: ReactNode;
}

function ExportDialogHeader({ base, state, busy, onClose }: Omit<ExportDialogShellProps, 'children'>) {
  const t = useT();
  return (
    <header className="cc-export-header">
      <div>
        <h2 id="cc-export-title">{t('导出')}</h2>
        <p>{base} · {state.width}×{state.height} · {state.fps} fps</p>
      </div>
      <button type="button" className="cc-export-close" onClick={onClose} disabled={busy} title={t('关闭')}>
        <Icon name="x" size={16} />
      </button>
    </header>
  );
}

export function ExportDialogShell({ base, state, busy, onClose, children }: ExportDialogShellProps) {
  return (
    <div className="cc-export-overlay" onClick={busy ? undefined : onClose}>
      <div
        className="cc-export-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="cc-export-title"
        onClick={(event) => event.stopPropagation()}
      >
        <ExportDialogHeader base={base} state={state} busy={busy} onClose={onClose} />
        <div className="cc-export-layout">{children}</div>
      </div>
    </div>
  );
}

interface ExportSidebarProps {
  tab: ExportTab;
  busy: boolean;
  onTabChange: (tab: ExportTab) => void;
}

export function ExportSidebar({ tab, busy, onTabChange }: ExportSidebarProps) {
  const t = useT();
  return (
    <aside className="cc-export-sidebar">
      <span className="cc-export-sidebar-label">{t('输出类型')}</span>
      <div className="cc-export-tabs" role="tablist" aria-label={t('输出类型')}>
        {EXPORT_TABS.map((entry) => (
          <button
            type="button"
            role="tab"
            aria-selected={tab === entry.key}
            aria-controls={`cc-export-content-${entry.key}`}
            id={`cc-export-tab-${entry.key}`}
            key={entry.key}
            className={`cc-export-tab${tab === entry.key ? ' active' : ''}`}
            onClick={() => onTabChange(entry.key)}
            disabled={busy}
          >
            <span className="cc-export-tab-icon"><Icon name={entry.icon} size={15} /></span>
            <span><strong>{t(entry.label)}</strong><small>{entry.summary}</small></span>
          </button>
        ))}
      </div>
    </aside>
  );
}
