import { useEffect } from 'react';
import { theme } from '../theme';
import { SHORTCUT_CATALOG, SHORTCUT_GROUPS } from './catalog';
import { Icon } from '../components/icons';

interface ShortcutsDialogProps {
  onClose: () => void;
}

/** Read-only help sheet for the source default preset (Mod+Alt+K). */
export function ShortcutsDialog({ onClose }: ShortcutsDialogProps) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); onClose(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      role="dialog"
      aria-label="键盘快捷键"
      style={{
        position: 'fixed', inset: 0, zIndex: 200,
        background: 'rgba(0,0,0,0.55)', display: 'grid', placeItems: 'center', padding: 24,
      }}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 'min(720px, 100%)', maxHeight: 'min(80vh, 640px)', overflow: 'hidden',
          display: 'flex', flexDirection: 'column',
          background: theme.panel, border: `1px solid ${theme.borderLight}`, borderRadius: 14,
          boxShadow: '0 24px 64px rgba(0,0,0,0.55)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '14px 16px', borderBottom: `1px solid ${theme.border}` }}>
          <Icon name="bookOpen" size={18} />
          <b style={{ fontSize: 14, flex: 1 }}>键盘快捷键</b>
          <span style={{ fontSize: 11, color: theme.textDim }}>源站默认预设 · 只读</span>
          <button
            type="button"
            onClick={onClose}
            title="关闭"
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: theme.textDim, padding: 4, display: 'grid' }}
          >
            <Icon name="x" size={16} />
          </button>
        </div>
        <div style={{ overflowY: 'auto', padding: '8px 12px 16px' }}>
          {SHORTCUT_GROUPS.map((g) => {
            const rows = SHORTCUT_CATALOG.filter((a) => a.group === g.id && a.keys.trim());
            if (!rows.length) return null;
            return (
              <div key={g.id} style={{ marginTop: 12 }}>
                <div style={{ fontSize: 11, color: theme.textDim, letterSpacing: 0.4, margin: '0 4px 6px' }}>
                  {g.labelZh} · {g.label}
                </div>
                <div style={{ display: 'grid', gap: 2 }}>
                  {rows.map((a) => (
                    <div
                      key={a.id}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 12,
                        padding: '7px 10px', borderRadius: 8, background: theme.panelAlt,
                      }}
                    >
                      <span style={{ flex: 1, fontSize: 12.5 }}>{a.labelZh}</span>
                      <kbd
                        style={{
                          fontSize: 11, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                          color: theme.text, background: theme.bg, border: `1px solid ${theme.border}`,
                          borderRadius: 6, padding: '2px 8px', whiteSpace: 'nowrap',
                        }}
                      >
                        {a.keys.replace(/Mod/g, typeof navigator !== 'undefined' && /Mac/.test(navigator.platform) ? '⌘' : 'Ctrl')}
                      </kbd>
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
