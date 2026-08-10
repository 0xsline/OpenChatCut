// Storage migration dialog: move the project store from JSON files to a
// single SQLite database. User-initiated only; the JSON directory stays
// read-only forever afterwards. Visual vocabulary follows MediaCleanupDialog.
import { useCallback, useEffect, useState } from 'react';
import { useT } from '../../i18n/locale';
import { theme, themeAlpha } from '../../theme';
import { Icon } from '../icons';
import { fetchWithEditorSession } from '../../persist/projectStoreTransport';
import { loadMigrationStatus, STORAGE_MIGRATED_EVENT, type MigrationStatus } from './storageMigration';

interface MigrateResponse {
  summary?: { imported: number; skipped: number; quarantined: number };
  enabled?: boolean;
  error?: string;
}

const overlay: React.CSSProperties = {
  position: 'fixed', inset: 0, zIndex: 120, background: themeAlpha.shadow(0.55),
  display: 'grid', placeItems: 'center',
};
const panel: React.CSSProperties = {
  width: 480, maxWidth: 'calc(100vw - 48px)', maxHeight: 'calc(100vh - 96px)',
  display: 'flex', flexDirection: 'column',
  background: theme.panel, border: `0.5px solid ${theme.borderLight}`, borderRadius: 6,
  boxShadow: `0 24px 64px ${themeAlpha.shadow(0.5)}`, color: theme.text,
};
const head: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 8, padding: '14px 16px',
  borderBottom: `0.5px solid ${theme.border}`,
};
const title: React.CSSProperties = { fontSize: 13.5, fontWeight: 600 };
const sub: React.CSSProperties = { color: theme.textDim, fontSize: 12 };
const miniBtn: React.CSSProperties = {
  background: 'none', border: 'none', color: theme.textDim, cursor: 'pointer',
  fontSize: 13, padding: '2px 6px', borderRadius: 5, marginLeft: 'auto',
};
const body: React.CSSProperties = { padding: '12px 16px', overflowY: 'auto' };
const stateRow: React.CSSProperties = {
  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
  padding: '5px 0', fontSize: 12.5,
};
const stateLabel: React.CSSProperties = { color: theme.textMuted };
const stateValue: React.CSSProperties = { fontWeight: 550 };
const notice: React.CSSProperties = {
  color: theme.textDim, fontSize: 12.5, lineHeight: 1.6, margin: '10px 0 4px',
};
const warnLine: React.CSSProperties = { color: theme.gold, fontSize: 12.5, lineHeight: 1.6, marginTop: 4 };
const message: React.CSSProperties = { fontSize: 12.5, padding: '2px 0 6px' };
const footer: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 10, justifyContent: 'flex-end',
  padding: '12px 16px', borderTop: `0.5px solid ${theme.border}`,
};
const secondaryBtn: React.CSSProperties = {
  background: 'transparent', border: `0.5px solid ${theme.border}`, color: theme.text,
  cursor: 'pointer', fontSize: 12.5, padding: '6px 14px', borderRadius: 4,
};
const primaryBtn: React.CSSProperties = {
  background: theme.accent, border: 'none', color: theme.onAccent, cursor: 'pointer',
  fontSize: 12.5, padding: '6px 14px', borderRadius: 4,
};
const primaryBtnDisabled: React.CSSProperties = { ...primaryBtn, opacity: 0.5, cursor: 'default' };

export function StorageMigrationDialog({ onClose }: { onClose: () => void }) {
  const t = useT();
  const [status, setStatus] = useState<MigrationStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setStatus(await loadMigrationStatus());
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const migrate = async () => {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const response = await fetchWithEditorSession('/api/project-store/migrate', { method: 'POST' });
      const body = await response.json() as MigrateResponse;
      if (!response.ok) {
        setError(body.error ?? t('迁移失败'));
        return;
      }
      setResult(t('已迁移 {imported} 个数据键，跳过 {skipped} 个', {
        imported: body.summary?.imported ?? 0,
        skipped: body.summary?.skipped ?? 0,
      }));
      // Let the dashboard banner re-check and hide itself.
      window.dispatchEvent(new Event(STORAGE_MIGRATED_EVENT));
      setStatus(await loadMigrationStatus());
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const migrated = status?.enabled === true;

  return (
    <div style={overlay} onMouseDown={onClose}>
      <div style={panel} onMouseDown={(e) => e.stopPropagation()}>
        <div style={head}>
          <span style={{ color: theme.accent, display: 'inline-flex' }}><Icon name="database" size={15} /></span>
          <b style={title}>{t('数据存储')}</b>
          <span style={sub}>{t('工程数据存储方式')}</span>
          <button type="button" onClick={onClose} style={miniBtn} title={t('关闭')}>✕</button>
        </div>

        <div style={body}>
          {status && (
            <div>
              <div style={stateRow}>
                <span style={stateLabel}>{t('当前存储')}</span>
                <b style={{ ...stateValue, color: migrated ? theme.success : undefined }}>
                  {migrated ? t('SQLite 数据库') : t('JSON 文件目录')}
                </b>
              </div>
              <div style={stateRow}>
                <span style={stateLabel}>{t('本地数据键')}</span>
                <span style={stateValue}>{status.jsonKeyCount}</span>
              </div>
              {status.receipt && (
                <div style={stateRow}>
                  <span style={stateLabel}>{t('迁移时间')}</span>
                  <span>{new Date(status.receipt.importedAt).toLocaleString()}</span>
                </div>
              )}
              {status.sqliteKeyCount > 0 && (
                <div style={stateRow}>
                  <span style={stateLabel}>{t('SQLite 键数')}</span>
                  <span>{status.sqliteKeyCount}</span>
                </div>
              )}
            </div>
          )}

          <div style={notice}>
            {t('迁移后，工程数据保存到单一 SQLite 数据库文件：写入更可靠（事务）、加载更快、支持全文搜索。原始 JSON 文件将【只读保留】，旧版本、回滚与数据救援始终可用。')}
            <div style={warnLine}>
              {t('迁移后新编辑写入 SQLite；如需回滚到旧版本，迁移后新增的编辑不会出现在旧版本中。')}
            </div>
          </div>

          {error && <div style={{ ...message, color: theme.danger }}>{error}</div>}
          {result && <div style={{ ...message, color: theme.success }}>{result}</div>}
        </div>

        <div style={footer}>
          <button type="button" style={secondaryBtn} onClick={onClose}>{t('关闭')}</button>
          {!migrated && (
            <button
              type="button"
              style={busy ? primaryBtnDisabled : primaryBtn}
              disabled={busy}
              onClick={() => { void migrate(); }}
            >
              {busy ? t('迁移中…') : t('迁移到 SQLite')}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
