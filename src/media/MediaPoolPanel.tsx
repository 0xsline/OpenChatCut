import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '../components/icons';
import { theme } from '../theme';
import { useT } from '../i18n/locale';
import type { MediaAsset, MediaFolder } from '../editor/types';
import { usePersistedState } from '../hooks/usePersistedState';
import { importMedia } from './upload';
import { folderPath } from './mediaPoolFormat';
import { SemanticSearchControls } from './semantic-search/SemanticSearchControls';
import type { SemanticMatch } from './semantic-search/types';
import { filterMediaAssets, type MediaSortKey, type MediaTypeFilter } from './mediaPoolFilter';
import { MobileUploadDialog } from './MobileUploadDialog';
import type { MobileUploadRecord } from './mobileUploadApi';
import { MediaAssetCard, MediaFolderCard } from './MediaPoolCard';
import { useFixedVirtualGrid } from '../hooks/useFixedVirtualGrid';
import { AssetMenuPortal, RelinkAllDialog } from './MediaPoolOverlays';
interface MediaPoolPanelProps {
  semanticScopeId: string;
  assets: MediaAsset[];
  folders: MediaFolder[];
  fps: number;
  offlineAssetIds: ReadonlySet<string>;
  onAssetLoadError: (asset: MediaAsset) => void;
  onImport: (file: File, onProgress?: (ratio: number) => void) => Promise<MediaAsset>;
  onImportMobile: (record: MobileUploadRecord) => Promise<void>;
  onAddAsset: (asset: MediaAsset) => void;
  onCreateFolder: (name: string, parentId?: string) => string;
  onRenameFolder: (id: string, name: string) => void;
  onDeleteFolder: (id: string) => void;
  onMoveAssets: (ids: string[], folderId?: string) => void;
  onRenameAsset: (id: string, name: string) => void;
  onSetFavorite: (id: string, favorite: boolean) => void;
  /** Delete from the asset pool (two-step confirmation); the tracked clips have their own data copies and will not be affected */
  onRemoveAsset?: (id: string) => void;
  /** Relink File replaces an offline/missing asset and its clip srcs. */
  onRelinkAsset?: (id: string, next: { src: string; name?: string; durationInFrames?: number; width?: number; height?: number; kind?: MediaAsset['kind'] }) => void;
  /** Add a solid-color clip. */
  onAddSolid?: () => void;
}

type PromptState = { title: string; initialValue: string; rejectSlash?: boolean; onSubmit: (value: string) => void };
type DeleteState = { id: string; name: string; parentId?: string };
type MediaGridEntry =
  | { kind: 'folder'; folder: MediaFolder }
  | { kind: 'asset'; asset: MediaAsset };
export function MediaPoolPanel({
  semanticScopeId, assets, folders, fps, offlineAssetIds, onAssetLoadError,
  onImport, onImportMobile, onAddAsset, onCreateFolder, onRenameFolder,
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
  /** fixed-position menu so overflow:auto grid doesn't clip collection/rename/folder */
  const [assetMenuPos, setAssetMenuPos] = useState<{ top?: number; bottom?: number; left: number } | null>(null);
  // Two-step confirmation for deletion: Click "Confirm Delete" for the first time, and the menu will be reset when reopening
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [currentFolderId, setCurrentFolderId] = useState<string>();
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [pointerPreviewId, setPointerPreviewId] = useState<string | null>(null);
  const [focusedAssetId, setFocusedAssetId] = useState<string | null>(null);
  const [focusedFolderId, setFocusedFolderId] = useState<string | null>(null);
  const [draggedAssetId, setDraggedAssetId] = useState<string | null>(null);
  const [promptState, setPromptState] = useState<PromptState | null>(null);
  const [promptValue, setPromptValue] = useState('');
  const [deleteState, setDeleteState] = useState<DeleteState | null>(null);
  const [mediaErrors, setMediaErrors] = useState<Set<string>>(() => new Set());
  const missing = useMemo(
    () => new Set([...offlineAssetIds, ...mediaErrors]),
    [offlineAssetIds, mediaErrors],
  );
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

  const markMissing = useCallback((id: string) => {
    const asset = assets.find((item) => item.id === id);
    if (asset) onAssetLoadError(asset);
    setMediaErrors((current) => new Set(current).add(id));
  }, [assets, onAssetLoadError]);
  const clearMissing = useCallback((id: string) => setMediaErrors((current) => {
    if (!current.has(id)) return current;
    const next = new Set(current);
    next.delete(id);
    return next;
  }), []);

  const startRelink = useCallback((id: string) => {
    if (!onRelinkAsset) return;
    setRelinkTarget(id);
    requestAnimationFrame(() => relinkInputRef.current?.click());
  }, [onRelinkAsset]);

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
      setRelinkMsg(relinked ? t('已从文件夹按文件名重链 {n} 个素材', { n: relinked }) : t('文件夹中没有与丢失素材同名的文件'));
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
    if (promptState.rejectSlash && value.includes('/')) { setError(t('名称不能包含 /')); return; }
    promptState.onSubmit(value);
    setPromptState(null);
  };
  const createFolder = () => openPrompt({
    title: '新文件夹名称', initialValue: '', rejectSlash: true,
    onSubmit: (name) => setCurrentFolderId(onCreateFolder(name, currentFolderId)),
  });
  const renameFolder = () => currentFolder && openPrompt({
    title: '重命名文件夹', initialValue: currentFolder.name, rejectSlash: true,
    onSubmit: (name) => onRenameFolder(currentFolder.id, name),
  });
  const deleteFolder = () => {
    if (currentFolder && !assets.some((asset) => asset.folderId === currentFolder.id)
      && !folders.some((folder) => folder.parentId === currentFolder.id)) {
      setDeleteState({ id: currentFolder.id, name: currentFolder.name, parentId: currentFolder.parentId });
    }
  };
  const toggleSelected = useCallback((id: string) => setSelected((old) => {
    const next = new Set(old);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  }), []);
  const toggleAll = () => setSelected((old) => {
    const next = new Set(old);
    const allSelected = visible.length > 0 && visible.every((asset) => next.has(asset.id));
    for (const asset of visible) { if (allSelected) next.delete(asset.id); else next.add(asset.id); }
    return next;
  });

  const showFolders = !q && !semanticResults;
  const gridEntries = useMemo<MediaGridEntry[]>(() => [
    ...(showFolders ? childFolders.map((folder) => ({ kind: 'folder' as const, folder })) : []),
    ...visible.map((asset) => ({ kind: 'asset' as const, asset })),
  ], [childFolders, semanticResults, q, visible]);
  const activePreviewId = focusedAssetId ?? pointerPreviewId;
  const pinnedIndexes = useMemo(() => {
    const pinnedIds = new Set([assetMenu, activePreviewId, focusedAssetId, pointerPreviewId, draggedAssetId]
      .filter((id): id is string => id != null));
    for (const id of selected) pinnedIds.add(id);
    const indexes: number[] = [];
    gridEntries.forEach((entry, index) => {
      if (entry.kind === 'asset' && pinnedIds.has(entry.asset.id)) indexes.push(index);
      if (entry.kind === 'folder' && entry.folder.id === focusedFolderId) indexes.push(index);
    });
    return indexes;
  }, [activePreviewId, assetMenu, draggedAssetId, focusedAssetId, focusedFolderId, gridEntries, pointerPreviewId, selected]);
  const virtualGrid = useFixedVirtualGrid({
    itemCount: gridEntries.length,
    cardWidth: view === 'grid' ? 104 : 1,
    rowHeight: view === 'grid' ? 96 : 28,
    columnGap: view === 'grid' ? 12 : 0,
    rowGap: view === 'grid' ? 25 : 0,
    overscanRows: 2,
    fixedColumnCount: view === 'list' ? 1 : undefined,
    pinnedIndexes,
  });
  useEffect(() => {
    if (view === 'list') {
      setPointerPreviewId(null);
      return;
    }
    const pointerIndex = gridEntries.findIndex((entry) => entry.kind === 'asset' && entry.asset.id === pointerPreviewId);
    if (pointerIndex >= 0
      && (pointerIndex < virtualGrid.visibleStartIndex || pointerIndex >= virtualGrid.visibleEndIndex)) {
      setPointerPreviewId(null);
    }
  }, [gridEntries, pointerPreviewId, view, virtualGrid.visibleEndIndex, virtualGrid.visibleStartIndex]);
  useEffect(() => {
    const assetExists = gridEntries.some((entry) => entry.kind === 'asset' && entry.asset.id === focusedAssetId);
    const folderExists = gridEntries.some((entry) => entry.kind === 'folder' && entry.folder.id === focusedFolderId);
    if (focusedAssetId && !assetExists) setFocusedAssetId(null);
    if (focusedFolderId && !folderExists) setFocusedFolderId(null);
  }, [focusedAssetId, focusedFolderId, gridEntries]);
  const openFolder = useCallback((id: string) => setCurrentFolderId(id), []);
  const openAssetMenu = useCallback((id: string, anchor: HTMLElement) => {
    if (assetMenu === id) {
      setAssetMenu(null);
      setAssetMenuPos(null);
      return;
    }
    setConfirmDeleteId(null);
    const rect = anchor.getBoundingClientRect();
    const panel = anchor.closest('.cc-media-pool')?.getBoundingClientRect();
    const menuWidth = 152;
    const left = Math.min(
      (panel?.right ?? window.innerWidth) - menuWidth - 8,
      Math.max((panel?.left ?? 0) + 8, rect.left),
    );
    setAssetMenu(id);
    setAssetMenuPos(rect.bottom > window.innerHeight / 2
      ? { bottom: window.innerHeight - rect.top + 4, left }
      : { top: rect.bottom + 4, left });
  }, [assetMenu]);
  const menuAsset = assetMenu ? assets.find((asset) => asset.id === assetMenu) : undefined;

  return (
    <div className="cc-media-pool" onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); void onPick(event.dataTransfer.files); }}>
      <input ref={inputRef} type="file" accept="video/*,image/*,audio/*,.gif,.svg,image/gif,image/svg+xml" multiple hidden onChange={(event) => onPick(event.target.files)} />
      <input ref={relinkInputRef} type="file" accept="video/*,image/*,audio/*,.gif,.svg,image/gif,image/svg+xml" hidden onChange={(event) => void onRelinkPick(event.target.files)} />
      <div className="cc-media-toolbar">
        <label className="cc-media-search">
          <Icon name="search" size={16} />
          <input aria-label={t('搜索素材')} value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t('搜索')} />
        </label>
        <SemanticSearchControls scopeId={semanticScopeId} assets={assets} onResultsChange={onSemanticResults} />
        <button className="cc-media-icon" aria-label={t('上传素材')} title={t('上传素材')} disabled={busy} onClick={() => inputRef.current?.click()}><Icon name="upload" size={19} /></button>
        <button className="cc-media-icon" aria-label={t('手机传素材')} title={t('手机传素材')} onClick={() => setMobileUploadOpen(true)}><Icon name="qrCode" size={19} /></button>
        {busy && uploadRatio != null && (
          <span className="cc-media-upload-pct" title={t('上传中')} style={{ fontSize: 11, opacity: 0.75, minWidth: 36, fontVariantNumeric: 'tabular-nums' }}>
            {Math.round(uploadRatio * 100)}%
          </span>
        )}
        {onAddSolid && (
          <button className="cc-media-icon" aria-label={t('添加纯色')} title={t('添加纯色片段')} onClick={onAddSolid} style={{ fontSize: 11, fontWeight: 700 }}>{t('色')}</button>
        )}
        <button className="cc-media-icon" aria-label={t('新建文件夹')} title={t('新建文件夹')} onClick={createFolder}><Icon name="folderPlus" size={20} /></button>
        <button className="cc-media-icon" aria-label={t('切换网格列表')} title={t('切换网格/列表')} onClick={() => setView((value) => value === 'grid' ? 'list' : 'grid')}><Icon name={view === 'grid' ? 'list' : 'grid'} size={19} /></button>
        <div className="cc-media-menu-anchor">
          <button className={`cc-media-icon${menu === 'sort' ? ' active' : ''}`} aria-label={t('素材排序')} title={t('排序')} onClick={() => setMenu((value) => value === 'sort' ? null : 'sort')}><Icon name="sort" size={19} /></button>
          {menu === 'sort' && <div className="cc-media-popover cc-media-sort-menu">
            {([['newest', '最新导入'], ['name', '名称 A–Z'], ['duration', '时长']] as const).map(([value, label]) => <button key={value} className={sort === value ? 'selected' : ''} onClick={() => { setSort(value); setMenu(null); }}>{t(label)}</button>)}
          </div>}
        </div>
        <div className="cc-media-menu-anchor">
          <button className={`cc-media-icon${menu === 'filter' || type !== 'all' || favoritesOnly ? ' active' : ''}`} aria-label={t('筛选素材')} title={t('筛选')} onClick={() => setMenu((value) => value === 'filter' ? null : 'filter')}><Icon name="filter" size={19} /></button>
          {menu === 'filter' && <div className="cc-media-popover cc-media-filter-menu">
            {([['all', '全部'], ['video', '视频'], ['image', '图片'], ['gif', 'GIF'], ['svg', 'SVG'], ['audio', '音频']] as const).map(([value, label]) => <button key={value} className={type === value ? 'selected' : ''} onClick={() => setType(value)}>{t(label)}</button>)}
            <button className={favoritesOnly ? 'selected' : ''} onClick={() => setFavoritesOnly((value) => !value)}><span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Icon name="star" size={13} filled={favoritesOnly} /> {t('收藏')}</span></button>
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
            {t('有 {n} 个素材丢失或无法加载。选择文件夹搜索，或从行内重新链接。', { n: missingList.length })}
          </span>
          <button
            type="button"
            onClick={() => setShowRelinkAll(true)}
            style={{
              background: theme.hover, color: theme.text, border: `0.5px solid ${theme.border}`, borderRadius: 3,
              padding: '4px 10px', fontSize: 12, fontWeight: 600, cursor: 'pointer',
            }}
          >
            {t('重新链接离线素材')}
          </button>
        </div>
      )}

      {(currentFolder || childFolders.length > 0) && <div className="cc-media-breadcrumb">
        <button aria-label={t('返回上级文件夹')} disabled={!currentFolder} onClick={() => setCurrentFolderId(currentFolder?.parentId)}>←</button>
        <span>Master{currentFolder ? ` / ${folderPath(currentFolder, folders)}` : ''}</span>
        {currentFolder && <button aria-label={t('重命名文件夹')} onClick={renameFolder}>{t('重命名')}</button>}
        {currentFolder && <button aria-label={t('删除空文件夹')} disabled={assets.some((asset) => asset.folderId === currentFolder.id) || folders.some((folder) => folder.parentId === currentFolder.id)} onClick={deleteFolder}>{t('删除')}</button>}
      </div>}
      {error && <div className="cc-media-error">{error}</div>}
      {busy && <div className="cc-media-status">{t('正在导入素材…')}</div>}
      {assets.length > 0 && <div className="cc-media-export-guide">{t('点击素材右上角“⋯”：图片、视频和音频可下载原文件，MG 可导出透明 MOV。')}</div>}

      {selectedAssets.length > 0 && <div className="cc-media-selection">
        <button onClick={toggleAll}>{visible.every((asset) => selected.has(asset.id)) ? t('清除选择') : t('全选')}</button>
        <span>{t('已选 {n}', { n: selectedAssets.length })}</span>
        <button onClick={() => selectedAssets.forEach(onAddAsset)}>{t('加到时间线')}</button>
        <select aria-label={t('移动所选素材')} defaultValue="" onChange={(event) => { onMoveAssets(selectedAssets.map((asset) => asset.id), event.target.value === '__root__' ? undefined : event.target.value); setSelected(new Set()); event.target.value = ''; }}>
          <option value="" disabled>{t('移动到…')}</option><option value="__root__">Master</option>
          {folders.map((folder) => <option key={folder.id} value={folder.id}>{folderPath(folder, folders)}</option>)}
        </select>
      </div>}

      <div className={`cc-media-grid ${view}`}>
        <div
          ref={virtualGrid.containerRef}
          className="cc-media-virtual-canvas"
          style={{ height: virtualGrid.totalHeight }}
        >
          {virtualGrid.rows.map((row) => (
            <div
              key={row.rowIndex}
              className="cc-media-virtual-row"
              style={{
                top: row.top,
                height: virtualGrid.rowHeight,
                gridTemplateColumns: view === 'grid'
                  ? `repeat(${virtualGrid.columnCount}, ${virtualGrid.columnWidth}px)`
                  : 'minmax(0, 1fr)',
                columnGap: view === 'grid' ? 12 : 0,
              }}
            >
              {gridEntries.slice(row.startIndex, row.endIndex).map((entry) => entry.kind === 'folder'
                ? (
                  <MediaFolderCard
                    key={`folder:${entry.folder.id}`}
                    folder={entry.folder}
                    onOpen={openFolder}
                    onFocusChange={setFocusedFolderId}
                  />
                )
                : (
                  <MediaAssetCard
                    key={`asset:${entry.asset.id}`}
                    asset={entry.asset}
                    fps={fps}
                    view={view}
                    active={activePreviewId === entry.asset.id}
                    selected={selected.has(entry.asset.id)}
                    missing={missing.has(entry.asset.id)}
                    canRelink={!!onRelinkAsset}
                    onAdd={onAddAsset}
                    onPointerChange={setPointerPreviewId}
                    onDragChange={setDraggedAssetId}
                    onFocusChange={setFocusedAssetId}
                    onLoadError={markMissing}
                    onLoadSuccess={clearMissing}
                    onOpenMenu={openAssetMenu}
                    onRelink={startRelink}
                    onToggleSelected={toggleSelected}
                  />
                ))}
            </div>
          ))}
        </div>
        {gridEntries.length === 0 && (
          <div className="cc-media-empty">
            {assets.length === 0
              ? <><Icon name="folder" size={28} /><strong>{t('这个文件夹是空的')}</strong><span>{t('导入媒体或把素材拖到这里。')}</span></>
              : <span>{t('当前筛选下没有素材')}</span>}
          </div>
        )}
      </div>

      <AssetMenuPortal
        asset={menuAsset}
        position={assetMenuPos}
        fps={fps}
        folders={folders}
        missing={menuAsset ? missing.has(menuAsset.id) : false}
        confirmDelete={menuAsset?.id === confirmDeleteId}
        canRelink={!!onRelinkAsset}
        canRemove={!!onRemoveAsset}
        onClose={() => { setAssetMenu(null); setAssetMenuPos(null); }}
        onError={setError}
        onFavorite={() => { if (menuAsset) onSetFavorite(menuAsset.id, !menuAsset.favorite); setAssetMenu(null); setAssetMenuPos(null); }}
        onRename={() => { if (menuAsset) openPrompt({ title: '素材显示名称', initialValue: menuAsset.name, onSubmit: (name) => onRenameAsset(menuAsset.id, name) }); setAssetMenu(null); setAssetMenuPos(null); }}
        onRelink={() => { if (menuAsset) startRelink(menuAsset.id); setAssetMenu(null); setAssetMenuPos(null); }}
        onRemove={() => { if (!menuAsset || !onRemoveAsset) return; if (confirmDeleteId !== menuAsset.id) { setConfirmDeleteId(menuAsset.id); return; } onRemoveAsset(menuAsset.id); setAssetMenu(null); setAssetMenuPos(null); setConfirmDeleteId(null); }}
        onMove={(folderId) => { if (menuAsset) onMoveAssets([menuAsset.id], folderId); setAssetMenu(null); setAssetMenuPos(null); }}
      />

      {promptState && <div className="cc-modal-backdrop" role="dialog" aria-modal="true" aria-label={t(promptState.title)}>
        <form className="cc-modal" onSubmit={(event) => { event.preventDefault(); submitPrompt(); }}>
          <strong>{t(promptState.title)}</strong>
          <input autoFocus aria-label={t(promptState.title)} value={promptValue} onChange={(event) => setPromptValue(event.target.value)} />
          <div><button type="button" onClick={() => setPromptState(null)}>{t('取消')}</button><button type="submit" className="primary">{t('确定')}</button></div>
        </form>
      </div>}
      {deleteState && <div className="cc-modal-backdrop" role="dialog" aria-modal="true" aria-label={t('删除空文件夹')}>
        <div className="cc-modal"><strong>{t('删除空文件夹「{name}」？', { name: deleteState.name })}</strong><div><button onClick={() => setDeleteState(null)}>{t('取消')}</button><button className="danger" onClick={() => { onDeleteFolder(deleteState.id); setCurrentFolderId(deleteState.parentId); setDeleteState(null); }}>{t('删除')}</button></div></div>
      </div>}

      <RelinkAllDialog
        open={showRelinkAll}
        busy={dirBusy}
        message={relinkMsg}
        missingAssets={missingList}
        inputRef={dirInputRef}
        onClose={() => setShowRelinkAll(false)}
        onPickFolder={relinkFromFolder}
        onRelink={startRelink}
      />
      {mobileUploadOpen && <MobileUploadDialog onClose={() => setMobileUploadOpen(false)} onImport={onImportMobile} />}
    </div>
  );
}
