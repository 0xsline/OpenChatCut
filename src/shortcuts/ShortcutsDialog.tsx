import { useEffect, useState } from 'react';
import { theme } from '../theme';
import { getLocale, useT } from '../i18n/locale';
import { SHORTCUT_GROUPS, type ShortcutAction } from './catalog';
import { Icon } from '../components/icons';
import {
  effectiveCatalog, subscribeKeymap, isCustomized, customizedCount,
  setBinding, resetBinding, resetAllBindings, chordFromEvent, findConflicts,
} from './keymap';

interface ShortcutsDialogProps {
  onClose: () => void;
}

const IS_MAC = typeof navigator !== 'undefined' && /Mac/.test(navigator.platform);
const showKeys = (keys: string): string => keys.replace(/Mod/g, IS_MAC ? '⌘' : 'Ctrl');

interface Pending { id: string; keys: string; conflicts: ShortcutAction[] }

/** Keyboard shortcut settings — click a binding to rebind it (persisted to localStorage),
 *  with conflict detection. Reset one action or the full default preset. */
export function ShortcutsDialog({ onClose }: ShortcutsDialogProps) {
  const t = useT();
  // 快捷键目录自带官方英文 label,英文态直接用它,不再进词典重复一份。
  const en = getLocale() === 'en';
  const actionLabel = (a: Pick<ShortcutAction, 'label' | 'labelZh'>): string => (en ? a.label : a.labelZh);
  const [, bump] = useState(0);
  const [capturingId, setCapturingId] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  useEffect(() => subscribeKeymap(() => bump((n) => n + 1)), []);

  // Escape closes the dialog (only when not mid-capture — capture handles its own Escape).
  useEffect(() => {
    if (capturingId) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); onClose(); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, capturingId]);

  // Capture-phase listener grabs the next chord and stops it from firing the real shortcut.
  useEffect(() => {
    if (!capturingId) return;
    const onCapture = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape') { setCapturingId(null); return; }
      const keys = chordFromEvent(e);
      if (!keys) return; // bare modifier — keep waiting
      const conflicts = findConflicts(effectiveCatalog(), capturingId, keys);
      if (conflicts.length) { setPending({ id: capturingId, keys, conflicts }); setCapturingId(null); }
      else { setBinding(capturingId, keys); setCapturingId(null); }
    };
    window.addEventListener('keydown', onCapture, true);
    return () => window.removeEventListener('keydown', onCapture, true);
  }, [capturingId]);

  const catalog = effectiveCatalog();
  const startCapture = (id: string) => { setPending(null); setCapturingId(id); };

  return (
    <div
      role="dialog"
      aria-label={t('键盘快捷键')}
      style={{ position: 'fixed', inset: 0, zIndex: 200, background: 'rgba(0,0,0,0.55)', display: 'grid', placeItems: 'center', padding: 24 }}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 'min(720px, 100%)', maxHeight: 'min(80vh, 640px)', overflow: 'hidden',
          display: 'flex', flexDirection: 'column',
      background: theme.panel, border: `0.5px solid ${theme.borderLight}`, borderRadius: 6, boxShadow: '0 18px 48px rgba(0,0,0,0.55)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '14px 16px', borderBottom: `0.5px solid ${theme.border}` }}>
          <Icon name="bookOpen" size={18} />
          <b style={{ fontSize: 14, flex: 1 }}>{t('键盘快捷键')}</b>
          <span style={{ fontSize: 11, color: theme.textDim }}>{t('点击快捷键可改绑')}</span>
          {customizedCount() > 0 && (
            <button type="button" onClick={() => { setCapturingId(null); setPending(null); resetAllBindings(); }}
              style={{ fontSize: 11, color: theme.accent, background: 'none', border: `0.5px solid ${theme.border}`, borderRadius: 6, padding: '3px 8px', cursor: 'pointer' }}>
              {t('全部重置')}
            </button>
          )}
          <button type="button" onClick={onClose} title={t('关闭')} style={{ background: 'none', border: 'none', cursor: 'pointer', color: theme.textDim, padding: 4, display: 'grid' }}>
            <Icon name="x" size={16} />
          </button>
        </div>
        <div style={{ overflowY: 'auto', padding: '8px 12px 16px' }}>
          {SHORTCUT_GROUPS.map((g) => {
            const rows = catalog.filter((a) => a.group === g.id && a.keys.trim());
            if (!rows.length) return null;
            return (
              <div key={g.id} style={{ marginTop: 12 }}>
                <div style={{ fontSize: 11, color: theme.textDim, letterSpacing: 0.4, margin: '0 4px 6px' }}>{en ? g.label : `${g.labelZh} · ${g.label}`}</div>
                <div style={{ display: 'grid', gap: 2 }}>
                  {rows.map((a) => {
                    const capturing = capturingId === a.id;
                    const conflicting = pending?.id === a.id;
                    return (
            <div key={a.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '7px 10px', borderRadius: 3, background: theme.panelAlt }}>
                        <span style={{ flex: 1, fontSize: 12.5 }}>{actionLabel(a)}</span>
                        {isCustomized(a.id) && !capturing && (
                          <button type="button" title={t('恢复默认')} onClick={() => resetBinding(a.id)}
                            style={{ background: 'none', border: 'none', cursor: 'pointer', color: theme.textDim, padding: 2, display: 'grid' }}>
                            <Icon name="undo" size={13} />
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => startCapture(a.id)}
                          title={t('点击改绑')}
                          style={{
                            fontSize: 11, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                            color: capturing ? theme.accent : theme.text,
                            background: theme.bg, border: `0.5px solid ${capturing ? theme.accent : theme.border}`,
                            borderRadius: 6, padding: '2px 8px', whiteSpace: 'nowrap', cursor: 'pointer', minWidth: 90, textAlign: 'center',
                          }}
                        >
                          {capturing ? t('按下按键… (Esc)') : showKeys(a.keys)}
                        </button>
                        {conflicting && pending && (
      <div style={{ position: 'absolute', right: 24, marginTop: 40, zIndex: 1, background: theme.panel, border: `0.5px solid ${theme.accent}`, borderRadius: 4, padding: 10, boxShadow: '0 8px 24px #000a', maxWidth: 300 }}>
                            <div style={{ fontSize: 11.5, marginBottom: 6 }}>
                              <b>{showKeys(pending.keys)}</b> {t('已被占用：')}{pending.conflicts.map(actionLabel).join(en ? ', ' : '、')}
                            </div>
                            <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                              <button type="button" onClick={() => setPending(null)} style={{ fontSize: 11, background: 'none', border: `0.5px solid ${theme.border}`, borderRadius: 6, padding: '3px 8px', color: theme.text, cursor: 'pointer' }}>{t('取消')}</button>
                              <button type="button" onClick={() => { setBinding(pending.id, pending.keys); setPending(null); }} style={{ fontSize: 11, background: theme.accent, border: 'none', borderRadius: 6, padding: '3px 8px', color: theme.onAccent, cursor: 'pointer' }}>{t('仍要绑定')}</button>
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
