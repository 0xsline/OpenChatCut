import { useEffect, useState } from 'react';
import { theme } from '../theme';
import { Icon } from './icons';
import type { ProjectDoc } from '../editor/types';
import { listVersions, saveVersion, deleteVersion, type ProjectVersion } from '../persist/versionStore';
import { t, useT } from '../i18n/locale';

interface VersionHistoryProps {
  projectId: string;
  currentDoc: ProjectDoc;
  onRestore: (doc: ProjectDoc) => void;
  onClose: () => void;
}

/** "刚刚 / N 分钟前 / N 小时前 / N 天前"。 */
function relTime(ms: number): string {
  const diff = Math.max(0, Date.now() - ms);
  const min = Math.floor(diff / 60_000);
  if (min < 1) return t('刚刚');
  if (min < 60) return t('{n} 分钟前', { n: min });
  const hr = Math.floor(min / 60);
  if (hr < 24) return t('{n} 小时前', { n: hr });
  return t('{n} 天前', { n: Math.floor(hr / 24) });
}

/** 版本历史——具名工程快照 + 一键回滚,恢复复用原子 applyDoc。 */
export function VersionHistory({ projectId, currentDoc, onRestore, onClose }: VersionHistoryProps) {
  const t = useT();
  const [versions, setVersions] = useState<ProjectVersion[]>([]);
  const [loading, setLoading] = useState(true);
  const [savingName, setSavingName] = useState<string | null>(null); // null = 输入框隐藏

  const refresh = () => {
    listVersions(projectId).then((list) => { setVersions(list); setLoading(false); });
  };

  useEffect(() => {
    let cancelled = false;
    listVersions(projectId).then((list) => { if (!cancelled) { setVersions(list); setLoading(false); } });
    return () => { cancelled = true; };
  }, [projectId]);

  const handleSave = async () => {
    const name = (savingName ?? '').trim();
    if (!name) return;
    await saveVersion(projectId, name, currentDoc);
    setSavingName(null);
    refresh();
  };

  const handleDelete = async (id: string) => {
    await deleteVersion(projectId, id);
    refresh();
  };

  return (
    <div onClick={onClose} style={backdrop}>
      <div onClick={(e) => e.stopPropagation()} style={card}>
        {/* header */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '13px 16px', borderBottom: `0.5px solid ${theme.border}` }}>
          <span style={{ color: theme.accent, lineHeight: 0 }}><Icon name="history" size={17} /></span>
          <span style={{ flex: 1, fontSize: 14, fontWeight: 600 }}>{t('历史版本')}</span>
          <button onClick={onClose} title={t('关闭')} style={iconBtn}><Icon name="x" size={15} /></button>
        </div>

        {/* list */}
        <div style={{ padding: 12, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 6, minHeight: 120 }}>
          {loading ? (
            <div style={emptyState}>{t('加载中…')}</div>
          ) : versions.length === 0 ? (
            <div style={emptyState}>{t('还没有保存过版本')}</div>
          ) : (
            versions.map((v) => (
              <div key={v.id} style={row}>
                <span style={{ color: theme.textDim, lineHeight: 0 }}><Icon name="clock" size={14} /></span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{v.name}</div>
                  <div style={{ fontSize: 11, color: theme.textDim }}>{relTime(v.createdAt)}</div>
                </div>
                <button onClick={() => { onRestore(v.doc); onClose(); }} style={ghostBtn}>{t('恢复')}</button>
                <button onClick={() => handleDelete(v.id)} title={t('删除此版本')} style={iconBtn}><Icon name="x" size={13} /></button>
              </div>
            ))
          )}
        </div>

        {/* footer */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: '12px 16px', borderTop: `0.5px solid ${theme.border}` }}>
          {savingName !== null ? (
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <input autoFocus value={savingName} placeholder={t('版本名称')}
                onChange={(e) => setSavingName(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') handleSave(); if (e.key === 'Escape') setSavingName(null); }}
                style={textInput} />
              <button onClick={handleSave} style={primaryBtn}>{t('确定')}</button>
              <button onClick={() => setSavingName(null)} style={ghostBtn}>{t('取消')}</button>
            </div>
          ) : (
            <button onClick={() => setSavingName('')} style={primaryBtn}>{t('保存当前版本')}</button>
          )}
        </div>
      </div>
    </div>
  );
}

const backdrop: React.CSSProperties = {
  position: 'fixed', inset: 0, background: 'rgba(0,0,0,.55)', zIndex: 60,
  display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
};
const card: React.CSSProperties = {
  width: 420, maxWidth: '100%', maxHeight: '80vh', display: 'flex', flexDirection: 'column',
    background: theme.panel, color: theme.text, border: `0.5px solid ${theme.border}`, borderRadius: 6,
  boxShadow: '0 20px 60px rgba(0,0,0,.5)',
};
const row: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 9, background: theme.panelAlt,
    border: `0.5px solid ${theme.border}`, borderRadius: 4, padding: '7px 10px',
};
const emptyState: React.CSSProperties = { padding: '24px 0', textAlign: 'center', fontSize: 12.5, color: theme.textDim };
const iconBtn: React.CSSProperties = { background: 'none', border: 'none', color: theme.textDim, cursor: 'pointer', padding: 3, lineHeight: 0 };
const ghostBtn: React.CSSProperties = {
  background: 'none', border: `0.5px solid ${theme.border}`, color: theme.text,
    borderRadius: 4, padding: '5px 12px', fontSize: 12.5, cursor: 'pointer', whiteSpace: 'nowrap',
};
const primaryBtn: React.CSSProperties = {
  background: theme.accent, border: 'none', color: theme.onAccent, borderRadius: 4,
  padding: '7px 16px', fontSize: 13, fontWeight: 600, cursor: 'pointer',
};
const textInput: React.CSSProperties = {
  flex: 1, background: theme.bg, color: theme.text, border: `0.5px solid ${theme.borderLight}`,
  borderRadius: 6, padding: '7px 9px', fontSize: 13, outline: 'none', boxSizing: 'border-box',
};
