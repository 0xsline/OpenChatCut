// Storage migration dialog: move the project store from JSON files to a
// single SQLite database. User-initiated only — nothing happens until the
// user clicks 迁移; the JSON directory is kept read-only forever afterwards.
import { useCallback, useEffect, useState } from 'react';
import { useT } from '../../i18n/locale';
import { fetchWithEditorSession } from '../../persist/projectStoreTransport';

interface MigrationStatus {
  enabled: boolean;
  receipt: { count: number; importedAt: string } | null;
  jsonKeyCount: number;
  sqliteKeyCount: number;
}

interface MigrateResponse {
  summary?: { imported: number; skipped: number; quarantined: number };
  enabled?: boolean;
  error?: string;
}

async function loadStatus(): Promise<MigrationStatus> {
  const response = await fetchWithEditorSession('/api/project-store/migrate-status', { method: 'GET' });
  const body = await response.json() as MigrationStatus;
  return body;
}

const overlay: React.CSSProperties = {
  position: 'fixed', inset: 0, zIndex: 120, background: 'rgba(0,0,0,.45)',
  display: 'flex', alignItems: 'center', justifyContent: 'center',
};
const panel: React.CSSProperties = {
  width: 460, maxWidth: '92vw', maxHeight: '80vh', overflow: 'auto',
  background: 'var(--cc-bg)', border: '1px solid var(--cc-border)', borderRadius: 10,
  padding: 20, color: 'var(--cc-text)',
};
const btn: React.CSSProperties = {
  padding: '8px 14px', borderRadius: 8, border: '1px solid var(--cc-border)',
  background: 'var(--cc-accent)', color: '#fff', cursor: 'pointer', fontWeight: 600,
};
const btnDisabled: React.CSSProperties = { ...btn, opacity: 0.5, cursor: 'default' };
const row: React.CSSProperties = { display: 'flex', justifyContent: 'space-between', padding: '6px 0' };
const ok = { color: 'var(--cc-success, #2e7d32)' };
const warn = { color: 'var(--cc-warn, #b26a00)' };

export function StorageMigrationDialog({ onClose }: { onClose: () => void }) {
  const t = useT();
  const [status, setStatus] = useState<MigrationStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setStatus(await loadStatus());
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
      setStatus(await loadStatus());
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
        <h3 style={{ marginTop: 0 }}>{t('数据存储')}</h3>

        {status && (
          <div>
            <div style={row}>
              <span>{t('当前存储')}</span>
              <b style={migrated ? ok : undefined}>{migrated ? t('SQLite 数据库') : t('JSON 文件目录')}</b>
            </div>
            <div style={row}>
              <span>{t('本地数据键')}</span>
              <span>{status.jsonKeyCount}</span>
            </div>
            {status.receipt && (
              <div style={row}>
                <span>{t('迁移时间')}</span>
                <span>{new Date(status.receipt.importedAt).toLocaleString()}</span>
              </div>
            )}
            {status.sqliteKeyCount > 0 && (
              <div style={row}>
                <span>{t('SQLite 键数')}</span>
                <span>{status.sqliteKeyCount}</span>
              </div>
            )}
          </div>
        )}

        <div style={{ margin: '14px 0', padding: '10px 12px', border: '1px solid var(--cc-border)', borderRadius: 8, fontSize: 12, lineHeight: 1.6 }}>
          {t('迁移后，工程数据保存到单一 SQLite 数据库文件：写入更可靠（事务）、加载更快、支持全文搜索。原始 JSON 文件将【只读保留】，旧版本、回滚与数据救援始终可用。')}
          <div style={{ marginTop: 6 }}>
            <b style={warn}>{t('迁移后新编辑写入 SQLite；如需回滚到旧版本，迁移后新增的编辑不会出现在旧版本中。')}</b>
          </div>
        </div>

        {error && <div style={{ color: 'var(--cc-danger, #c62828)', marginBottom: 10, fontSize: 13 }}>{error}</div>}
        {result && <div style={{ ...ok, marginBottom: 10, fontSize: 13 }}>{result}</div>}

        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
          <button type="button" style={{ padding: '8px 14px', borderRadius: 8, border: '1px solid var(--cc-border)', background: 'transparent', color: 'var(--cc-text)', cursor: 'pointer' }} onClick={onClose}>
            {t('关闭')}
          </button>
          {!migrated && (
            <button
              type="button"
              style={busy ? btnDisabled : btn}
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
