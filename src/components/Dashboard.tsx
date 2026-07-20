import { useEffect, useRef, useState } from 'react';
import { theme } from '../theme';
import { loadProject, loadProjectThumb, saveProjectThumb, type ProjectMeta } from '../persist/projectStore';
import { BrandMark, Icon, OpenChatCutWordmark } from './icons';
import { SettingsDialog } from './settings/SettingsDialog';
import { SkinPicker } from './settings/SkinPicker';
import { LocaleToggle } from './TopBar';
import { MediaCleanupDialog } from '../media/MediaCleanupDialog';
import { t, useT } from '../i18n/locale';
import { ShortcutsDialog } from '../shortcuts/ShortcutsDialog';

interface DashboardProps {
  projects: ProjectMeta[];
  onOpen: (id: string) => void;
  onNew: () => void;
  onRename: (id: string, name: string) => void;
  onDuplicate: (id: string) => void;
  onDelete: (id: string) => Promise<void>;
  /** 导出工程为 .ccproj.json(跨端迁移);返回给用户看的结果文案 */
  onExport: (id: string, name: string) => Promise<string>;
  /** 导入 .ccproj.json;返回结果文案 */
  onImport: (file: File) => Promise<string>;
}

function relTime(ms: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (s < 60) return t('刚刚');
  if (s < 3600) return t('{n} 分钟前', { n: Math.floor(s / 60) });
  if (s < 86400) return t('{n} 小时前', { n: Math.floor(s / 3600) });
  return t('{n} 天前', { n: Math.floor(s / 86400) });
}

const THUMB_RENDER_CONCURRENCY = 2;
const THUMB_RENDER_VERSION = 1;
const thumbKey = (m: ProjectMeta) => m.updatedAt + THUMB_RENDER_VERSION;

async function renderProjectPoster(m: ProjectMeta): Promise<string | null> {
  const doc = await loadProject(m.id);
  const tl = doc?.timelines.find((x) => x.id === doc.activeTimelineId) ?? doc?.timelines[0];
  if (!tl?.items?.length) return null;
  const posterItem = tl.items.filter((item) => item.kind !== 'audio')
    .sort((a, b) => b.durationInFrames - a.durationInFrames)[0];
  if (!posterItem) return null;
  const posterFrame = posterItem.startFrame + Math.floor(posterItem.durationInFrames / 2);
  const res = await fetch('/render-still', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ state: tl, frames: [posterFrame], grid: false }),
  });
  if (!res.ok) return null;
  const json = (await res.json()) as { frames?: { base64?: string }[] };
  const b64 = json.frames?.[0]?.base64;
  return b64 ? `data:image/jpeg;base64,${b64}` : null;
}

export function Dashboard({ projects, onOpen, onNew, onRename, onDuplicate, onDelete, onExport, onImport }: DashboardProps) {
  const t = useT();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [cleanupOpen, setCleanupOpen] = useState(false);
  const [note, setNote] = useState<string | null>(null);  // 导入/导出结果的轻提示
  const [busy, setBusy] = useState(false);                // 大素材 base64 化耗时,防连点
  const fileRef = useRef<HTMLInputElement>(null);

  // 工程卡海报帧:先并行显示缓存(过期缓存也先用),再用两个后台任务刷新。
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  const renderingRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    let alive = true;
    void (async () => {
      const active = projects.filter((m) => !m.deletedAt);
      const cached = await Promise.all(active.map(async (m) => ({ m, thumb: await loadProjectThumb(m.id) })));
      if (!alive) return;
      const immediate = Object.fromEntries(cached.filter(({ m, thumb }) => thumb?.key === thumbKey(m))
        .map((entry) => [entry.m.id, entry.thumb!.dataUrl]));
      setThumbs(immediate);

      const queue = cached.filter(({ m, thumb }) =>
        thumb?.key !== thumbKey(m) && !renderingRef.current.has(`${m.id}@${thumbKey(m)}`));
      let cursor = 0;
      const worker = async () => {
        while (alive) {
          const entry = queue[cursor++];
          if (!entry) return;
          const key = thumbKey(entry.m);
          const cacheKey = `${entry.m.id}@${key}`;
          renderingRef.current.add(cacheKey);
          try {
            const dataUrl = await renderProjectPoster(entry.m);
            if (!dataUrl) continue;
            await saveProjectThumb(entry.m.id, key, dataUrl);
            if (alive) setThumbs((prev) => ({ ...prev, [entry.m.id]: dataUrl }));
          } catch { /* 保留旧图或占位 */ } finally {
            renderingRef.current.delete(cacheKey);
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(THUMB_RENDER_CONCURRENCY, queue.length) }, worker));
    })();
    return () => { alive = false; };
  }, [projects]);

  const startRename = (m: ProjectMeta) => { setEditingId(m.id); setDraft(m.name); setConfirmId(null); };
  const commitRename = () => {
    if (editingId && draft.trim()) onRename(editingId, draft.trim());
    setEditingId(null);
  };

  const runTransfer = async (work: Promise<string>) => {
    setBusy(true);
    setNote(t('处理中…'));
    try {
      setNote(await work);
    } catch (err) {
      setNote(t('失败:{error}', { error: err instanceof Error ? err.message : String(err) }));
    } finally {
      setBusy(false);
    }
  };
  const pickImport = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';  // 同一文件可重复选
    if (file) void runTransfer(onImport(file));
  };

  return (
    // 全局 html/body/#root 都是 overflow:hidden(编辑器需要),仪表盘自己开滚动:
    // header 固定,main 是唯一的纵向滚动容器,工程多时最后一行也能滚出来。
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column', background: theme.bg, color: theme.text, fontFamily: 'system-ui, -apple-system, sans-serif' }}>
      <header style={{ height: 48, flex: '0 0 auto', display: 'flex', alignItems: 'center', gap: 10, padding: '0 24px', borderBottom: `0.5px solid ${theme.border}`, background: theme.panel }}>
        <BrandMark size={20} />
        <OpenChatCutWordmark />
        <span style={{ color: theme.textDim, fontSize: 13 }}>{t('· 我的工程')}</span>
        <span style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 2 }}>
          <button onClick={() => setShortcutsOpen(true)} title={t('编辑快捷键')} className="cc-header-btn" style={settingsBtn}>
            <Icon name="keyboard" size={16} />
          </button>
          <LocaleToggle />
          <SkinPicker />
          <button onClick={() => setSettingsOpen(true)} title={t('设置 · API 密钥')} className="cc-header-btn" style={settingsBtn}>
            <Icon name="sliders" size={16} />
          </button>
        </span>
      </header>

      <main style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
       <div style={{ maxWidth: 1120, margin: '0 auto', padding: '28px 24px 80px' }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 18 }}>
          <h1 style={{ margin: 0, fontSize: 20, fontWeight: 700, letterSpacing: '-0.02em' }}>{t('工程')}</h1>
          {note && <span style={{ color: theme.textDim, fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{note}</span>}
          <span style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 10 }}>
            <button onClick={() => setCleanupOpen(true)} style={importBtn} title={t('清理所有工程都不引用的上传素材(测试/已删工程残留)')}>
              <Icon name="trash" size={13} /> {t('清理素材')}
            </button>
            <button onClick={() => fileRef.current?.click()} disabled={busy} style={importBtn} title={t('导入 .ccproj.json 工程文件(含素材;可来自浏览器版/其它机器)')}>
              <Icon name="upload" size={13} /> {t('导入工程')}
            </button>
            <input ref={fileRef} type="file" accept=".json,application/json" onChange={pickImport} style={{ display: 'none' }} />
            <span style={{ color: theme.textDim, fontSize: 12.5 }}>{t('{n} 个', { n: projects.length })}</span>
          </span>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(232px, 1fr))', alignItems: 'start', gap: 16 }}>
          <button onClick={onNew} style={newCard} title={t('新建工程')}>
            <span style={{ fontSize: 30, color: theme.textDim, lineHeight: 1 }}>＋</span>
            <span style={{ fontSize: 13, color: theme.textDim }}>{t('新建工程')}</span>
          </button>

          {projects.map((m) => (
            <div key={m.id} style={card}>
              <button onClick={() => onOpen(m.id)} style={thumb} title={t('打开 {name}', { name: m.name })}>
                {thumbs[m.id] ? (
                  <img src={thumbs[m.id]} alt="" draggable={false} loading="lazy" decoding="async"
                    style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'contain', display: 'block' }} />
                ) : (
                  <span style={{ color: theme.borderLight, display: 'inline-flex' }}><Icon name="play" size={26} /></span>
                )}
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
                  <div onDoubleClick={() => startRename(m)} title={t('双击重命名')} style={{ fontSize: 13, fontWeight: 550, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{m.name}</div>
                )}
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <span style={{ fontSize: 11, color: theme.textDim, fontVariantNumeric: 'tabular-nums' }}>{relTime(m.updatedAt)}</span>
                  <div style={{ display: 'flex', gap: 2 }} className="acts">
                    {confirmId === m.id ? (
                      <button
                        onClick={() => {
                          void runTransfer(onDelete(m.id).then(() => t('已永久删除「{name}」', { name: m.name })));
                          setConfirmId(null);
                        }}
                        disabled={busy}
                        style={{ ...miniBtn, color: '#f77' }}
                        title={t('彻底删除工程,并清掉只有它引用的素材文件')}
                      >
                        {t('确认删除')}
                      </button>
                    ) : (
                      <>
                        <button onClick={() => startRename(m)} style={miniBtn} title={t('重命名')}><Icon name="pencil" size={13} /></button>
                        <button onClick={() => onDuplicate(m.id)} style={miniBtn} title={t('复制')}><Icon name="copy" size={13} /></button>
                        <button onClick={() => void runTransfer(onExport(m.id, m.name))} disabled={busy} style={miniBtn} title={t('导出为 .ccproj.json(含素材,可在桌面版/其它机器导入)')}><Icon name="download" size={13} /></button>
                        <button onClick={() => setConfirmId(m.id)} style={miniBtn} title={t('删除')}><Icon name="trash" size={13} /></button>
                      </>
                    )}
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>

       </div>
      </main>

      {settingsOpen && <SettingsDialog onClose={() => setSettingsOpen(false)} />}
      {shortcutsOpen && <ShortcutsDialog onClose={() => setShortcutsOpen(false)} />}
      {cleanupOpen && <MediaCleanupDialog onClose={() => setCleanupOpen(false)} />}
    </div>
  );
}

const newCard: React.CSSProperties = {
  width: '100%', aspectRatio: '16 / 9', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 8,
    border: `0.5px dashed ${theme.border}`, borderRadius: 4, background: 'transparent', cursor: 'pointer',
};
  const card: React.CSSProperties = { border: `0.5px solid ${theme.border}`, borderRadius: 4, background: theme.panel, overflow: 'hidden' };
const thumb: React.CSSProperties = {
  width: '100%', aspectRatio: '16 / 9', background: theme.bg, border: 'none', borderBottom: `0.5px solid ${theme.border}`,
  position: 'relative', overflow: 'hidden', display: 'grid', placeItems: 'center', cursor: 'pointer',
};
const nameInput: React.CSSProperties = { font: 'inherit', fontSize: 13, fontWeight: 550, background: theme.panelAlt, color: theme.text, border: `0.5px solid ${theme.accent}`, borderRadius: 5, padding: '2px 6px', width: '100%' };
const miniBtn: React.CSSProperties = { background: 'none', border: 'none', color: theme.textDim, cursor: 'pointer', fontSize: 12, padding: '2px 4px', borderRadius: 4, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' };
const settingsBtn: React.CSSProperties = { background: 'none', border: 'none', color: theme.textDim, cursor: 'pointer', padding: 6, borderRadius: 6, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' };
const importBtn: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12, color: theme.text,
  background: 'none', border: `0.5px solid ${theme.border}`, borderRadius: 6, padding: '4px 10px', cursor: 'pointer',
};
