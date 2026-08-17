import { useCallback, useEffect, useMemo, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { useMusicAnalysisCards } from '../audio/intelligence/useMusicAnalysisCards';
import { useT } from '../i18n/locale';
import type { MediaAsset, MediaAssetRelinkPatch, MediaFolder } from '../editor/types';
import { usePersistedState } from '../hooks/usePersistedState';
import { useFocusReturn } from '../hooks/useFocusReturn';
import { useMediaPoolRelink } from './useMediaPoolRelink';
import { folderPath } from './mediaPoolFormat';
import { MediaPoolToolbar, type MediaToolbarMenu } from './MediaPoolToolbar';
import type { SemanticMatch } from './semantic-search/types';
import { filterMediaAssets, type MediaSortKey, type MediaTypeFilter } from './mediaPoolFilter';
import { MobileUploadDialog } from './MobileUploadDialog';
import type { MobileUploadRecord } from './mobileUploadApi';
import { MissingMediaBanner, RelinkAllDialog } from './MediaPoolOverlays';
import {
  MediaPoolDialogs,
  type MediaAssetDeleteState,
  type MediaFolderDeleteState,
  type MediaPromptState,
} from './MediaPoolDialogs';
import { MediaPoolGrid, type MediaGridEntry } from './MediaPoolGrid';
import { useAssetMenu, type AssetMenuPosition } from './useAssetMenu';
import { assetMenuSelectionIds, batchAssetRename } from './assetMenuSelection';
import { MediaPoolMenus } from './MediaPoolMenus';
import { PoolTranscriptViewer } from './TranscriptViewerDialog';
import { useTranscriptViewer } from './useTranscriptViewer';
import { toggleMediaView } from './mediaView';
import { resolveMediaPoolShortcut } from './mediaPoolShortcutScope';
import { useMediaPoolFileImport } from './useMediaPoolFileImport';
import type { UseDirectoryImportState } from './useDirectoryImport';
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
  directoryImport: UseDirectoryImportState;
  directoryImportError: string | null;
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
  /** Start (or retry) ASR for one asset from the pool UI. */
  onTranscribe: (asset: MediaAsset) => void;
}

export function MediaPoolPanel({
  semanticScopeId, assets, folders, fps, usedAssetIds, offlineAssetIds, onAssetLoadError,
  onImport, onImportMobile, directoryImport, directoryImportError, onAddAsset, onAddAssetsToTimeline, onAddAssetsToChat, onCreateFolder, onRenameFolder,
  onDeleteFolder, onMoveAssets, onRenameAsset, onRenameAssets, onSetFavorite, onSetAssetsFavorite, onRemoveAsset, onRemoveAssets, onPasteAssets, onRelinkAsset, onAddSolid, onTranscribe,
}: MediaPoolPanelProps) {
  const t = useT();
  const musicAnalysis = useMusicAnalysisCards(assets);
  const [error, setError] = useState<string | null>(null);
  const fileImport = useMediaPoolFileImport({ onImport, onMoveAssets, setError, t });
  const {
    inputRef, busy, setBusy, uploadRatio, canPickDirectory,
    pickFiles, pickDirectory, handleDrop,
  } = fileImport;
  const { available: canWatchDirectory, busy: watchBusy, activeWatch, start: startWatch, stop: stopWatch } = directoryImport;
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
  // Two-step deletion: first click asks for confirmation, reopening the menu resets it
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [currentFolderId, setCurrentFolderId] = useState<string>();
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [assetClipboard, setAssetClipboard] = useState<MediaAsset[]>([]);
  const [blankMenuPos, setBlankMenuPos] = useState<{ top: number; left: number } | null>(null);
  const [promptState, setPromptState] = useState<MediaPromptState | null>(null);
  const [promptValue, setPromptValue] = useState('');
  const [deleteState, setDeleteState] = useState<MediaFolderDeleteState | null>(null);
  const [assetDeleteState, setAssetDeleteState] = useState<MediaAssetDeleteState | null>(null);
  const [semanticResults, setSemanticResults] = useState<SemanticMatch[] | null>(null);
  const [semanticOpenRequest, setSemanticOpenRequest] = useState(0);
  const [mobileUploadOpen, setMobileUploadOpen] = useState(false);
  const { transcriptEntries, viewerAsset, openTranscriptViewer, closeTranscriptViewer, stepViewer } = useTranscriptViewer(assets);
  const relink = useMediaPoolRelink({
    assets,
    offlineAssetIds,
    fps,
    onAssetLoadError,
    onRelinkAsset,
    setBusy,
    setError,
    t,
  });
  const {
    missing, missingList, relinkInputRef, directoryInputRef, relinkBusy, relinkMessage,
    showRelinkAll, setShowRelinkAll, markMissing, clearMissing, startRelink,
    pickRelinkFile, relinkFromFolder,
  } = relink;
  const onSemanticResults = useCallback((matches: SemanticMatch[] | null) => setSemanticResults(matches), []);
  const modalFocus = useFocusReturn();
  useEffect(() => {
    if (!assetMenu) setConfirmDeleteId(null);
  }, [assetMenu]);
  const currentFolder = folders.find((folder) => folder.id === currentFolderId);
  const childFolders = folders.filter((folder) => folder.parentId === currentFolderId);
  const { query: q, visible } = filterMediaAssets({
    assets, query, semanticResults, currentFolderId, type, favoritesOnly, sort,
  });
  const selectedAssets = assets.filter((asset) => selected.has(asset.id));
  const openPrompt = (next: MediaPromptState) => { setPromptValue(next.initialValue); setPromptState(next); };
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
      onDrop={(event) => { event.preventDefault(); void handleDrop(event.dataTransfer, currentFolderId); }}
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
      <input ref={inputRef} type="file" accept="video/*,image/*,audio/*,.gif,.svg,image/gif,image/svg+xml" multiple hidden onChange={(event) => void pickFiles(event.target.files, currentFolderId)} />
      <input ref={relinkInputRef} type="file" accept="video/*,image/*,audio/*,.gif,.svg,image/gif,image/svg+xml" hidden onChange={(event) => void pickRelinkFile(event.target.files)} />
      <MediaPoolToolbar
        scopeId={semanticScopeId}
        assets={assets}
        query={query}
        sort={sort}
        type={type}
        favoritesOnly={favoritesOnly}
        view={view}
        menu={menu}
        busy={busy || watchBusy}
        uploadRatio={uploadRatio}
        canAddSolid={!!onAddSolid}
        semanticOpenRequest={semanticOpenRequest}
        onQueryChange={setQuery}
        onSemanticResults={onSemanticResults}
        onUpload={() => inputRef.current?.click()}
        onPickFolder={canPickDirectory ? () => void pickDirectory(currentFolderId) : undefined}
        onWatchFolder={canWatchDirectory ? () => void startWatch() : undefined} onStopWatch={() => void stopWatch()}
        watchingFolder={activeWatch?.directoryName ?? null} watchBusy={watchBusy}
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
      {(error ?? directoryImportError) && <div className="cc-media-error">{error ?? directoryImportError}</div>}
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
        onDropFiles={(files, folderId) => void pickFiles(files, folderId)}
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
        onTranscribe={(id) => {
          const target = assets.find((asset) => asset.id === id);
          if (target) onTranscribe(target);
        }}
        onOpenTranscript={openTranscriptViewer}
      />

      <MediaPoolMenus
        folder={{
          folder: menuFolder, position: folderMenuPos,
          canDelete: menuFolder ? folderIsEmpty(menuFolder.id) : false,
          close: closeFolderMenu, open: openFolder,
          rememberFocus: () => modalFocus.remember(() => undefined),
          rename: renameFolderTarget, requestDelete: requestDeleteFolder,
        }}
        asset={{
          asset: menuAsset, position: assetMenuPos, fps, folders,
          missing: menuAsset ? missing.has(menuAsset.id) : false,
          confirmDeleteId, assets: menuAssets, assetIds: menuAssetIds, usedAssetIds,
          canRelink: !!onRelinkAsset, canRemove: !!onRemoveAsset || !!onRemoveAssets,
          close: closeAssetMenu, setError, onSetFavorite, onSetAssetsFavorite,
          rename: renameAssets, rememberFocus: modalFocus.remember, startRelink,
          requestRemove: requestRemoveAssets, setConfirmDeleteId, remove: removeAssets,
          transcribe: (targets) => targets.filter((asset) => (asset.kind === 'audio' || asset.kind === 'video') && asset.transcribeStatus !== 'running' && asset.transcribeStatus !== 'done').forEach((asset) => onTranscribe(asset)),
          viewTranscript: (asset) => openTranscriptViewer(asset.id),
          move: onMoveAssets, addToTimeline: onAddAssetsToTimeline, addAsset: onAddAsset,
          addToChat: onAddAssetsToChat,
        }}
        blank={{
          position: blankMenuPos, clipboard: assetClipboard, visibleIds, selected,
          currentFolderId, view, sort, type, setPosition: setBlankMenuPos,
          paste: onPasteAssets, setSelected,
          openSemanticSearch: () => setSemanticOpenRequest((value) => value + 1),
          openMobileUpload: () => setMobileUploadOpen(true),
          inputRef, createFolder: () => createFolder(() => undefined),
          setView, setSort, setType,
        }}
      />

      <PoolTranscriptViewer asset={viewerAsset} entries={transcriptEntries} onClose={closeTranscriptViewer} onStep={stepViewer} />

      <MediaPoolDialogs
        prompt={promptState}
        promptValue={promptValue}
        folderDelete={deleteState}
        assetDelete={assetDeleteState}
        assetDeleteTitle={assetDeleteTitle}
        onPromptValue={setPromptValue}
        onSubmitPrompt={submitPrompt}
        onClosePrompt={closePrompt}
        onDeleteFolder={(state) => {
          onDeleteFolder(state.id);
          if (currentFolderId === state.id) setCurrentFolderId(state.parentId);
          setDeleteState(null);
        }}
        onCloseFolderDelete={() => setDeleteState(null)}
        onDeleteAssets={removeAssets}
        onCloseAssetDelete={() => setAssetDeleteState(null)}
      />

      <RelinkAllDialog
        open={showRelinkAll}
        busy={relinkBusy}
        message={relinkMessage}
        missingAssets={missingList}
        inputRef={directoryInputRef}
        onClose={() => setShowRelinkAll(false)}
        onPickFolder={relinkFromFolder}
        onRelink={startRelink}
      />
      {mobileUploadOpen && <MobileUploadDialog onClose={() => { setMobileUploadOpen(false); modalFocus.restore(); }} onImport={onImportMobile} />}
    </div>
  );
}
