// Dashboard banner inviting the user to migrate the project store to SQLite.
// Shown only while the store is still on JSON files, hidden on failure, and
// dismissible (localStorage) — never blocks the dashboard.
import { useEffect, useState } from 'react';
import { useT } from '../../i18n/locale';
import { loadMigrationStatus, STORAGE_BANNER_DISMISS_KEY } from './storageMigration';

const bannerStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 12,
  marginBottom: 18, padding: '10px 14px',
  border: '1px solid var(--cc-border)', borderRadius: 10,
  background: 'var(--cc-bg-soft, rgba(127,127,127,.08))',
  fontSize: 13, lineHeight: 1.5,
};
const bannerBtn: React.CSSProperties = {
  padding: '6px 12px', borderRadius: 8, border: '1px solid var(--cc-border)',
  background: 'var(--cc-accent)', color: '#fff', cursor: 'pointer',
  fontWeight: 600, whiteSpace: 'nowrap',
};
const dismissBtn: React.CSSProperties = {
  padding: '6px 10px', borderRadius: 8, border: 'none', background: 'transparent',
  color: 'var(--cc-text-dim, #888)', cursor: 'pointer', whiteSpace: 'nowrap',
};

export function StorageMigrationBanner({ onOpenDialog }: { onOpenDialog: () => void }) {
  const t = useT();
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    let alive = true;
    try {
      if (localStorage.getItem(STORAGE_BANNER_DISMISS_KEY) === '1') return;
    } catch {
      return;
    }
    loadMigrationStatus()
      .then((status) => { if (alive && !status.enabled) setVisible(true); })
      .catch(() => { /* banner is optional; never surface errors */ });
    return () => { alive = false; };
  }, []);

  if (!visible) return null;

  const dismiss = () => {
    try { localStorage.setItem(STORAGE_BANNER_DISMISS_KEY, '1'); } catch { /* best effort */ }
    setVisible(false);
  };

  return (
    <div style={bannerStyle} role="status">
      <span style={{ flex: 1 }}>
        {t('可将工程数据迁移到 SQLite：写入更可靠、加载更快、支持全文搜索。原始 JSON 文件只读保留，随时可回滚。')}
      </span>
      <button type="button" style={bannerBtn} onClick={onOpenDialog}>{t('迁移到 SQLite')}</button>
      <button type="button" style={dismissBtn} onClick={dismiss}>{t('忽略')}</button>
    </div>
  );
}
