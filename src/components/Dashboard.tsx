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
  /** Export the project as .ccproj.json(Cross-end migration);Result copy returned to the user */
  onExport: (id: string, name: string) => Promise<string>;
  /** import .ccproj.json;Return result copy */
  onImport: (file: File) => Promise<string>;
}

function relTime(ms: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (s < 60) return t('just now');
  if (s < 3600) return t('{n} minutes ago', { n: Math.floor(s / 60) });
  if (s < 86400) return t('{n} hours ago', { n: Math.floor(s / 3600) });
  return t('{n} days ago', { n: Math.floor(s / 86400) });
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
  const [note, setNote] = useState<string | null>(null);  // Light tips for importing/exporting results
  const [busy, setBusy] = useState(false);                // Base64 conversion of large materials is time-consuming and prevents connection points
  const fileRef = useRef<HTMLInputElement>(null);

  // Project card poster frame: first display the cache in parallel (the expired cache is also used first), and then refresh it with two background tasks.
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
          } catch { /* Keep old pictures or placeholders */ } finally {
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
    setNote(t('Processing…'));
    try {
      setNote(await work);
    } catch (err) {
      setNote(t('failed:{error}', { error: err instanceof Error ? err.message : String(err) }));
    } finally {
      setBusy(false);
    }
  };
  const pickImport = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';  // The same file can be selected repeatedly
    if (file) void runTransfer(onImport(file));
  };

  return (
    // The global html/body/#root is overflow:hidden (required by the editor), and the dashboard scrolls by itself:
    // The header is fixed, main is the only vertical scrolling container, and the last line can be scrolled out even if the project is long.
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column', background: theme.bg, color: theme.text, fontFamily: 'system-ui, -apple-system, sans-serif' }}>
      <header style={{ height: 48, flex: '0 0 auto', display: 'flex', alignItems: 'center', gap: 10, padding: '0 24px', borderBottom: `0.5px solid ${theme.border}`, background: theme.panel }}>
        <BrandMark size={20} />
        <OpenChatCutWordmark />
        <span style={{ color: theme.textDim, fontSize: 13 }}>{t('· my project')}</span>
        <span style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 2 }}>
          <button onClick={() => setShortcutsOpen(true)} title={t('Edit shortcut keys')} className="cc-header-btn" style={settingsBtn}>
            <Icon name="keyboard" size={16} />
          </button>
          <LocaleToggle />
          <SkinPicker />
          <button onClick={() => setSettingsOpen(true)} title={t('settings · API key')} className="cc-header-btn" style={settingsBtn}>
            <Icon name="sliders" size={16} />
          </button>
        </span>
      </header>

      <main style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
       <div style={{ maxWidth: 1120, margin: '0 auto', padding: '28px 24px 80px' }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 18 }}>
          <h1 style={{ margin: 0, fontSize: 20, fontWeight: 700, letterSpacing: '-0.02em' }}>{t('Engineering')}</h1>
          {note && <span style={{ color: theme.textDim, fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{note}</span>}
          <span style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 10 }}>
            <button onClick={() => setCleanupOpen(true)} style={importBtn} title={t('Clean up uploaded materials that are not referenced in all projects(test/Remains of deleted projects)')}>
              <Icon name="trash" size={13} /> {t('Clean up footage')}
            </button>
            <button onClick={() => fileRef.current?.click()} disabled={busy} style={importBtn} title={t('import .ccproj.json Project documents(Contains materials;Available from browser version/Other machines)')}>
              <Icon name="upload" size={13} /> {t('Import project')}
            </button>
            <input ref={fileRef} type="file" accept=".json,application/json" onChange={pickImport} style={{ display: 'none' }} />
            <span style={{ color: theme.textDim, fontSize: 12.5 }}>{t('{n} a', { n: projects.length })}</span>
          </span>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(232px, 1fr))', alignItems: 'start', gap: 16 }}>
          <button onClick={onNew} style={newCard} title={t('New construction')}>
            <span style={{ fontSize: 30, color: theme.textDim, lineHeight: 1 }}>＋</span>
            <span style={{ fontSize: 13, color: theme.textDim }}>{t('New construction')}</span>
          </button>

          {projects.map((m) => (
            <div key={m.id} style={card}>
              <button onClick={() => onOpen(m.id)} style={thumb} title={t('open {name}', { name: m.name })}>
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
                  <div onDoubleClick={() => startRename(m)} title={t('Double click to rename')} style={{ fontSize: 13, fontWeight: 550, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{m.name}</div>
                )}
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <span style={{ fontSize: 11, color: theme.textDim, fontVariantNumeric: 'tabular-nums' }}>{relTime(m.updatedAt)}</span>
                  <div style={{ display: 'flex', gap: 2 }} className="acts">
                    {confirmId === m.id ? (
                      <button
                        onClick={() => {
                          void runTransfer(onDelete(m.id).then(() => t('has been permanently deleted"{name}」', { name: m.name })));
                          setConfirmId(null);
                        }}
                        disabled={busy}
                        style={{ ...miniBtn, color: '#f77' }}
                        title={t('Completely delete the project,And clear only the material files it references')}
                      >
                        {t('Confirm deletion')}
                      </button>
                    ) : (
                      <>
                        <button onClick={() => startRename(m)} style={miniBtn} title={t('Rename')}><Icon name="pencil" size={13} /></button>
                        <button onClick={() => onDuplicate(m.id)} style={miniBtn} title={t('Copy')}><Icon name="copy" size={13} /></button>
                        <button onClick={() => void runTransfer(onExport(m.id, m.name))} disabled={busy} style={miniBtn} title={t('Export as .ccproj.json(Contains materials,Available in desktop version/Import from other machines)')}><Icon name="download" size={13} /></button>
                        <button onClick={() => setConfirmId(m.id)} style={miniBtn} title={t('Delete')}><Icon name="trash" size={13} /></button>
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
