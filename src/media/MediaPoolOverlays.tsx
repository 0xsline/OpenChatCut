import { createPortal } from 'react-dom';
import { useEffect, useRef, type CSSProperties, type RefObject } from 'react';
import type { MediaAsset, MediaFolder } from '../editor/types';
import { useT } from '../i18n/locale';
import { theme } from '../theme';
import { AssetExportButton } from './AssetExportButton';
import { folderPath } from './mediaPoolFormat';
import { AssetMenuDestinations } from './AssetMenuDestinations';
import type { MediaSortKey, MediaTypeFilter } from './mediaPoolFilter';

interface AssetMenuPortalProps {
  asset?: MediaAsset;
  position: CSSProperties | null;
  fps: number;
  folders: MediaFolder[];
  missing: boolean;
  confirmDelete: boolean;
  canRelink: boolean;
  canRemove: boolean;
  onClose: () => void;
  onError: (message: string) => void;
  onFavorite: () => void;
  onRename: () => void;
  onRelink: () => void;
  onRemove: () => void;
  onMove: (folderId?: string) => void;
  onAddTimeline: () => void;
  onAddChat: () => void;
  /** Transcribe the menu's asset selection (enabled when any is transcribable). */
  onTranscribe?: () => void;
}

interface BlankMediaMenuActionsProps {
  clipboardCount: number;
  visibleCount: number;
  allVisibleSelected: boolean;
  view: 'grid' | 'list';
  sort: MediaSortKey;
  type: MediaTypeFilter;
  onPaste: () => void;
  onSelectAll: () => void;
  onUpload: () => void;
  onSemanticSearch: () => void;
  onMobileUpload: () => void;
  onCreateFolder: () => void;
  onViewToggle: () => void;
  onSort: (value: MediaSortKey) => void;
  onType: (value: MediaTypeFilter) => void;
}

export function BlankMediaMenuActions(props: BlankMediaMenuActionsProps) {
  const t = useT();
  return <>
    <button type="button" disabled={!props.clipboardCount} onClick={props.onPaste}>{t('粘贴副本')}{props.clipboardCount > 1 ? ` (${props.clipboardCount})` : ''}</button>
    <button type="button" disabled={!props.visibleCount} onClick={props.onSelectAll}>{t(props.allVisibleSelected ? '取消全选' : '全选')}</button>
    <hr />
    <button type="button" onClick={props.onSemanticSearch}>{t('本地语义搜索')}</button>
    <button type="button" onClick={props.onMobileUpload}>{t('手机传素材')}</button>
    <button type="button" onClick={props.onUpload}>{t('上传素材')}</button>
    <button type="button" onClick={props.onCreateFolder}>{t('新建文件夹')}</button>
    <button type="button" onClick={props.onViewToggle}>{t(props.view === 'grid' ? '切换到列表视图' : '切换到网格视图')}</button>
    <label><span>{t('排序')}</span><select aria-label={t('素材排序')} value={props.sort} onChange={(event) => props.onSort(event.target.value as MediaSortKey)}>
      <option value="newest">{t('最新导入')}</option><option value="name">{t('名称 A–Z')}</option><option value="duration">{t('时长')}</option>
    </select></label>
    <label><span>{t('筛选')}</span><select aria-label={t('筛选素材')} value={props.type} onChange={(event) => props.onType(event.target.value as MediaTypeFilter)}>
      <option value="all">{t('全部')}</option><option value="video">{t('视频')}</option><option value="image">{t('图片')}</option><option value="audio">{t('音频')}</option>
    </select></label>
  </>;
}

export function BlankMediaMenuPortal(props: BlankMediaMenuActionsProps & { position: { top: number; left: number }; onClose: () => void }) {
  const { onClose } = props;
  const menuRef = useRef<HTMLDivElement>(null);
  const t = useT();
  useEffect(() => {
    const closeOutside = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) onClose();
    };
    document.addEventListener('pointerdown', closeOutside, true);
    return () => document.removeEventListener('pointerdown', closeOutside, true);
  }, [onClose]);
  return createPortal(
    <div ref={menuRef} className="cc-media-popover cc-media-blank-menu" style={props.position} role="menu" aria-label={t('素材池空白区域菜单')} onClick={(event) => event.stopPropagation()}>
      <BlankMediaMenuActions {...props} />
    </div>,
    document.body,
  );
}

function usePopoverDismiss(
  active: boolean,
  onClose: () => void,
  menuRef: RefObject<HTMLDivElement | null>,
) {
  useEffect(() => {
    if (!active) return;
    menuRef.current?.querySelector<HTMLElement>('button:not(:disabled), select')?.focus();
  }, [active, menuRef]);
  useEffect(() => {
    if (!active) return;
    const closeOutside = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) onClose();
    };
    document.addEventListener('pointerdown', closeOutside, true);
    return () => document.removeEventListener('pointerdown', closeOutside, true);
  }, [active, menuRef, onClose]);
}

export function AssetMenuPortal(props: AssetMenuPortalProps) {
  const { asset, onClose, position } = props;
  const menuRef = useRef<HTMLDivElement>(null);
  const t = useT();
  usePopoverDismiss(!!asset && !!position, onClose, menuRef);
  if (!props.asset || !props.position) return null;
  return createPortal(
      <div
        ref={menuRef}
        className="cc-media-popover cc-asset-menu-portal"
        style={props.position}
        role="menu"
        aria-label={t('管理 {name}', { name: props.asset.name })}
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget)) props.onClose();
        }}
        onClick={(event) => event.stopPropagation()}
      >
        <AssetMenuActions {...props} asset={props.asset} />
      </div>,
    document.body,
  );
}

interface FolderMenuPortalProps {
  folder?: MediaFolder;
  position: CSSProperties | null;
  /** Empty folders only — delete is disabled when the folder still has children. */
  canDelete: boolean;
  onClose: () => void;
  onOpen: () => void;
  onRename: () => void;
  onDelete: () => void;
}

export function FolderMenuPortal(props: FolderMenuPortalProps) {
  const { folder, onClose, position } = props;
  const menuRef = useRef<HTMLDivElement>(null);
  const t = useT();
  usePopoverDismiss(!!folder && !!position, onClose, menuRef);
  if (!folder || !position) return null;
  return createPortal(
    <div
      ref={menuRef}
      className="cc-media-popover cc-asset-menu-portal"
      style={position}
      role="menu"
      aria-label={t('管理文件夹 {name}', { name: folder.name })}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) onClose();
      }}
      onClick={(event) => event.stopPropagation()}
    >
      <button type="button" onClick={props.onOpen}>{t('打开')}</button>
      <button type="button" onClick={props.onRename}>{t('重命名')}</button>
      <button
        type="button"
        className="danger"
        disabled={!props.canDelete}
        title={props.canDelete ? undefined : t('只能删除空文件夹，请先移出或删除其中的内容')}
        onClick={props.onDelete}
      >
        {t('删除')}
      </button>
    </div>,
    document.body,
  );
}

function AssetMenuActions(props: AssetMenuPortalProps & { asset: MediaAsset }) {
  const { asset } = props;
  const t = useT();
  return (
    <>
      {!props.missing && <AssetExportButton asset={asset} fps={props.fps} onError={props.onError} onComplete={props.onClose} />}
      {props.onTranscribe && <button type="button" onClick={props.onTranscribe}>{asset.transcribeStatus === 'failed' ? t('重新转写') : t('转写')}</button>}
      <button type="button" onClick={props.onFavorite}>{asset.favorite ? t('取消收藏') : t('收藏')}</button>
      <button type="button" onClick={props.onRename}>{t('重命名')}</button>
      {props.canRelink && asset.kind !== 'motion-graphic' && <button type="button" onClick={props.onRelink}>{t('重新链接文件')}</button>}
      {props.canRemove && <button type="button" className="danger" onClick={props.onRemove}>{props.confirmDelete ? t('确认删除') : t('删除')}</button>}
      <label className="cc-asset-menu-move">
        <span>{t('移动到')}</span>
        <select aria-label={t('移动 {name}', { name: asset.name })} value={asset.folderId ?? ''} onChange={(event) => props.onMove(event.target.value || undefined)}>
          <option value="">Master</option>
          {props.folders.map((folder) => <option key={folder.id} value={folder.id}>{folderPath(folder, props.folders)}</option>)}
        </select>
      </label>
      <AssetMenuDestinations assetName={asset.name} onAddTimeline={props.onAddTimeline} onAddChat={props.onAddChat} />
    </>
  );
}

export function MissingMediaBanner({ count, onOpen }: { count: number; onOpen: () => void }) {
  const t = useT();
  if (count === 0) return null;
  return (
    <div className="cc-media-missing-banner" style={{
      display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
      margin: '0 10px 8px', padding: '8px 10px', borderRadius: 4,
      background: theme.panelAlt, border: `0.5px solid ${theme.border}`,
      borderLeft: `2px solid ${theme.accent}`, fontSize: 12, color: theme.textMuted,
    }}>
      <span style={{ flex: 1, minWidth: 140 }}>
        {t('有 {n} 个素材丢失或无法加载。选择文件夹搜索，或从行内重新链接。', { n: count })}
      </span>
      <button type="button" onClick={onOpen} style={{
        background: theme.hover, color: theme.text, border: `0.5px solid ${theme.border}`, borderRadius: 3,
        padding: '4px 10px', fontSize: 12, fontWeight: 600, cursor: 'pointer',
      }}>
        {t('重新链接离线素材')}
      </button>
    </div>
  );
}

interface RelinkAllDialogProps {
  open: boolean;
  busy: boolean;
  message: string | null;
  missingAssets: MediaAsset[];
  inputRef: RefObject<HTMLInputElement | null>;
  onClose: () => void;
  onPickFolder: (files: FileList | null) => void;
  onRelink: (id: string) => void;
}

export function RelinkAllDialog(props: RelinkAllDialogProps) {
  const t = useT();
  if (!props.open) return null;
  return (
    <div className="cc-modal-backdrop" role="dialog" aria-modal="true" aria-label={t('重新链接离线素材')} onClick={props.onClose}>
      <div className="cc-modal" style={{ width: 'min(420px, 92vw)', maxHeight: '70vh', overflow: 'auto' }} onClick={(event) => event.stopPropagation()}>
        <strong>{t('重新链接离线素材')}</strong>
        <p style={{ margin: '8px 0 12px', fontSize: 12, color: theme.textMuted, lineHeight: 1.45 }}>{t('工程中的文件已移动或重命名。选一个文件夹按文件名批量重链，或从下方逐个重新链接。')}</p>
        <input
          ref={(node) => {
            props.inputRef.current = node;
            // React does not understand webkitdirectory; without it the button
            // opens a plain file picker and folder relink can never work.
            node?.setAttribute('webkitdirectory', '');
            node?.setAttribute('directory', '');
          }}
          type="file" multiple hidden onChange={(event) => props.onPickFolder(event.target.files)}
        />
        <button type="button" className="primary" disabled={props.busy} onClick={() => props.inputRef.current?.click()} style={{ width: '100%', marginBottom: 10 }}>
          {props.busy ? t('正在按文件名匹配…') : t('选择文件夹批量重链（按文件名匹配）')}
        </button>
        {props.message && <div style={{ fontSize: 12, color: `color-mix(in srgb, ${theme.success} 65%, ${theme.textStrong})`, margin: '0 0 10px' }}>{props.message}</div>}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {props.missingAssets.map((asset) => <RelinkRow key={asset.id} asset={asset} onRelink={props.onRelink} />)}
          {props.missingAssets.length === 0 && <div style={{ fontSize: 12, color: theme.textDim }}>{t('没有待重链的素材')}</div>}
        </div>
        <div style={{ marginTop: 12 }}><button type="button" onClick={props.onClose}>{t('关闭')}</button></div>
      </div>
    </div>
  );
}

function RelinkRow({ asset, onRelink }: { asset: MediaAsset; onRelink: (id: string) => void }) {
  const t = useT();
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', borderRadius: 4, background: theme.panelAlt }}>
      <span style={{ flex: 1, fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{asset.name}</span>
      <button type="button" className="primary" onClick={() => onRelink(asset.id)} style={{ flexShrink: 0 }}>{t('重新链接文件')}</button>
    </div>
  );
}
