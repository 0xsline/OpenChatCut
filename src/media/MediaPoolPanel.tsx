import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { useMusicAnalysisCards } from '../audio/intelligence/useMusicAnalysisCards';
import { useT } from '../i18n/locale';
import type { MediaAsset, MediaAssetRelinkPatch, MediaFolder } from '../editor/types';
import { usePersistedState } from '../hooks/usePersistedState';
import { useFocusReturn } from '../hooks/useFocusReturn';
import { matchRelinkFile } from './mediaRelinkMatch';
import { importMedia } from './upload';
import { folderPath } from './mediaPoolFormat';
import { MediaPoolToolbar, type MediaToolbarMenu } from './MediaPoolToolbar';
import type { SemanticMatch } from './semantic-search/types';
import { filterMediaAssets, type MediaSortKey, type MediaTypeFilter } from './mediaPoolFilter';
import { MobileUploadDialog } from './MobileUploadDialog';
import type { MobileUploadRecord } from './mobileUploadApi';
import { AssetMenuPortal, BlankMediaMenuPortal, FolderMenuPortal, MissingMediaBanner, RelinkAllDialog } from './MediaPoolOverlays';
import { MediaPoolGrid, type MediaGridEntry } from './MediaPoolGrid';
import { useAssetMenu, type AssetMenuPosition } from './useAssetMenu';
import { assetMenuFavoriteValue, assetMenuSelectionIds, batchAssetRename } from './assetMenuSelection';
import { addAssetsToChat, allVisibleAssetsSelected, toggleVisibleAssetSelection } from './mediaSelectionActions';
import { toggleMediaView } from './mediaView';
import { mediaImportErrorMessage } from './mediaImportConflict';
import { resolveMediaPoolShortcut } from './mediaPoolShortcutScope';
import { importMediaBatch } from './mediaPoolImport';
interface MediaPoolPanelProps {
  semanticScopeId: string;
  assets: MediaAsset[];
  folders: MediaFolder[];
  fps: number;
  usedAssetIds: ReadonlySet<string>;
  offlineAssetIds: ReadonlySet<string>;
  onAssetLoadError: (asset: MediaAsset) => void;
  onImport: (
    file: File,
    onProgress?: (ratio: number) => void,
    lifecycle?: {
      onPlaceholder?: (asset: MediaAsset) => void;
      onAssetUpdated?: (asset: MediaAsset) => void;
      onFailure?: (asset: MediaAsset | null, error: unknown) => void;
    },
  ) => Promise<MediaAsset>;
  onImportMobile: (record: MobileUploadRecord) => Promise<void>;
  onAddAsset: (asset: MediaAsset) => void;
  onAddAssetsToTimeline?: (assets: MediaAsset[]) => void;
  onAddAssetsToChat?: (assets: MediaAsset[]) => void;
  onCreateFolder: (name: string, parentId?: string) => string;
  onRenameFolder: (id: string, name: string) => void;
  onDeleteFolder: (id: string) => void;
  onMoveAssets: (ids: string[], folderId?: string) => void;
  onRenameAsset: (id: string, name: string) => void;
  onRenameAssets?: (entries: Array<{ id: string; name: string }>) => void;
  onSetFavorite: (id: string, favorite: boolean) => void;
  onSetAssetsFavorite?: (ids: string[], favorite: boolean) => void;
  /** Delete from the asset pool; linked timeline clips are removed by the project reducer. */
  onRemoveAsset?: (id: string) => void;
  onRemoveAssets?: (ids: string[]) => void;
  onPasteAssets?: (assets: MediaAsset[], folderId?: string) => void;
  /** Relink File replaces an offline/missing asset and its clip srcs. */
  onRelinkAsset?: (id: string, next: MediaAssetRelinkPatch) => void;
  /** Add a solid-color clip. */
  onAddSolid?: () => void;
}

type PromptState = { title: string; initialValue: string; rejectSlash?: boolean; onSubmit: (value: string) => void };
type DeleteState = { id: string; name: string; parentId?: string };
type AssetDeleteState = { ids: string[]; names: string[]; usedCount: number };
export function MediaPoolPanel({
  semanticScopeId, assets, folders, fps, usedAssetIds, offlineAssetIds, onAssetLoadError,
  onImport, onImportMobile, onAddAsset, onAddAssetsToTimeline, onAddAssetsToChat, onCreateFolder, onRenameFolder,
  onDeleteFolder, onMoveAssets, onRenameAsset, onRenameAssets, onSetFavorite, onSetAssetsFavorite, onRemoveAsset, onRemoveAssets, onPasteAssets, onRelinkAsset, onAddSolid,
}: MediaPoolPanelProps) {
  const t = useT();
  const musicAnalysis = useMusicAnalysisCards(assets);
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
  const [folderMenuId, setFolderMenuId] = useState<string | null>(null);
  const [folderMenuPos, setFolderMenuPos] = useState<AssetMenuPosition | null>(null);
  // Two-step confirmation for deletion: Click "Confirm Delete" for the first time, and the menu will be reset when reopening
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [currentFolderId, setCurrentFolderId] = useState<string>();
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [assetClipboard, setAssetClipboard] = useState<MediaAsset[]>([]);
  const [blankMenuPos, setBlankMenuPos] = useState<{ top: number; left: number } | null>(null);
  const [promptState, setPromptState] = useState<PromptState | null>(null);
  const [promptValue, setPromptValue] = useState('');
  const [deleteState, setDeleteState] = useState<DeleteState | null>(null);
  const [assetDeleteState, setAssetDeleteState] = useState<AssetDeleteState | null>(null);
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
  const [semanticOpenRequest, setSemanticOpenRequest] = useState(0);
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
        sourceFilename: next.sourceFilename,
        originalFilePath: next.originalFilePath,
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
      const picked = Array.from(files);
      let relinked = 0;
      const unmatched: string[] = [];
      for (const asset of missingList) {
        const f = matchRelinkFile(asset, picked);
        if (!f) {
          unmatched.push(asset.name);
          continue;
        }
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
          sourceFilename: next.sourceFilename,
          originalFilePath: next.originalFilePath,
        });
        clearMissing(asset.id);
        relinked++;
      }
      if (relinked > 0 && unmatched.length === 0) {
        setRelinkMsg(t('已从文件夹按文件名重链 {n} 个素材', { n: relinked }));
      } else if (relinked > 0) {
        setRelinkMsg(t('已重链 {n} 个素材；未找到匹配的文件：{list}', { n: relinked, list: unmatched.join('、') }));
      } else {
        setRelinkMsg(t('未找到与丢失素材匹配的文件：{list}', { list: unmatched.join('、') }));
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setDirBusy(false);
      if (dirInputRef.current) dirInputRef.current.value = '';
    }
  };

  // webkitdirectory is set inside RelinkAllDialog's input (this panel's
  // dirInputRef is null at mount — the input only renders when the dialog opens).

  const missingList = assets.filter((a) => missing.has(a.id));

  const currentFolder = folders.find((folder) => folder.id === currentFolderId);
  const childFolders = folders.filter((folder) => folder.parentId === currentFolderId);
  const { query: q, visible } = filterMediaAssets({
    assets, query, semanticResults, currentFolderId, type, favoritesOnly, sort,
  });
  const selectedAssets = assets.filter((asset) => selected.has(asset.id));

  const onPick = async (files: FileList | null, targetFolderId = currentFolderId) => {
    if (!files?.length) return;
    setBusy(true);
    setError(null);
    setUploadRatio(0);
    try {
      const completionErrors = await importMediaBatch({
        files: Array.from(files),
        targetFolderId,
        onImport,
        onMoveAssets,
        onProgress: (ratio) => setUploadRatio((current) => Math.max(current ?? 0, ratio)),
      });
      if (completionErrors.length) throw completionErrors[0];
      setUploadRatio(1);
    } catch (reason) {
      setError(mediaImportErrorMessage(reason));
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
  const closeFolderMenu = useCallback(() => {
    setFolderMenuId(null);
    setFolderMenuPos(null);
  }, []);
  useEffect(() => {
    if (!folderMenuId) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeFolderMenu();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [closeFolderMenu, folderMenuId]);
  const folderIsEmpty = useCallback((folderId: string) => (
    !assets.some((asset) => asset.folderId === folderId)
    && !folders.some((folder) => folder.parentId === folderId)
  ), [assets, folders]);
  const renameFolderTarget = (folder: MediaFolder) => {
    openPrompt({
      title: '重命名文件夹', initialValue: folder.name, rejectSlash: true,
      onSubmit: (name) => onRenameFolder(folder.id, name),
    });
  };
  const renameFolder = () => currentFolder && renameFolderTarget(currentFolder);
  const requestDeleteFolder = useCallback((folder: MediaFolder) => {
    if (!folderIsEmpty(folder.id)) {
      setError(t('只能删除空文件夹，请先移出或删除其中的内容'));
      return;
    }
    setDeleteState({ id: folder.id, name: folder.name, parentId: folder.parentId });
  }, [folderIsEmpty, t]);
  const deleteFolder = () => {
    if (currentFolder) requestDeleteFolder(currentFolder);
  };
  const openFolderMenu = useCallback((
    id: string,
    anchor: HTMLElement,
    point?: { x: number; y: number },
  ) => {
    closeAssetMenu();
    setBlankMenuPos(null);
    // Reuse asset-menu geometry: clamp within the media-pool panel.
    const rect = anchor.getBoundingClientRect();
    const panel = anchor.closest('.cc-media-pool')?.getBoundingClientRect();
    const menuWidth = 152;
    const anchorX = point?.x ?? rect.left;
    const anchorTop = point?.y ?? rect.top;
    const anchorBottom = point?.y ?? rect.bottom;
    const left = Math.min(
      (panel?.right ?? window.innerWidth) - menuWidth - 8,
      Math.max((panel?.left ?? 0) + 8, anchorX),
    );
    setFolderMenuId(id);
    setFolderMenuPos(anchorBottom > window.innerHeight / 2
      ? { bottom: window.innerHeight - anchorTop + 4, left }
      : { top: anchorBottom + 4, left });
  }, [closeAssetMenu]);
  const toggleSelected = useCallback((id: string) => setSelected((old) => {
    const next = new Set(old);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  }), []);
  const visibleIds = visible.map((asset) => asset.id);

  const renameAssets = (targets: MediaAsset[]) => {
    if (!targets.length) return;
    openPrompt({
      title: targets.length > 1 ? '批量重命名素材' : '素材显示名称',
      initialValue: targets.length > 1 ? '' : targets[0]!.name,
      onSubmit: (name) => {
        const entries = batchAssetRename(targets, name);
        if (onRenameAssets) onRenameAssets(entries);
        else entries.forEach((entry) => onRenameAsset(entry.id, entry.name));
      },
    });
  };

  const removeAssets = useCallback((ids: string[]) => {
    if (onRemoveAssets) onRemoveAssets(ids);
    else ids.forEach((id) => onRemoveAsset?.(id));
    setSelected((current) => {
      const next = new Set(current);
      ids.forEach((id) => next.delete(id));
      return next;
    });
    setAssetDeleteState(null);
    closeAssetMenu(true);
    setConfirmDeleteId(null);
  }, [closeAssetMenu, onRemoveAsset, onRemoveAssets]);

  const requestRemoveAssets = useCallback((targets: MediaAsset[]) => {
    if (!targets.length || (!onRemoveAsset && !onRemoveAssets)) return;
    setAssetDeleteState({
      ids: targets.map((asset) => asset.id),
      names: targets.map((asset) => asset.name),
      usedCount: targets.filter((asset) => usedAssetIds.has(asset.id)).length,
    });
    closeAssetMenu();
  }, [closeAssetMenu, onRemoveAsset, onRemoveAssets, usedAssetIds]);

  const handleMediaPoolKeyDown = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    if (target.closest('input, textarea, select, [contenteditable="true"], [data-music-analysis-control]')) return;
    const shortcut = resolveMediaPoolShortcut(event);
    if (!shortcut) return;
    let handled = true;
    if (shortcut === 'select-all') setSelected(new Set(visibleIds));
    else if (shortcut === 'copy') {
      if (selectedAssets.length) setAssetClipboard(selectedAssets);
      else handled = false;
    } else if (shortcut === 'paste') {
      if (assetClipboard.length && onPasteAssets) onPasteAssets(assetClipboard, currentFolderId);
      else handled = false;
    } else if (shortcut === 'delete') {
      if (selectedAssets.length) requestRemoveAssets(selectedAssets);
      else handled = false;
    } else setSelected(new Set());
    if (handled) {
      event.preventDefault();
      event.stopPropagation();
    }
  }, [assetClipboard, currentFolderId, onPasteAssets, requestRemoveAssets, selectedAssets, visibleIds]);

  const showFolders = !q && !semanticResults && !favoritesOnly;
  const parentFolder = currentFolder?.parentId
    ? folders.find((folder) => folder.id === currentFolder.parentId)
    : undefined;
  const gridEntries = useMemo<MediaGridEntry[]>(() => [
    ...(showFolders && !currentFolderId && onAddSolid ? [{ kind: 'solid' as const }] : []),
    ...(showFolders && !currentFolderId ? [{ kind: 'favorites' as const }] : []),
    // Inside a subfolder: first tile is "上一层" so assets can be dragged back up.
    ...(showFolders && currentFolder ? [{
      kind: 'parent' as const,
      parentId: currentFolder.parentId,
      parentName: parentFolder?.name ?? t('我的素材'),
    }] : []),
    ...(showFolders ? childFolders.map((folder) => ({ kind: 'folder' as const, folder })) : []),
    ...visible.map((asset) => ({ kind: 'asset' as const, asset })),
  ], [childFolders, currentFolder, currentFolderId, onAddSolid, parentFolder?.name, showFolders, t, visible]);
  const openFolder = useCallback((id: string) => setCurrentFolderId(id), []);
  const openParent = useCallback(() => {
    setCurrentFolderId(currentFolder?.parentId);
  }, [currentFolder?.parentId]);
  const openFavorites = useCallback(() => {
    setCurrentFolderId(undefined);
    setFavoritesOnly(true);
  }, []);
  const openAssetMenu = useCallback((
    id: string,
    anchor: HTMLElement,
    point?: { x: number; y: number },
  ) => {
    closeFolderMenu();
    setSelected((current) => current.has(id) ? current : new Set([id]));
    setConfirmDeleteId(null);
    openAssetMenuAt(id, anchor, point);
  }, [closeFolderMenu, openAssetMenuAt]);
  const menuAsset = assetMenu ? assets.find((asset) => asset.id === assetMenu) : undefined;
  const menuFolder = folderMenuId ? folders.find((folder) => folder.id === folderMenuId) : undefined;
  const menuAssetIds = menuAsset ? assetMenuSelectionIds(menuAsset.id, selected, assets.map((asset) => asset.id)) : [];
  const menuAssets = assets.filter((asset) => menuAssetIds.includes(asset.id));
  let assetDeleteTitle = '';
  if (assetDeleteState?.usedCount) {
    assetDeleteTitle = assetDeleteState.ids.length === 1
      ? t('此素材正在剪辑中，确定删除吗？')
      : t('所选素材中有正在剪辑的内容，确定删除吗？');
  } else if (assetDeleteState) {
    assetDeleteTitle = t('确定删除所选素材吗？');
  }

  return (
    <div
      className="cc-media-pool"
      data-cc-shortcut-surface="media-pool"
      tabIndex={-1}
      onKeyDown={handleMediaPoolKeyDown}
      onPointerDownCapture={(event) => {
        if (!(event.target as HTMLElement).closest('button, input, select, textarea, [contenteditable="true"], [data-music-analysis-control]')) {
          event.currentTarget.focus({ preventScroll: true });
        }
      }}
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => { event.preventDefault(); void onPick(event.dataTransfer.files, currentFolderId); }}
      onContextMenuCapture={(event) => {
        const target = event.target as HTMLElement;
        if (target.closest('[data-cc-media-asset-id], .cc-folder-card, button, input, select, textarea, label, [data-music-analysis-control]')) return;
        event.preventDefault();
        setSelected(new Set());
        setBlankMenuPos({
          left: Math.max(8, Math.min(event.clientX, window.innerWidth - 228)),
          top: Math.max(8, Math.min(event.clientY, window.innerHeight - 292)),
        });
      }}
    >
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
        semanticOpenRequest={semanticOpenRequest}
        onQueryChange={setQuery}
        onSemanticResults={onSemanticResults}
        onUpload={() => inputRef.current?.click()}
        onMobileUpload={(restoreFocus) => { modalFocus.remember(restoreFocus); setMobileUploadOpen(true); }}
        onAddSolid={() => onAddSolid?.()}
        onCreateFolder={createFolder}
        onViewChange={() => setView(toggleMediaView)}
        onMenuChange={setMenu}
        onSortChange={setSort}
        onTypeChange={setType}
        onFavoritesChange={() => setFavoritesOnly((value) => !value)}
      />

      <MissingMediaBanner count={missingList.length} onOpen={() => setShowRelinkAll(true)} />

      {(currentFolder || favoritesOnly || childFolders.length > 0) && <div className="cc-media-breadcrumb">
        <button aria-label={t('返回上级文件夹')} disabled={!currentFolder && !favoritesOnly} onClick={() => {
          if (favoritesOnly) setFavoritesOnly(false);
          else setCurrentFolderId(currentFolder?.parentId);
        }}>←</button>
        <span>{t('我的素材')}{favoritesOnly ? ` / ${t('收藏夹')}` : currentFolder ? ` / ${folderPath(currentFolder, folders)}` : ''}</span>
        {currentFolder && <button aria-label={t('重命名文件夹')} onClick={renameFolder}>{t('重命名')}</button>}
        {currentFolder && <button aria-label={t('删除空文件夹')} disabled={assets.some((asset) => asset.folderId === currentFolder.id) || folders.some((folder) => folder.parentId === currentFolder.id)} onClick={deleteFolder}>{t('删除')}</button>}
      </div>}
      {error && <div className="cc-media-error">{error}</div>}
      {busy && <div className="cc-media-status">{t('正在导入素材…')}</div>}
      {assets.length > 0 && <div className="cc-media-export-guide">{t('点击素材右上角“⋯”：图片、视频和音频可下载原文件，MG 可导出透明 MOV。')}</div>}

      <MediaPoolGrid
        entries={gridEntries}
        assetsCount={assets.length}
        fps={fps}
        view={view}
        selected={selected}
        missing={missing}
        usedAssetIds={usedAssetIds}
        musicAnalysis={musicAnalysis}
        assetMenu={assetMenu}
        canRelink={!!onRelinkAsset}
        onOpenFolder={openFolder}
        onOpenParent={openParent}
        onDropFiles={(files, folderId) => void onPick(files, folderId)}
        onMoveAsset={(id, folderId) => onMoveAssets([id], folderId)}
        onMoveAssets={(ids, folderId) => onMoveAssets(ids, folderId)}
        onOpenFavorites={openFavorites}
        onAddSolid={onAddSolid}
        onAddAsset={onAddAsset}
        onLoadError={markMissing}
        onLoadSuccess={clearMissing}
        onOpenMenu={openAssetMenu}
        onOpenFolderMenu={openFolderMenu}
        onRelink={startRelink}
        onToggleSelected={toggleSelected}
        onSetSelected={(ids) => setSelected(new Set(ids))}
        onSetFavorite={onSetFavorite}
      />

      <FolderMenuPortal
        folder={menuFolder}
        position={folderMenuPos}
        canDelete={menuFolder ? folderIsEmpty(menuFolder.id) : false}
        onClose={closeFolderMenu}
        onOpen={() => {
          if (menuFolder) openFolder(menuFolder.id);
          closeFolderMenu();
        }}
        onRename={() => {
          if (!menuFolder) return;
          modalFocus.remember(() => undefined);
          renameFolderTarget(menuFolder);
          closeFolderMenu();
        }}
        onDelete={() => {
          if (!menuFolder) return;
          requestDeleteFolder(menuFolder);
          closeFolderMenu();
        }}
      />

      <AssetMenuPortal
        asset={menuAsset}
        position={assetMenuPos}
        fps={fps}
        folders={folders}
        missing={menuAsset ? missing.has(menuAsset.id) : false}
        confirmDelete={menuAsset?.id === confirmDeleteId}
        canRelink={!!onRelinkAsset}
        canRemove={!!onRemoveAsset || !!onRemoveAssets}
        onClose={() => closeAssetMenu(true)}
        onError={setError}
        onFavorite={() => {
          const favorite = assetMenuFavoriteValue(menuAssets);
          if (onSetAssetsFavorite) onSetAssetsFavorite(menuAssetIds, favorite);
          else menuAssets.forEach((asset) => onSetFavorite(asset.id, favorite));
          closeAssetMenu(true);
        }}
        onRename={() => { if (menuAssets.length) renameAssets(menuAssets); modalFocus.remember(() => closeAssetMenu(true)); closeAssetMenu(); }}
        onRelink={() => { if (menuAsset) startRelink(menuAsset.id); closeAssetMenu(); }}
        onRemove={() => {
          if (!menuAssets.length || (!onRemoveAsset && !onRemoveAssets)) return;
          if (menuAssets.some((asset) => usedAssetIds.has(asset.id))) {
            requestRemoveAssets(menuAssets);
            return;
          }
          if (confirmDeleteId !== menuAsset?.id) { setConfirmDeleteId(menuAsset?.id ?? null); return; }
          removeAssets(menuAssetIds);
        }}
        onMove={(folderId) => { if (menuAssetIds.length) onMoveAssets(menuAssetIds, folderId); closeAssetMenu(true); }}
        onAddTimeline={() => {
          if (onAddAssetsToTimeline) onAddAssetsToTimeline(menuAssets);
          else menuAssets.forEach(onAddAsset);
          closeAssetMenu(true);
        }}
        onAddChat={() => { addAssetsToChat(menuAssets, onAddAssetsToChat); closeAssetMenu(true); }}
      />

      {blankMenuPos && <BlankMediaMenuPortal
        position={blankMenuPos}
        clipboardCount={assetClipboard.length}
        visibleCount={visibleIds.length}
        allVisibleSelected={allVisibleAssetsSelected(selected, visibleIds)}
        view={view}
        sort={sort}
        type={type}
        onClose={() => setBlankMenuPos(null)}
        onPaste={() => { onPasteAssets?.(assetClipboard, currentFolderId); setBlankMenuPos(null); }}
        onSelectAll={() => { setSelected((current) => toggleVisibleAssetSelection(current, visibleIds)); setBlankMenuPos(null); }}
        onSemanticSearch={() => { setSemanticOpenRequest((value) => value + 1); setBlankMenuPos(null); }}
        onMobileUpload={() => { setMobileUploadOpen(true); setBlankMenuPos(null); }}
        onUpload={() => { inputRef.current?.click(); setBlankMenuPos(null); }}
        onCreateFolder={() => { createFolder(() => undefined); setBlankMenuPos(null); }}
        onViewToggle={() => { setView(toggleMediaView); setBlankMenuPos(null); }}
        onSort={(value) => { setSort(value); setBlankMenuPos(null); }}
        onType={(value) => { setType(value); setBlankMenuPos(null); }}
      />}

      {promptState && <div className="cc-modal-backdrop" role="dialog" aria-modal="true" aria-label={t(promptState.title)}>
        <form className="cc-modal" onSubmit={(event) => { event.preventDefault(); submitPrompt(); }}>
          <strong>{t(promptState.title)}</strong>
          <input autoFocus aria-label={t(promptState.title)} value={promptValue} onChange={(event) => setPromptValue(event.target.value)} />
          <div><button type="button" onClick={closePrompt}>{t('取消')}</button><button type="submit" className="primary">{t('确定')}</button></div>
        </form>
      </div>}
      {deleteState && <div className="cc-modal-backdrop" role="dialog" aria-modal="true" aria-label={t('删除空文件夹')}>
        <div className="cc-modal"><strong>{t('删除空文件夹「{name}」？', { name: deleteState.name })}</strong><div><button onClick={() => setDeleteState(null)}>{t('取消')}</button><button className="danger" onClick={() => {
          onDeleteFolder(deleteState.id);
          // Only leave the folder if we were browsing inside the one being deleted.
          if (currentFolderId === deleteState.id) setCurrentFolderId(deleteState.parentId);
          setDeleteState(null);
        }}>{t('删除')}</button></div></div>
      </div>}
      {assetDeleteState && <div className="cc-modal-backdrop" role="dialog" aria-modal="true" aria-label={t('删除正在使用的素材')} onClick={() => setAssetDeleteState(null)}>
        <div className="cc-modal" onClick={(event) => event.stopPropagation()}>
          <strong>{assetDeleteTitle}</strong>
          <p className="cc-asset-delete-detail">{assetDeleteState.usedCount > 0
            ? t('将删除 {count} 个素材，并从所有时间线移除其中 {used} 个素材对应的片段。', { count: assetDeleteState.ids.length, used: assetDeleteState.usedCount })
            : t('将从素材池删除 {count} 个素材。', { count: assetDeleteState.ids.length })}</p>
          <p className="cc-asset-delete-detail" title={assetDeleteState.names.join('\n')}>{assetDeleteState.names.join('、')}</p>
          <div>
            <button type="button" onClick={() => setAssetDeleteState(null)}>{t('取消')}</button>
            <button type="button" className="danger" onClick={() => removeAssets(assetDeleteState.ids)}>{t('确认删除')}</button>
          </div>
        </div>
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
