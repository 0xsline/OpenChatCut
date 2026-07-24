import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from '../components/icons';
import { theme } from '../theme';
import { useT } from '../i18n/locale';
import type { MediaAsset, MediaFolder } from '../editor/types';
import { usePersistedState } from '../hooks/usePersistedState';
import { importMedia } from './upload';
import { isMediaSrcReachable } from '../persist/mediaBlobStore';
import { MgThumb } from './MgThumb';
import { durationLabel, folderPath } from './mediaPoolFormat';
import { SemanticSearchControls } from './semantic-search/SemanticSearchControls';
import type { SemanticMatch } from './semantic-search/types';
import { filterMediaAssets, type MediaSortKey, type MediaTypeFilter } from './mediaPoolFilter';
import { MobileUploadDialog } from './MobileUploadDialog';
import type { MobileUploadRecord } from './mobileUploadApi';
interface MediaPoolPanelProps {
  semanticScopeId: string;
  assets: MediaAsset[];
  folders: MediaFolder[];
  fps: number;
  onImport: (file: File, onProgress?: (ratio: number) => void) => Promise<MediaAsset>;
  onImportMobile: (record: MobileUploadRecord) => Promise<void>;
  onAddAsset: (asset: MediaAsset) => void;
  onCreateFolder: (name: string, parentId?: string) => string;
  onRenameFolder: (id: string, name: string) => void;
  onDeleteFolder: (id: string) => void;
  onMoveAssets: (ids: string[], folderId?: string) => void;
  onRenameAsset: (id: string, name: string) => void;
  onSetFavorite: (id: string, favorite: boolean) => void;
  /** Remove from pool(Two-step confirmation);The tracked clip comes with its own data copy,not affected */
  onRemoveAsset?: (id: string) => void;
  /** Relink File replaces an offline/missing asset and its clip srcs. */
  onRelinkAsset?: (id: string, next: { src: string; name?: string; durationInFrames?: number; width?: number; height?: number; kind?: MediaAsset['kind'] }) => void;
  /** Add a solid-color clip. */
  onAddSolid?: () => void;
}

type PromptState = { title: string; initialValue: string; rejectSlash?: boolean; onSubmit: (value: string) => void };
type DeleteState = { id: string; name: string; parentId?: string };
export function MediaPoolPanel({
  semanticScopeId, assets, folders, fps, onImport, onImportMobile, onAddAsset, onCreateFolder, onRenameFolder,
  onDeleteFolder, onMoveAssets, onRenameAsset, onSetFavorite, onRemoveAsset, onRelinkAsset, onAddSolid,
}: MediaPoolPanelProps) {
  const t = useT();
  const inputRef = useRef<HTMLInputElement>(null);
  const relinkInputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  /** 0..1 while uploading; null when idle / unknown */
  const [uploadRatio, setUploadRatio] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<MediaSortKey>('newest');
  const [type, setType] = useState<MediaTypeFilter>('all');
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  const [view, setView] = usePersistedState<'grid' | 'list'>('cc.mediaView', 'grid');
  const [menu, setMenu] = useState<'sort' | 'filter' | null>(null);
  const [assetMenu, setAssetMenu] = useState<string | null>(null);
  /** fixed-position menu so overflow:auto grid doesn't clip Collection/Rename/folder */
  const [assetMenuPos, setAssetMenuPos] = useState<{ top: number; left: number } | null>(null);
  // Two-step confirmation of deletion: click "Confirm Delete" for the first time, and then reopen the menu to reset it.
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [currentFolderId, setCurrentFolderId] = useState<string>();
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [promptState, setPromptState] = useState<PromptState | null>(null);
  const [promptValue, setPromptValue] = useState('');
  const [deleteState, setDeleteState] = useState<DeleteState | null>(null);
  /** Asset ids whose media failed to load and can be relinked. */
  const [missing, setMissing] = useState<Set<string>>(() => new Set());
  const [relinkTarget, setRelinkTarget] = useState<string | null>(null);
  const dirInputRef = useRef<HTMLInputElement>(null);
  const [dirBusy, setDirBusy] = useState(false);
  const [relinkMsg, setRelinkMsg] = useState<string | null>(null);
  const [showRelinkAll, setShowRelinkAll] = useState(false);
  const [semanticResults, setSemanticResults] = useState<SemanticMatch[] | null>(null);
  const [mobileUploadOpen, setMobileUploadOpen] = useState(false);
  const onSemanticResults = useCallback((matches: SemanticMatch[] | null) => setSemanticResults(matches), []);
  useEffect(() => {
    if (!assetMenu) return;
    const close = () => { setAssetMenu(null); setAssetMenuPos(null); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
      window.removeEventListener('keydown', onKey);
    };
  }, [assetMenu]);

  // Probe file-backed assets and mark them offline when unreachable.
  // Must go isMediaSrcReachable: naked HEAD to blob: (placeholder in upload) normative failure → upload
  // "Relink" is mistakenly marked while still running; it also takes into account the SPA false 200 and 405 Range fallback.
  useEffect(() => {
    let cancelled = false;
    const fileAssets = assets.filter((a) => a.kind !== 'motion-graphic' && a.src);
    void (async () => {
      const next = new Set<string>();
      await Promise.all(fileAssets.map(async (asset) => {
        if (!(await isMediaSrcReachable(asset.src))) next.add(asset.id);
      }));
      if (!cancelled) setMissing(next);
    })();
    return () => { cancelled = true; };
  }, [assets]);

  const markMissing = (id: string) => setMissing((s) => new Set(s).add(id));
  const clearMissing = (id: string) => setMissing((s) => {
    if (!s.has(id)) return s;
    const n = new Set(s);
    n.delete(id);
    return n;
  });

  const startRelink = (id: string) => {
    setRelinkTarget(id);
    requestAnimationFrame(() => relinkInputRef.current?.click());
  };

  const onRelinkPick = async (files: FileList | null) => {
    const file = files?.[0];
    const id = relinkTarget;
    setRelinkTarget(null);
    if (relinkInputRef.current) relinkInputRef.current.value = '';
    if (!file || !id || !onRelinkAsset) return;
    setBusy(true);
    setError(null);
    try {
      const next = await importMedia(file, fps);
      onRelinkAsset(id, {
        src: next.src,
        name: next.name,
        durationInFrames: next.durationInFrames,
        width: next.width,
        height: next.height,
        kind: next.kind,
      });
      clearMissing(id);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  // Batch relink: pick a folder, match each missing asset by filename, re-upload + relink
  // by searching a selected folder. Assets with no same-name file are left
  // missing. Runs sequentially so each upload/relink commits cleanly.
  const relinkFromFolder = async (files: FileList | null) => {
    if (!files?.length || !onRelinkAsset) return;
    setDirBusy(true);
    setError(null);
    setRelinkMsg(null);
    try {
      const byName = new Map<string, File>();
      for (const f of Array.from(files)) if (!byName.has(f.name)) byName.set(f.name, f);
      let relinked = 0;
      for (const asset of missingList) {
        const f = byName.get(asset.name);
        if (!f) continue;
        const next = await importMedia(f, fps);
        onRelinkAsset(asset.id, { src: next.src, name: next.name, durationInFrames: next.durationInFrames, width: next.width, height: next.height, kind: next.kind });
        clearMissing(asset.id);
        relinked++;
      }
      setRelinkMsg(relinked ? t('Relinked from folder by file name {n} materials', { n: relinked }) : t('There is no file with the same name as the missing footage in the folder'));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setDirBusy(false);
      if (dirInputRef.current) dirInputRef.current.value = '';
    }
  };

  // <input webkitdirectory> is not in React's typed props — set it on the DOM node.
  useEffect(() => {
    const el = dirInputRef.current;
    if (el) { el.setAttribute('webkitdirectory', ''); el.setAttribute('directory', ''); }
  }, []);

  const missingList = assets.filter((a) => missing.has(a.id));

  const currentFolder = folders.find((folder) => folder.id === currentFolderId);
  const childFolders = folders.filter((folder) => folder.parentId === currentFolderId);
  const { query: q, visible } = filterMediaAssets({
    assets, query, semanticResults, currentFolderId, type, favoritesOnly, sort,
  });
  const selectedAssets = assets.filter((asset) => selected.has(asset.id));

  const onPick = async (files: FileList | null) => {
    if (!files?.length) return;
    setBusy(true);
    setError(null);
    setUploadRatio(0);
    try {
      const list = Array.from(files);
      for (let i = 0; i < list.length; i += 1) {
        const file = list[i]!;
        await onImport(file, (ratio) => {
          // Multi-file: map each file's progress into a global 0..1 band.
          setUploadRatio((i + ratio) / list.length);
        });
      }
      setUploadRatio(1);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
      setUploadRatio(null);
      if (inputRef.current) inputRef.current.value = '';
    }
  };
  const openPrompt = (next: PromptState) => { setPromptValue(next.initialValue); setPromptState(next); };
  const submitPrompt = () => {
    const value = promptValue.trim();
    if (!promptState || !value) return;
    if (promptState.rejectSlash && value.includes('/')) { setError(t('Name cannot contain /')); return; }
    promptState.onSubmit(value);
    setPromptState(null);
  };
  const createFolder = () => openPrompt({
    title: 'New folder name', initialValue: '', rejectSlash: true,
    onSubmit: (name) => setCurrentFolderId(onCreateFolder(name, currentFolderId)),
  });
  const renameFolder = () => currentFolder && openPrompt({
    title: 'Rename folder', initialValue: currentFolder.name, rejectSlash: true,
    onSubmit: (name) => onRenameFolder(currentFolder.id, name),
  });
  const deleteFolder = () => {
    if (currentFolder && !assets.some((asset) => asset.folderId === currentFolder.id)
      && !folders.some((folder) => folder.parentId === currentFolder.id)) {
      setDeleteState({ id: currentFolder.id, name: currentFolder.name, parentId: currentFolder.parentId });
    }
  };
  const toggleSelected = (id: string) => setSelected((old) => {
    const next = new Set(old);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const toggleAll = () => setSelected((old) => {
    const next = new Set(old);
    const allSelected = visible.length > 0 && visible.every((asset) => next.has(asset.id));
    for (const asset of visible) { if (allSelected) next.delete(asset.id); else next.add(asset.id); }
    return next;
  });

  return (
    <div className="cc-media-pool" onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); void onPick(event.dataTransfer.files); }}>
      <input ref={inputRef} type="file" accept="video/*,image/*,audio/*,.gif,.svg,image/gif,image/svg+xml" multiple hidden onChange={(event) => onPick(event.target.files)} />
      <input ref={relinkInputRef} type="file" accept="video/*,image/*,audio/*,.gif,.svg,image/gif,image/svg+xml" hidden onChange={(event) => void onRelinkPick(event.target.files)} />
      <div className="cc-media-toolbar">
        <label className="cc-media-search">
          <Icon name="search" size={16} />
          <input aria-label={t('Search for material')} value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t('Search')} />
        </label>
        <SemanticSearchControls scopeId={semanticScopeId} assets={assets} onResultsChange={onSemanticResults} />
        <button className="cc-media-icon" aria-label={t('Upload material')} title={t('Upload material')} disabled={busy} onClick={() => inputRef.current?.click()}><Icon name="upload" size={19} /></button>
        <button className="cc-media-icon" aria-label={t('Transfer material via mobile phone')} title={t('Transfer material via mobile phone')} onClick={() => setMobileUploadOpen(true)}><Icon name="qrCode" size={19} /></button>
        {busy && uploadRatio != null && (
          <span className="cc-media-upload-pct" title={t('Uploading')} style={{ fontSize: 11, opacity: 0.75, minWidth: 36, fontVariantNumeric: 'tabular-nums' }}>
            {Math.round(uploadRatio * 100)}%
          </span>
        )}
        {onAddSolid && (
          <button className="cc-media-icon" aria-label={t('add solid color')} title={t('Add a solid color clip')} onClick={onAddSolid} style={{ fontSize: 11, fontWeight: 700 }}>{t('Color')}</button>
        )}
        <button className="cc-media-icon" aria-label={t('Create new folder')} title={t('Create new folder')} onClick={createFolder}><Icon name="folderPlus" size={20} /></button>
        <button className="cc-media-icon" aria-label={t('Toggle grid list')} title={t('Switch grid/list')} onClick={() => setView((value) => value === 'grid' ? 'list' : 'grid')}><Icon name={view === 'grid' ? 'list' : 'grid'} size={19} /></button>
        <div className="cc-media-menu-anchor">
          <button className={`cc-media-icon${menu === 'sort' ? ' active' : ''}`} aria-label={t('Material sorting')} title={t('sort')} onClick={() => setMenu((value) => value === 'sort' ? null : 'sort')}><Icon name="sort" size={19} /></button>
          {menu === 'sort' && <div className="cc-media-popover cc-media-sort-menu">
            {([['newest', 'latest import'], ['name', 'Name A–Z'], ['duration', 'duration']] as const).map(([value, label]) => <button key={value} className={sort === value ? 'selected' : ''} onClick={() => { setSort(value); setMenu(null); }}>{t(label)}</button>)}
          </div>}
        </div>
        <div className="cc-media-menu-anchor">
          <button className={`cc-media-icon${menu === 'filter' || type !== 'all' || favoritesOnly ? ' active' : ''}`} aria-label={t('Filter materials')} title={t('Filter')} onClick={() => setMenu((value) => value === 'filter' ? null : 'filter')}><Icon name="filter" size={19} /></button>
          {menu === 'filter' && <div className="cc-media-popover cc-media-filter-menu">
            {([['all', 'All'], ['video', 'video'], ['image', 'picture'], ['gif', 'GIF'], ['svg', 'SVG'], ['audio', 'Audio']] as const).map(([value, label]) => <button key={value} className={type === value ? 'selected' : ''} onClick={() => setType(value)}>{t(label)}</button>)}
            <button className={favoritesOnly ? 'selected' : ''} onClick={() => setFavoritesOnly((value) => !value)}><span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Icon name="star" size={13} filled={favoritesOnly} /> {t('Collection')}</span></button>
          </div>}
        </div>
      </div>

      {missingList.length > 0 && (
        <div className="cc-media-missing-banner" style={{
          display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
          margin: '0 10px 8px', padding: '8px 10px', borderRadius: 4,
          background: theme.panelAlt, border: `0.5px solid ${theme.border}`,
          borderLeft: `2px solid ${theme.accent}`, fontSize: 12, color: theme.textMuted,
        }}>
          <span style={{ flex: 1, minWidth: 140 }}>
            {t('Yes {n} Materials are missing or cannot be loaded. Select a folder search, or relink from within a row.', { n: missingList.length })}
          </span>
          <button
            type="button"
            onClick={() => setShowRelinkAll(true)}
            style={{
              background: theme.hover, color: theme.text, border: `0.5px solid ${theme.border}`, borderRadius: 3,
              padding: '4px 10px', fontSize: 12, fontWeight: 600, cursor: 'pointer',
            }}
          >
            {t('Relink offline footage')}
          </button>
        </div>
      )}

      {(currentFolder || childFolders.length > 0) && <div className="cc-media-breadcrumb">
        <button aria-label={t('Return to the parent folder')} disabled={!currentFolder} onClick={() => setCurrentFolderId(currentFolder?.parentId)}>←</button>
        <span>Master{currentFolder ? ` / ${folderPath(currentFolder, folders)}` : ''}</span>
        {currentFolder && <button aria-label={t('Rename folder')} onClick={renameFolder}>{t('Rename')}</button>}
        {currentFolder && <button aria-label={t('Delete empty folders')} disabled={assets.some((asset) => asset.folderId === currentFolder.id) || folders.some((folder) => folder.parentId === currentFolder.id)} onClick={deleteFolder}>{t('Delete')}</button>}
      </div>}
      {error && <div className="cc-media-error">{error}</div>}
      {busy && <div className="cc-media-status">{t('Importing material...')}</div>}

      {selectedAssets.length > 0 && <div className="cc-media-selection">
        <button onClick={toggleAll}>{visible.every((asset) => selected.has(asset.id)) ? t('Clear selection') : t('Select all')}</button>
        <span>{t('Selected {n}', { n: selectedAssets.length })}</span>
        <button onClick={() => selectedAssets.forEach(onAddAsset)}>{t('Add to timeline')}</button>
        <select aria-label={t('Move selected footage')} defaultValue="" onChange={(event) => { onMoveAssets(selectedAssets.map((asset) => asset.id), event.target.value === '__root__' ? undefined : event.target.value); setSelected(new Set()); event.target.value = ''; }}>
          <option value="" disabled>{t('Move to…')}</option><option value="__root__">Master</option>
          {folders.map((folder) => <option key={folder.id} value={folder.id}>{folderPath(folder, folders)}</option>)}
        </select>
      </div>}

      <div className={`cc-media-grid ${view}`}>
        {!q && !semanticResults && childFolders.map((folder) => <button key={folder.id} className="cc-folder-card" onClick={() => setCurrentFolderId(folder.id)}>
          <span><Icon name="folder" size={34} /></span><strong>{folder.name}</strong>
        </button>)}
        {visible.map((asset) => <div key={asset.id} className={`cc-asset-card${selected.has(asset.id) ? ' selected' : ''}${missing.has(asset.id) ? ' missing' : ''}`}>
          <div className="cc-asset-thumb-wrap">
            <button
              className="cc-asset-thumb"
              title={missing.has(asset.id) ? t('Click to relink') : t('Add to timeline:{name}', { name: asset.name })}
              onClick={() => {
                if (missing.has(asset.id) && onRelinkAsset) startRelink(asset.id);
                else onAddAsset(asset);
              }}
            >
              {view === 'list'
                ? <Icon name={asset.kind === 'audio' ? 'music' : asset.kind === 'motion-graphic' ? 'sparkles' : asset.kind === 'gif' || asset.kind === 'svg' ? 'image' : asset.kind} size={16} />
                : missing.has(asset.id)
                  ? (
                    <span style={{ display: 'grid', placeItems: 'center', gap: 4, color: theme.textMuted, fontSize: 11, padding: 8, textAlign: 'center' }}>
                      <Icon name="swap" size={22} />
                      {t('Click to relink')}
                    </span>
                  )
                  : asset.kind === 'image' || asset.kind === 'gif' || asset.kind === 'svg'
                    ? <img src={asset.src} alt={asset.name} onError={() => markMissing(asset.id)} onLoad={() => clearMissing(asset.id)} />
                    : asset.kind === 'video'
                      // preload=metadata does not decode the picture (black block), seek for a while to force the browser to draw the frame; incidentally avoid the black field of frame 0
                      ? <video src={asset.src} muted preload="metadata" onError={() => markMissing(asset.id)} onLoadedData={() => clearMissing(asset.id)}
                          onLoadedMetadata={(e) => { const v = e.currentTarget; if (Number.isFinite(v.duration) && v.duration > 0) v.currentTime = Math.min(1, v.duration / 2); }} />
                      : asset.kind === 'motion-graphic'
                        ? <MgThumb asset={asset} fps={fps} />
                        : <Icon name="music" size={42} strokeWidth={2.2} />}
            </button>
            {asset.kind === 'audio' && <span className="cc-asset-audio-mark"><Icon name="volume" size={14} /></span>}
            {(asset.kind === 'gif' || asset.kind === 'svg') && (
              <span className="cc-asset-audio-mark" style={{ left: 4, right: 'auto', fontSize: 9, fontWeight: 700, letterSpacing: 0.3 }}>
                {asset.kind.toUpperCase()}
              </span>
            )}
            <span className="cc-asset-duration">{durationLabel(asset.durationInFrames, fps)}</span>
            <input className="cc-asset-check" aria-label={t('Choose {name}', { name: asset.name })} type="checkbox" checked={selected.has(asset.id)} onChange={() => toggleSelected(asset.id)} />
            <button className="cc-asset-more" aria-label={t('management {name}', { name: asset.name })}
              onClick={(event) => {
                event.stopPropagation();
                if (assetMenu === asset.id) {
                  setAssetMenu(null);
                  setAssetMenuPos(null);
                  return;
                }
                setConfirmDeleteId(null);
                const r = event.currentTarget.getBoundingClientRect();
                const menuW = 150;
                const menuH = 150;
                const left = Math.min(window.innerWidth - menuW - 8, Math.max(8, r.right - menuW));
                // prefer below the ⋮ button; flip above if near bottom of viewport
                const below = r.bottom + 6;
                const top = below + menuH > window.innerHeight - 8
                  ? Math.max(8, r.top - menuH - 6)
                  : below;
                setAssetMenu(asset.id);
                setAssetMenuPos({ top, left });
              }}
            ><Icon name="more" size={17} /></button>
          </div>
          <button className="cc-asset-name" title={asset.name} onClick={() => onAddAsset(asset)}>{asset.name}</button>
        </div>)}
        {visible.length === 0 && childFolders.length === 0 && (
          <div className="cc-media-empty">
            {assets.length === 0 ? <><Icon name="folder" size={28} /><strong>{t('This folder is empty')}</strong><span>{t('Import media or drag footage here.')}</span></> : <span>{t('There is no material under the current filter')}</span>}
          </div>
        )}
      </div>

      {assetMenu && assetMenuPos && (() => {
        const asset = assets.find((a) => a.id === assetMenu);
        if (!asset) return null;
        return createPortal(
          <>
            <div className="cc-asset-menu-backdrop" onClick={() => { setAssetMenu(null); setAssetMenuPos(null); }} />
            <div className="cc-media-popover cc-asset-menu-portal" style={{ top: assetMenuPos.top, left: assetMenuPos.left }}
              onClick={(e) => e.stopPropagation()}>
              <button type="button" onClick={() => { onSetFavorite(asset.id, !asset.favorite); setAssetMenu(null); setAssetMenuPos(null); }}>
                {asset.favorite ? t('Cancel favorites') : t('Collection')}
              </button>
              <button type="button" onClick={() => {
                setAssetMenu(null); setAssetMenuPos(null);
                openPrompt({ title: 'Material display name', initialValue: asset.name, onSubmit: (name) => onRenameAsset(asset.id, name) });
              }}>{t('Rename')}</button>
              {onRelinkAsset && asset.kind !== 'motion-graphic' && (
                <button type="button" onClick={() => {
                  setAssetMenu(null); setAssetMenuPos(null);
                  startRelink(asset.id);
                }}>{t('Relink files')}</button>
              )}
              {onRemoveAsset && (
                <button type="button" className="danger" onClick={() => {
                  if (confirmDeleteId !== asset.id) { setConfirmDeleteId(asset.id); return; }
                  onRemoveAsset(asset.id);
                  setAssetMenu(null); setAssetMenuPos(null); setConfirmDeleteId(null);
                }}>{confirmDeleteId === asset.id ? t('Confirm deletion') : t('Delete')}</button>
              )}
              <label className="cc-asset-menu-move">
                <span>{t('move to')}</span>
                <select aria-label={t('move {name}', { name: asset.name })} value={asset.folderId ?? ''}
                  onChange={(event) => {
                    onMoveAssets([asset.id], event.target.value || undefined);
                    setAssetMenu(null); setAssetMenuPos(null);
                  }}>
                  <option value="">Master</option>
                  {folders.map((folder) => (
                    <option key={folder.id} value={folder.id}>{folderPath(folder, folders)}</option>
                  ))}
                </select>
              </label>
            </div>
          </>,
          document.body,
        );
      })()}

      {promptState && <div className="cc-modal-backdrop" role="dialog" aria-modal="true" aria-label={t(promptState.title)}>
        <form className="cc-modal" onSubmit={(event) => { event.preventDefault(); submitPrompt(); }}>
          <strong>{t(promptState.title)}</strong>
          <input autoFocus aria-label={t(promptState.title)} value={promptValue} onChange={(event) => setPromptValue(event.target.value)} />
          <div><button type="button" onClick={() => setPromptState(null)}>{t('Cancel')}</button><button type="submit" className="primary">{t('OK')}</button></div>
        </form>
      </div>}
      {deleteState && <div className="cc-modal-backdrop" role="dialog" aria-modal="true" aria-label={t('Delete empty folders')}>
        <div className="cc-modal"><strong>{t('Delete empty folders{name}」？', { name: deleteState.name })}</strong><div><button onClick={() => setDeleteState(null)}>{t('Cancel')}</button><button className="danger" onClick={() => { onDeleteFolder(deleteState.id); setCurrentFolderId(deleteState.parentId); setDeleteState(null); }}>{t('Delete')}</button></div></div>
      </div>}

      {showRelinkAll && (
        <div className="cc-modal-backdrop" role="dialog" aria-modal="true" aria-label={t('Relink offline footage')} onClick={() => setShowRelinkAll(false)}>
          <div className="cc-modal" style={{ width: 'min(420px, 92vw)', maxHeight: '70vh', overflow: 'auto' }} onClick={(e) => e.stopPropagation()}>
            <strong>{t('Relink offline footage')}</strong>
            <p style={{ margin: '8px 0 12px', fontSize: 12, color: theme.textMuted, lineHeight: 1.45 }}>
              {t('Files in the project have been moved or renamed. Select a folder to relink in batches by file name, or relink one by one from below.')}
            </p>
            <input ref={dirInputRef} type="file" multiple hidden onChange={(e) => relinkFromFolder(e.target.files)} />
            <button type="button" className="primary" disabled={dirBusy} onClick={() => dirInputRef.current?.click()}
              style={{ width: '100%', marginBottom: 10 }}>
              {dirBusy ? t('Matching by filename...') : t('Select folders to batch relink (match by file name)')}
            </button>
            {relinkMsg && <div style={{ fontSize: 12, color: `color-mix(in srgb, ${theme.success} 65%, ${theme.textStrong})`, margin: '0 0 10px' }}>{relinkMsg}</div>}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {missingList.map((asset) => (
          <div key={asset.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', borderRadius: 4, background: theme.panelAlt }}>
                  <span style={{ flex: 1, fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{asset.name}</span>
                  <button
                    type="button"
                    className="primary"
                    onClick={() => startRelink(asset.id)}
                    style={{ flexShrink: 0 }}
                  >
                    {t('Relink files')}
                  </button>
                </div>
              ))}
              {missingList.length === 0 && <div style={{ fontSize: 12, color: theme.textDim }}>{t('No material to be relinked')}</div>}
            </div>
            <div style={{ marginTop: 12 }}><button type="button" onClick={() => setShowRelinkAll(false)}>{t('close')}</button></div>
          </div>
        </div>
      )}
      {mobileUploadOpen && <MobileUploadDialog onClose={() => setMobileUploadOpen(false)} onImport={onImportMobile} />}
    </div>
  );
}
