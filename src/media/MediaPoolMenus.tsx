import type { Dispatch, RefObject, SetStateAction } from 'react';
import type { MediaAsset, MediaFolder } from '../editor/types';
import type { AssetMenuPosition } from './useAssetMenu';
import type { MediaSortKey, MediaTypeFilter } from './mediaPoolFilter';
import { AssetMenuPortal, BlankMediaMenuPortal, FolderMenuPortal } from './MediaPoolOverlays';
import { assetMenuFavoriteValue } from './assetMenuSelection';
import { addAssetsToChat, allVisibleAssetsSelected, toggleVisibleAssetSelection } from './mediaSelectionActions';
import { toggleMediaView } from './mediaView';
import { assetCanTranscribe } from '../transcript/transcribe-jobs';

interface FolderMenuContext {
  folder?: MediaFolder;
  position: AssetMenuPosition | null;
  canDelete: boolean;
  close: () => void;
  open: (id: string) => void;
  rememberFocus: () => void;
  rename: (folder: MediaFolder) => void;
  requestDelete: (folder: MediaFolder) => void;
}

interface AssetMenuContext {
  asset?: MediaAsset;
  position: AssetMenuPosition | null;
  fps: number;
  folders: MediaFolder[];
  missing: boolean;
  confirmDeleteId: string | null;
  assets: MediaAsset[];
  assetIds: string[];
  usedAssetIds: ReadonlySet<string>;
  canRelink: boolean;
  canRemove: boolean;
  close: (restoreFocus?: boolean) => void;
  setError: (error: string | null) => void;
  onSetFavorite: (id: string, favorite: boolean) => void;
  onSetAssetsFavorite?: (ids: string[], favorite: boolean) => void;
  rename: (assets: MediaAsset[]) => void;
  rememberFocus: (restore: () => void) => void;
  startRelink: (id: string) => void;
  requestRemove: (assets: MediaAsset[]) => void;
  setConfirmDeleteId: (id: string | null) => void;
  remove: (ids: string[]) => void;
  move: (ids: string[], folderId?: string) => void;
  addToTimeline?: (assets: MediaAsset[]) => void;
  addAsset: (asset: MediaAsset) => void;
  addToChat?: (assets: MediaAsset[]) => void;
  transcribe: (assets: MediaAsset[]) => void;
}

interface BlankMenuContext {
  position: { top: number; left: number } | null;
  clipboard: MediaAsset[];
  visibleIds: string[];
  selected: Set<string>;
  currentFolderId?: string;
  view: 'grid' | 'list';
  sort: MediaSortKey;
  type: MediaTypeFilter;
  setPosition: (position: { top: number; left: number } | null) => void;
  paste?: (assets: MediaAsset[], folderId?: string) => void;
  setSelected: Dispatch<SetStateAction<Set<string>>>;
  openSemanticSearch: () => void;
  openMobileUpload: () => void;
  inputRef: RefObject<HTMLInputElement | null>;
  createFolder: () => void;
  setView: Dispatch<SetStateAction<'grid' | 'list'>>;
  setSort: (sort: MediaSortKey) => void;
  setType: (type: MediaTypeFilter) => void;
}

interface MediaPoolMenusProps {
  folder: FolderMenuContext;
  asset: AssetMenuContext;
  blank: BlankMenuContext;
}

function MediaFolderMenu({ folder: context }: Pick<MediaPoolMenusProps, 'folder'>) {
  const folder = context.folder;
  return <FolderMenuPortal
    folder={folder}
    position={context.position}
    canDelete={context.canDelete}
    onClose={context.close}
    onOpen={() => { if (folder) context.open(folder.id); context.close(); }}
    onRename={() => { if (folder) { context.rememberFocus(); context.rename(folder); } context.close(); }}
    onDelete={() => { if (folder) context.requestDelete(folder); context.close(); }}
  />;
}

function MediaAssetMenu({ asset: context }: Pick<MediaPoolMenusProps, 'asset'>) {
  const asset = context.asset;
  const close = () => context.close(true);
  const remove = () => {
    if (!context.assets.length || !context.canRemove) return;
    if (context.assets.some((item) => context.usedAssetIds.has(item.id))) {
      context.requestRemove(context.assets);
      return;
    }
    if (context.confirmDeleteId !== asset?.id) {
      context.setConfirmDeleteId(asset?.id ?? null);
      return;
    }
    context.remove(context.assetIds);
  };
  return <AssetMenuPortal
    asset={asset} position={context.position} fps={context.fps} folders={context.folders}
    missing={context.missing} confirmDelete={asset?.id === context.confirmDeleteId}
    canRelink={context.canRelink} canRemove={context.canRemove} onClose={close} onError={context.setError}
    onFavorite={() => { const favorite = assetMenuFavoriteValue(context.assets); if (context.onSetAssetsFavorite) context.onSetAssetsFavorite(context.assetIds, favorite); else context.assets.forEach((item) => context.onSetFavorite(item.id, favorite)); close(); }}
    onRename={() => { if (context.assets.length) context.rename(context.assets); context.rememberFocus(close); context.close(); }}
    onRelink={() => { if (asset) context.startRelink(asset.id); context.close(); }}
    onRemove={remove}
    onMove={(folderId) => { if (context.assetIds.length) context.move(context.assetIds, folderId); close(); }}
    onAddTimeline={() => { if (context.addToTimeline) context.addToTimeline(context.assets); else context.assets.forEach(context.addAsset); close(); }}
    onAddChat={() => { addAssetsToChat(context.assets, context.addToChat); close(); }}
    onTranscribe={context.assets.some((item) => assetCanTranscribe(item.kind, item.transcribeStatus))
      ? () => { context.transcribe(context.assets); close(); }
      : undefined}
  />;
}

function MediaBlankMenu({ blank: context }: Pick<MediaPoolMenusProps, 'blank'>) {
  if (!context.position) return null;
  const close = () => context.setPosition(null);
  return <BlankMediaMenuPortal
    position={context.position} clipboardCount={context.clipboard.length} visibleCount={context.visibleIds.length}
    allVisibleSelected={allVisibleAssetsSelected(context.selected, context.visibleIds)}
    view={context.view} sort={context.sort} type={context.type} onClose={close}
    onPaste={() => { context.paste?.(context.clipboard, context.currentFolderId); close(); }}
    onSelectAll={() => { context.setSelected((selected) => toggleVisibleAssetSelection(selected, context.visibleIds)); close(); }}
    onSemanticSearch={() => { context.openSemanticSearch(); close(); }}
    onMobileUpload={() => { context.openMobileUpload(); close(); }}
    onUpload={() => { context.inputRef.current?.click(); close(); }}
    onCreateFolder={() => { context.createFolder(); close(); }}
    onViewToggle={() => { context.setView(toggleMediaView); close(); }}
    onSort={(value) => { context.setSort(value); close(); }}
    onType={(value) => { context.setType(value); close(); }}
  />;
}

export function MediaPoolMenus(props: MediaPoolMenusProps) {
  return <>
    <MediaFolderMenu folder={props.folder} />
    <MediaAssetMenu asset={props.asset} />
    <MediaBlankMenu blank={props.blank} />
  </>;
}
