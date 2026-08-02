import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useT } from '../i18n/locale';
import type { MediaAsset, MediaFolder } from '../editor/types';
import { usePersistedState } from '../hooks/usePersistedState';
import { useFocusReturn } from '../hooks/useFocusReturn';
import { importMedia } from './upload';
import { folderPath } from './mediaPoolFormat';
import { MediaPoolToolbar, type MediaToolbarMenu } from './MediaPoolToolbar';
import type { SemanticMatch } from './semantic-search/types';
import { filterMediaAssets, type MediaSortKey, type MediaTypeFilter } from './mediaPoolFilter';
import { MobileUploadDialog } from './MobileUploadDialog';
import type { MobileUploadRecord } from './mobileUploadApi';
import { AssetMenuPortal, MissingMediaBanner, RelinkAllDialog } from './MediaPoolOverlays';
import { MediaPoolGrid, type MediaGridEntry } from './MediaPoolGrid';
import { useAssetMenu } from './useAssetMenu';
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
  onAddAssets?: (assets: MediaAsset[]) => void;
  onCreateFolder: (name: string, parentId?: string) => string;
  onRenameFolder: (id: string, name: string) => void;
  onDeleteFolder: (id: string) => void;
  onMoveAssets: (ids: string[], folderId?: string) => void;
  onRenameAsset: (id: string, name: string) => void;
  onSetFavorite: (id: string, favorite: boolean) => void;
  /** Delete from the asset pool (two-step confirmation); the tracked clips have their own data copies and will not be affected */
  onRemoveAsset?: (id: string) => void;
  /** Relink File replaces an offline/missing asset and its clip srcs. */
  onRelinkAsset?: (id: string, next: { src: string; name?: string; durationInFrames?: number; width?: number; height?: number; kind?: MediaAsset['kind']; sourceRevision?: string; sourceSize?: number; sourceModifiedAt?: number }) => void;
  /** Add a solid-color clip. */
  onAddSolid?: () => void;
}

type PromptState = { title: string; initialValue: string; rejectSlash?: boolean; onSubmit: (value: string) => void };
type DeleteState = { id: string; name: string; parentId?: string };
export function MediaPoolPanel({
  semanticScopeId, assets, folders, fps, offlineAssetIds, onAssetLoadError,
  onImport, onImportMobile, onAddAsset, onAddAssets, onCreateFolder, onRenameFolder,
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
  const [menu, setMenu] = useState<MediaToolbarMenu>(null);
  const {
    assetId: assetMenu,
    position: assetMenuPos,
    open: openAssetMenuAt,
    close: closeAssetMenu,
  } = useAssetMenu();
  // Two-step confirmation for deletion: Click "Confirm Delete" for the first time, and the menu will be reset when reopening
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [currentFolderId, setCurrentFolderId] = useState<string>();
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
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
  const modalFocus = useFocusReturn();
  useEffect(() => {
    if (!assetMenu) setConfirmDeleteId(null);
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
        sourceRevision: next.sourceRevision,
        sourceSize: next.sourceSize,
        sourceModifiedAt: next.sourceModifiedAt,
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
        onRelinkAsset(asset.id, {
          src: next.src,
          name: next.name,
          durationInFrames: next.durationInFrames,
          width: next.width,
          height: next.height,
          kind: next.kind,
          sourceRevision: next.sourceRevision,
          sourceSize: next.sourceSize,
          sourceModifiedAt: next.sourceModifiedAt,
        });
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
  const closePrompt = () => {
    setPromptState(null);
    modalFocus.restore();
  };
  const submitPrompt = () => {
    const value = promptValue.trim();
    if (!promptState || !value) return;
    if (promptState.rejectSlash && value.includes('/')) { setError(t('名称不能包含 /')); return; }
    promptState.onSubmit(value);
    closePrompt();
  };
  const createFolder = (restoreFocus: () => void) => {
    modalFocus.remember(restoreFocus);
    openPrompt({
      title: '新文件夹名称', initialValue: '', rejectSlash: true,
      onSubmit: (name) => setCurrentFolderId(onCreateFolder(name, currentFolderId)),
    });
  };
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
  ], [childFolders, showFolders, visible]);
  const openFolder = useCallback((id: string) => setCurrentFolderId(id), []);
  const openAssetMenu = useCallback((
    id: string,
    anchor: HTMLElement,
    point?: { x: number; y: number },
  ) => {
    setConfirmDeleteId(null);
    openAssetMenuAt(id, anchor, point);
  }, [openAssetMenuAt]);
  const menuAsset = assetMenu ? assets.find((asset) => asset.id === assetMenu) : undefined;

  return (
    <div className="cc-media-pool" onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); void onPick(event.dataTransfer.files); }}>
      <input ref={inputRef} type="file" accept="video/*,image/*,audio/*,.gif,.svg,image/gif,image/svg+xml" multiple hidden onChange={(event) => onPick(event.target.files)} />
      <input ref={relinkInputRef} type="file" accept="video/*,image/*,audio/*,.gif,.svg,image/gif,image/svg+xml" hidden onChange={(event) => void onRelinkPick(event.target.files)} />
      <MediaPoolToolbar
        scopeId={semanticScopeId}
        assets={assets}
        query={query}
        sort={sort}
        type={type}
        favoritesOnly={favoritesOnly}
        view={view}
        menu={menu}
        busy={busy}
        uploadRatio={uploadRatio}
        canAddSolid={!!onAddSolid}
        onQueryChange={setQuery}
        onSemanticResults={onSemanticResults}
        onUpload={() => inputRef.current?.click()}
        onMobileUpload={(restoreFocus) => { modalFocus.remember(restoreFocus); setMobileUploadOpen(true); }}
        onAddSolid={() => onAddSolid?.()}
        onCreateFolder={createFolder}
        onViewChange={() => setView((value) => value === 'grid' ? 'list' : 'grid')}
        onMenuChange={setMenu}
        onSortChange={setSort}
        onTypeChange={setType}
        onFavoritesChange={() => setFavoritesOnly((value) => !value)}
      />

      <MissingMediaBanner count={missingList.length} onOpen={() => setShowRelinkAll(true)} />

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
        <button onClick={() => {
          if (onAddAssets) onAddAssets(selectedAssets);
          else selectedAssets.forEach(onAddAsset);
        }}>
          {t('加到时间线')}
        </button>
        <select aria-label={t('移动所选素材')} defaultValue="" onChange={(event) => { onMoveAssets(selectedAssets.map((asset) => asset.id), event.target.value === '__root__' ? undefined : event.target.value); setSelected(new Set()); event.target.value = ''; }}>
          <option value="" disabled>{t('移动到…')}</option><option value="__root__">Master</option>
          {folders.map((folder) => <option key={folder.id} value={folder.id}>{folderPath(folder, folders)}</option>)}
        </select>
      </div>}

      <MediaPoolGrid
        entries={gridEntries}
        assetsCount={assets.length}
        fps={fps}
        view={view}
        selected={selected}
        missing={missing}
        assetMenu={assetMenu}
        canRelink={!!onRelinkAsset}
        onOpenFolder={openFolder}
        onAddAsset={onAddAsset}
        onLoadError={markMissing}
        onLoadSuccess={clearMissing}
        onOpenMenu={openAssetMenu}
        onRelink={startRelink}
        onToggleSelected={toggleSelected}
      />

      <AssetMenuPortal
        asset={menuAsset}
        position={assetMenuPos}
        fps={fps}
        folders={folders}
        missing={menuAsset ? missing.has(menuAsset.id) : false}
        confirmDelete={menuAsset?.id === confirmDeleteId}
        canRelink={!!onRelinkAsset}
        canRemove={!!onRemoveAsset}
        onClose={() => closeAssetMenu(true)}
        onError={setError}
        onFavorite={() => { if (menuAsset) onSetFavorite(menuAsset.id, !menuAsset.favorite); closeAssetMenu(true); }}
        onRename={() => { if (menuAsset) openPrompt({ title: '素材显示名称', initialValue: menuAsset.name, onSubmit: (name) => onRenameAsset(menuAsset.id, name) }); modalFocus.remember(() => closeAssetMenu(true)); closeAssetMenu(); }}
        onRelink={() => { if (menuAsset) startRelink(menuAsset.id); closeAssetMenu(); }}
        onRemove={() => { if (!menuAsset || !onRemoveAsset) return; if (confirmDeleteId !== menuAsset.id) { setConfirmDeleteId(menuAsset.id); return; } onRemoveAsset(menuAsset.id); closeAssetMenu(true); setConfirmDeleteId(null); }}
        onMove={(folderId) => { if (menuAsset) onMoveAssets([menuAsset.id], folderId); closeAssetMenu(true); }}
      />

      {promptState && <div className="cc-modal-backdrop" role="dialog" aria-modal="true" aria-label={t(promptState.title)}>
        <form className="cc-modal" onSubmit={(event) => { event.preventDefault(); submitPrompt(); }}>
          <strong>{t(promptState.title)}</strong>
          <input autoFocus aria-label={t(promptState.title)} value={promptValue} onChange={(event) => setPromptValue(event.target.value)} />
          <div><button type="button" onClick={closePrompt}>{t('取消')}</button><button type="submit" className="primary">{t('确定')}</button></div>
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
      {mobileUploadOpen && <MobileUploadDialog onClose={() => { setMobileUploadOpen(false); modalFocus.restore(); }} onImport={onImportMobile} />}
    </div>
  );
}
