import { useEffect, useState } from 'react';
import { theme, themeAlpha } from '../theme';
import { Icon } from './icons';
import { listExportHistory, clearExportHistory, type ExportRecord } from '../persist/exportHistoryStore';
import { t, useT } from '../i18n/locale';

// Export history. Self-contained: renders its own topbar trigger
// button AND the popover. GLOBAL history (single-user app) — loads straight from
// IDB, takes ZERO props, so it can drop into the TopBar with no wiring.

/** "just now / N minutes ago / N hours ago / N days ago"。 */
function relTime(ms: number): string {
  const diff = Math.max(0, Date.now() - ms);
  const min = Math.floor(diff / 60_000);
  if (min < 1) return t('just now');
  if (min < 60) return t('{n} minutes ago', { n: min });
  const hr = Math.floor(min / 60);
  if (hr < 24) return t('{n} hours ago', { n: hr });
  return t('{n} days ago', { n: Math.floor(hr / 24) });
}

/** bytes → "1.2 MB" / "340 KB" / "12 B" */
function fmtSize(bytes?: number): string {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes)) return '';
  if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

function meta(r: ExportRecord): string {
  const size = fmtSize(r.sizeBytes);
  return [r.format.toUpperCase(), r.codec, size].filter(Boolean).join(' · ');
}

export function ExportHistory() {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [records, setRecords] = useState<ExportRecord[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    listExportHistory().then((list) => { if (!cancelled) { setRecords(list); setLoading(false); } });
    return () => { cancelled = true; };
  }, [open]);

  const handleClear = async () => {
    await clearExportHistory();
    setRecords([]);
  };

  return (
    <>
      <button title={t('Export history')} onClick={() => setOpen(true)}
        style={{ width: 28, height: 28, background: 'none', border: 'none', cursor: 'pointer', padding: 0, borderRadius: 4, lineHeight: 0, display: 'grid', placeItems: 'center', color: theme.textDim }}
        onMouseEnter={(e) => { e.currentTarget.style.color = theme.text; e.currentTarget.style.background = theme.panelAlt; }}
        onMouseLeave={(e) => { e.currentTarget.style.color = theme.textDim; e.currentTarget.style.background = 'none'; }}>
        <Icon name="download" size={17} />
      </button>

      {open && (
        <div onClick={() => setOpen(false)} style={backdrop}>
          <div onClick={(e) => e.stopPropagation()} style={card}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '13px 16px', borderBottom: `0.5px solid ${theme.border}` }}>
              <span style={{ color: theme.accent, lineHeight: 0 }}><Icon name="download" size={17} /></span>
              <span style={{ flex: 1, fontSize: 14, fontWeight: 600 }}>{t('Export history')}</span>
              <button onClick={() => setOpen(false)} title={t('close')} style={iconBtn}><Icon name="x" size={15} /></button>
            </div>

            <div style={{ padding: 12, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 6, minHeight: 120 }}>
              {loading ? (
                <div style={emptyState}>{t('Loading…')}</div>
              ) : records.length === 0 ? (
                <div style={emptyState}>{t('No records have been exported yet')}</div>
              ) : (
                records.map((r) => (
                  <div key={r.id} style={row}>
                    <span style={{ color: theme.textDim, lineHeight: 0 }}><Icon name="clock" size={14} /></span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.name}</div>
                      <div style={{ fontSize: 11, color: theme.textDim }}>{meta(r)} · {relTime(r.createdAt)}</div>
                    </div>
                  </div>
                ))
              )}
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end', padding: '12px 16px', borderTop: `0.5px solid ${theme.border}` }}>
              <button onClick={handleClear} disabled={records.length === 0} style={{ ...ghostBtn, opacity: records.length === 0 ? 0.4 : 1, cursor: records.length === 0 ? 'default' : 'pointer' }}>
                {t('Clear history')}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

const backdrop: React.CSSProperties = {
  position: 'fixed', inset: 0, background: themeAlpha.shadow(0.55), zIndex: 60,
  display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
};
const card: React.CSSProperties = {
  width: 420, maxWidth: '100%', maxHeight: '80vh', display: 'flex', flexDirection: 'column',
    background: theme.panel, color: theme.text, border: `0.5px solid ${theme.border}`, borderRadius: 6,
  boxShadow: `0 20px 60px ${themeAlpha.shadow(0.5)}`,
};
const row: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 9, background: theme.panelAlt,
    border: `0.5px solid ${theme.border}`, borderRadius: 4, padding: '7px 10px',
};
const emptyState: React.CSSProperties = { padding: '24px 0', textAlign: 'center', fontSize: 12.5, color: theme.textDim };
const iconBtn: React.CSSProperties = { background: 'none', border: 'none', color: theme.textDim, cursor: 'pointer', padding: 3, lineHeight: 0 };
const ghostBtn: React.CSSProperties = {
  background: 'none', border: `0.5px solid ${theme.border}`, color: theme.text,
    borderRadius: 4, padding: '5px 12px', fontSize: 12.5, whiteSpace: 'nowrap',
};
