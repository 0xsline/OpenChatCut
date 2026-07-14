import { useState } from 'react';
import { theme } from '../theme';
import type { ProjectMeta } from '../persist/projectStore';
import { Icon } from './icons';

interface DashboardProps {
  projects: ProjectMeta[];
  onOpen: (id: string) => void;
  onNew: () => void;
  onRename: (id: string, name: string) => void;
  onDuplicate: (id: string) => void;
  onDelete: (id: string) => void;
}

function relTime(ms: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (s < 60) return '刚刚';
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  return `${Math.floor(s / 86400)} 天前`;
}

export function Dashboard({ projects, onOpen, onNew, onRename, onDuplicate, onDelete }: DashboardProps) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [confirmId, setConfirmId] = useState<string | null>(null);

  const startRename = (m: ProjectMeta) => { setEditingId(m.id); setDraft(m.name); setConfirmId(null); };
  const commitRename = () => {
    if (editingId && draft.trim()) onRename(editingId, draft.trim());
    setEditingId(null);
  };

  return (
    <div style={{ minHeight: '100vh', background: theme.bg, color: theme.text, fontFamily: 'system-ui, -apple-system, sans-serif' }}>
      <header style={{ height: 48, display: 'flex', alignItems: 'center', gap: 10, padding: '0 24px', borderBottom: `1px solid ${theme.border}`, background: theme.panel }}>
        <span style={{ color: theme.accent, display: 'inline-flex' }}><Icon name="sparkles" size={16} /></span>
        <b style={{ fontSize: 14 }}>ChatCut</b>
        <span style={{ color: theme.textDim, fontSize: 13 }}>· 我的工程</span>
      </header>

      <main style={{ maxWidth: 1120, margin: '0 auto', padding: '28px 24px 80px' }}>
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 18 }}>
          <h1 style={{ margin: 0, fontSize: 20, fontWeight: 700, letterSpacing: '-0.02em' }}>工程</h1>
          <span style={{ color: theme.textDim, fontSize: 12.5 }}>{projects.length} 个</span>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(232px, 1fr))', gap: 16 }}>
          <button onClick={onNew} style={newCard} title="新建工程">
            <span style={{ fontSize: 30, color: theme.textDim, lineHeight: 1 }}>＋</span>
            <span style={{ fontSize: 13, color: theme.textDim }}>新建工程</span>
          </button>

          {projects.map((m) => (
            <div key={m.id} style={card}>
              <button onClick={() => onOpen(m.id)} style={thumb} title={`打开 ${m.name}`}>
                <span style={{ color: theme.borderLight, display: 'inline-flex' }}><Icon name="play" size={26} /></span>
              </button>
              <div style={{ padding: '9px 11px', display: 'flex', flexDirection: 'column', gap: 4 }}>
                {editingId === m.id ? (
                  <input
                    autoFocus value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onBlur={commitRename}
                    onKeyDown={(e) => { if (e.key === 'Enter') commitRename(); if (e.key === 'Escape') setEditingId(null); }}
                    style={nameInput}
                  />
                ) : (
                  <div onDoubleClick={() => startRename(m)} title="双击重命名" style={{ fontSize: 13, fontWeight: 550, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{m.name}</div>
                )}
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <span style={{ fontSize: 11, color: theme.textDim, fontVariantNumeric: 'tabular-nums' }}>{relTime(m.updatedAt)}</span>
                  <div style={{ display: 'flex', gap: 2 }} className="acts">
                    {confirmId === m.id ? (
                      <button onClick={() => { onDelete(m.id); setConfirmId(null); }} style={{ ...miniBtn, color: '#f77' }} title="确认删除">确认删除</button>
                    ) : (
                      <>
                        <button onClick={() => startRename(m)} style={miniBtn} title="重命名"><Icon name="pencil" size={13} /></button>
                        <button onClick={() => onDuplicate(m.id)} style={miniBtn} title="复制"><Icon name="copy" size={13} /></button>
                        <button onClick={() => setConfirmId(m.id)} style={miniBtn} title="删除"><Icon name="trash" size={13} /></button>
                      </>
                    )}
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
      </main>
    </div>
  );
}

const newCard: React.CSSProperties = {
  aspectRatio: '16 / 11', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 8,
  border: `1px dashed ${theme.border}`, borderRadius: 10, background: 'transparent', cursor: 'pointer',
};
const card: React.CSSProperties = { border: `1px solid ${theme.border}`, borderRadius: 10, background: theme.panel, overflow: 'hidden' };
const thumb: React.CSSProperties = {
  width: '100%', aspectRatio: '16 / 9', background: theme.bg, border: 'none', borderBottom: `1px solid ${theme.border}`,
  display: 'grid', placeItems: 'center', cursor: 'pointer',
};
const nameInput: React.CSSProperties = { font: 'inherit', fontSize: 13, fontWeight: 550, background: theme.panelAlt, color: theme.text, border: `1px solid ${theme.accent}`, borderRadius: 5, padding: '2px 6px', width: '100%' };
const miniBtn: React.CSSProperties = { background: 'none', border: 'none', color: theme.textDim, cursor: 'pointer', fontSize: 12, padding: '2px 4px', borderRadius: 4, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' };
