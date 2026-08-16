import { memo, useEffect, useRef, useState } from 'react';
import { Icon, type IconName } from '../components/icons';
import { MusicAnalysisBadge } from '../audio/intelligence/MusicAnalysisBadge';
import type { MusicAnalysisCardState } from '../audio/intelligence/useMusicAnalysisCards';
import type { MediaAsset, MediaFolder } from '../editor/types';
import { useT } from '../i18n/locale';
import { theme } from '../theme';
import { setMediaAssetDrag } from './drag';
import { assetIdsFromFolderDrop } from './folderDrop';
import { durationLabel, mediaRatioLabel } from './mediaPoolFormat';
import { MgThumb } from './MgThumb';
import { usePreviewMediaSource } from './previewMedia';
import { assetCanTranscribe } from '../transcript/transcribe-jobs';

interface MediaAssetCardProps {
  asset: MediaAsset;
  fps: number;
  active: boolean;
  selected: boolean;
  selectedAssetIds: readonly string[];
  missing: boolean;
  used: boolean;
  view: 'grid' | 'list';
  musicAnalysis?: MusicAnalysisCardState;
  canRelink: boolean;
  onAdd: (asset: MediaAsset) => void;
  onPointerChange: (id: string | null) => void;
  onDragChange: (id: string | null) => void;
  onFocusChange: (id: string | null) => void;
  onLoadError: (id: string) => void;
  onLoadSuccess: (id: string) => void;
  onOpenMenu: (id: string, anchor: HTMLElement, point?: { x: number; y: number }) => void;
  onRelink: (id: string) => void;
  onToggleSelected: (id: string) => void;
  onSetSelected: (ids: string[]) => void;
  onSetFavorite: (id: string, favorite: boolean) => void;
  onTranscribe?: (id: string) => void;
  onOpenTranscript?: (id: string) => void;
}


interface AssetPreviewProps {
  asset: MediaAsset;
  fps: number;
  active: boolean;
  onLoadError: (id: string) => void;
  onLoadSuccess: (id: string) => void;
}

interface ReleasableVideoProps {
  src: string;
  poster?: string;
  onError: () => void;
  onReady: () => void;
}

function releaseVideo(video: HTMLVideoElement): void {
  video.pause();
  video.removeAttribute('src');
  video.load();
}

function ReleasableVideo({ src, poster, onError, onReady }: ReleasableVideoProps) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const video = ref.current;
    if (!video) return;
    void video.play().catch(() => undefined);
    return () => releaseVideo(video);
  }, [src]);
  return (
    <video
      ref={ref}
      src={src}
      poster={poster}
      muted
      loop
      playsInline
      preload="metadata"
      draggable={false}
      onError={onError}
      onLoadedData={onReady}
    />
  );
}

function VideoPoster({ src, name }: { src?: string; name: string }) {
  const [failed, setFailed] = useState(false);
  if (!src || failed) return <Icon name="video" size={42} strokeWidth={2.2} />;
  return <img src={src} alt={name} draggable={false} onError={() => setFailed(true)} />;
}

function AssetPreview({ asset, fps, active, onLoadError, onLoadSuccess }: AssetPreviewProps) {
  const preview = usePreviewMediaSource(asset.kind === 'video' ? asset.src : undefined);
  if (asset.kind === 'image' || asset.kind === 'gif' || asset.kind === 'svg') {
    return <img src={asset.src} alt={asset.name} draggable={false} onError={() => onLoadError(asset.id)} onLoad={() => onLoadSuccess(asset.id)} />;
  }
  if (asset.kind === 'video') {
    const media = active
      ? (
        <ReleasableVideo
          key={preview.previewSrc ?? asset.src}
          src={preview.previewSrc ?? asset.src}
          poster={preview.posterSrc}
          onReady={() => onLoadSuccess(asset.id)}
          onError={() => {
            const originalFailed = preview.previewSrc === asset.src
              && (preview.proxy.status === 'failed' || preview.proxy.status === 'unavailable');
            if (originalFailed) onLoadError(asset.id);
            else preview.requestFallback();
          }}
        />
      )
      : <VideoPoster key={preview.posterSrc} src={preview.posterSrc} name={asset.name} />;
    return (
      <>
        {media}
        {preview.proxy.status === 'failed' && (
          <span className="cc-asset-preview-failed" title={preview.proxy.error}>!</span>
        )}
      </>
    );
  }
  if (asset.kind === 'motion-graphic') return <MgThumb asset={asset} fps={fps} active={active} />;
  return <Icon name="music" size={32} strokeWidth={1.35} />;
}

function previewable(asset: MediaAsset): boolean {
  return asset.kind === 'video' || asset.kind === 'motion-graphic';
}

export const MediaAssetCard = memo(function MediaAssetCard(props: MediaAssetCardProps) {
  const { asset, missing, onFocusChange, onPointerChange, view } = props;
  return (
    <div
      data-cc-media-asset-id={asset.id}
      className={`cc-asset-card${props.selected ? ' selected' : ''}${missing ? ' missing' : ''}`}
      draggable={!missing}
      onDragStart={(event) => {
        if (missing) return;
        props.onDragChange(asset.id);
        setMediaAssetDrag(event, asset, props.selected ? props.selectedAssetIds : [asset.id]);
      }}
      onDragEnd={() => props.onDragChange(null)}
      onClickCapture={(event) => {
        const target = event.target instanceof Element ? event.target : null;
        if (target?.closest('[data-music-analysis-control], .cc-asset-favorite, .cc-asset-more, .cc-asset-transcribe, .cc-asset-transcribe-status')) return;
        // Plain click selects and opens the asset menu beside the card;
        // Ctrl/Shift/meta toggles extra items. Clicking the selected card
        // again deselects it. Double-click adds to the timeline.
        if (missing) return;
        event.preventDefault();
        event.stopPropagation();
        if (event.metaKey || event.ctrlKey || event.shiftKey) {
          props.onToggleSelected(asset.id);
          return;
        }
        if (props.selected) {
          props.onToggleSelected(asset.id);
          props.onOpenMenu(asset.id, event.currentTarget as HTMLElement);
        } else {
          props.onSetSelected([asset.id]);
          props.onOpenMenu(asset.id, event.currentTarget as HTMLElement);
        }
      }}
      onDoubleClick={() => { if (!missing) props.onAdd(asset); }}
      onContextMenu={(event) => {
        if (event.target instanceof Element && event.target.closest('[data-music-analysis-control]')) return;
        event.preventDefault();
        const target = event.target instanceof Element
          ? event.target.closest<HTMLElement>('button, input, [tabindex]')
          : null;
        const point = event.clientX || event.clientY ? { x: event.clientX, y: event.clientY } : undefined;
        props.onOpenMenu(asset.id, target ?? event.currentTarget, point);
      }}
      onPointerEnter={() => { if (view === 'grid' && !missing && previewable(asset)) onPointerChange(asset.id); }}
      onPointerLeave={() => onPointerChange(null)}
      onFocusCapture={() => {
        onFocusChange(asset.id);
      }}
      onBlurCapture={(event) => {
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
        onFocusChange(null);
      }}
    >
      <AssetThumbArea {...props} />
      <button className="cc-asset-name" title={asset.name} tabIndex={-1}>{asset.name}</button>
      {!missing && props.musicAnalysis && <MusicAnalysisBadge asset={asset} state={props.musicAnalysis} />}
    </div>
  );
});

function AssetThumbArea(props: MediaAssetCardProps) {
  const { asset, active, missing } = props;
  const t = useT();
  return (
    <div className="cc-asset-thumb-wrap">
      <button
        className="cc-asset-thumb"
        title={missing ? t('点击重新链接') : t('单击选中，双击加入时间线，或拖到指定轨道：{name}', { name: asset.name })}
        style={missing ? undefined : { cursor: 'grab' }}
        onClick={() => { if (missing && props.canRelink) props.onRelink(asset.id); }}
      >
        {props.view === 'list'
          ? <AssetListIcon asset={asset} />
          : missing
            ? <MissingMedia />
            : <AssetPreview key={asset.src} asset={asset} fps={props.fps} active={active} onLoadError={props.onLoadError} onLoadSuccess={props.onLoadSuccess} />}
      </button>
      <AssetBadges {...props} />
    </div>
  );
}

function AssetListIcon({ asset }: { asset: MediaAsset }) {
  const name: IconName = asset.kind === 'audio'
    ? 'music'
    : asset.kind === 'motion-graphic'
      ? 'sparkles'
      : asset.kind === 'gif' || asset.kind === 'svg'
        ? 'image'
        : asset.kind;
  return <Icon name={name} size={16} />;
}

function MissingMedia() {
  const t = useT();
  return (
    <span style={{ display: 'grid', placeItems: 'center', gap: 4, color: theme.textMuted, fontSize: 11, padding: 8, textAlign: 'center' }}>
      <Icon name="swap" size={22} />
      {t('点击重新链接')}
    </span>
  );
}

function AssetBadges(props: MediaAssetCardProps) {
  const { asset } = props;
  const t = useT();
  const aspectLabel = mediaRatioLabel(asset.width, asset.height);
  return (
    <>
      {asset.kind === 'audio' && <span className="cc-asset-audio-mark"><Icon name="volume" size={13} strokeWidth={1.4} /></span>}
      {(asset.kind === 'gif' || asset.kind === 'svg') && <span className="cc-asset-audio-mark cc-asset-kind-mark">{asset.kind.toUpperCase()}</span>}
      {props.used && <span className="cc-asset-used-dot" title={t('正在时间线中使用')} aria-label={t('正在时间线中使用')} />}
      {aspectLabel && <span className="cc-asset-ratio">{aspectLabel}</span>}
      <span className="cc-asset-duration">{durationLabel(asset.durationInFrames, props.fps)}</span>
      <button
        type="button"
        className="cc-asset-favorite"
        aria-pressed={!!asset.favorite}
        aria-label={`${asset.favorite ? t('取消收藏') : t('收藏')}：${asset.name}`}
        title={asset.favorite ? t('取消收藏') : t('收藏')}
        onClick={(event) => {
          event.stopPropagation();
          props.onSetFavorite(asset.id, !asset.favorite);
        }}
      ><Icon name="star" size={14} strokeWidth={1.35} filled={!!asset.favorite} /></button>
      <button className="cc-asset-more" aria-label={t('管理 {name}', { name: asset.name })} onClick={(event) => {
        event.stopPropagation();
        props.onOpenMenu(asset.id, event.currentTarget);
      }}><Icon name="more" size={17} /></button>
      {props.onTranscribe && assetCanTranscribe(asset.kind, asset.transcribeStatus) && <button
        className="cc-asset-transcribe"
        aria-label={asset.transcribeStatus === 'failed' ? t('重新转写：{name}', { name: asset.name }) : t('转写：{name}', { name: asset.name })}
        title={asset.transcribeStatus === 'failed' ? t('重新转写') : t('转写')}
        onClick={(event) => {
          event.stopPropagation();
          props.onTranscribe?.(asset.id);
        }}
      ><Icon name="mic" size={14} strokeWidth={1.5} /></button>}
      {asset.transcribeStatus === 'running' && <span className="cc-asset-transcribe-status" title={t('正在转写…')}><span className="cc-asset-transcribe-spinner" /></span>}
      {asset.transcribeStatus === 'done' && <button
        className="cc-asset-transcribe-status cc-asset-transcribe-done"
        aria-label={t('查看文字稿：{name}', { name: asset.name })}
        title={props.onOpenTranscript ? t('查看文字稿') : t('已转写')}
        onClick={(event) => {
          event.stopPropagation();
          props.onOpenTranscript?.(asset.id);
        }}
      ><Icon name="check" size={14} strokeWidth={2.2} /></button>}
      {asset.transcribeStatus === 'failed' && <span className="cc-asset-transcribe-status cc-asset-transcribe-failed" title={asset.transcribeError ?? t('转写失败')}>!</span>}
    </>
  );
}

interface FolderDropTargetProps {
  label: string;
  ariaLabel: string;
  className?: string;
  icon: IconName;
  /** undefined = media pool root */
  targetFolderId?: string;
  onActivate: () => void;
  onFocusChange: (focused: boolean) => void;
  onDropFiles: (files: FileList, folderId?: string) => void;
  onMoveAsset: (id: string, folderId?: string) => void;
  onMoveAssets?: (ids: string[], folderId?: string) => void;
  /** Optional ⋯ / right-click menu (child folders only). */
  onOpenMenu?: (anchor: HTMLElement, point?: { x: number; y: number }) => void;
}

interface MediaFolderCardProps {
  folder: MediaFolder;
  onOpen: (id: string) => void;
  onFocusChange: (id: string | null) => void;
  onDropFiles: (files: FileList, folderId?: string) => void;
  onMoveAsset: (id: string, folderId?: string) => void;
  onMoveAssets?: (ids: string[], folderId?: string) => void;
  onOpenMenu?: (folderId: string, anchor: HTMLElement, point?: { x: number; y: number }) => void;
}

/** Shared droppable folder tile (child folder or "up one level"). */
function FolderDropTarget({
  label, ariaLabel, className, icon, targetFolderId,
  onActivate, onFocusChange, onDropFiles, onMoveAsset, onMoveAssets, onOpenMenu,
}: FolderDropTargetProps) {
  const t = useT();
  // Use a div (not <button>): Chromium often refuses HTML5 drops onto buttons,
  // so pool assets / OS files never land in the folder (issue #42).
  return (
    <div
      role="button"
      tabIndex={0}
      className={className ?? 'cc-folder-card'}
      aria-label={ariaLabel}
      data-cc-media-folder-id={targetFolderId}
      onClick={onActivate}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onActivate();
        }
      }}
      onFocus={() => onFocusChange(true)}
      onBlur={() => onFocusChange(false)}
      onContextMenu={(event) => {
        if (!onOpenMenu) return;
        event.preventDefault();
        event.stopPropagation();
        onOpenMenu(event.currentTarget, { x: event.clientX, y: event.clientY });
      }}
      onDragEnter={(event) => {
        event.preventDefault();
        event.stopPropagation();
        event.currentTarget.classList.add('is-drop-target');
      }}
      onDragLeave={(event) => {
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
        event.currentTarget.classList.remove('is-drop-target');
      }}
      onDragOver={(event) => {
        event.preventDefault();
        event.stopPropagation();
        // Match setMediaAssetDrag effectAllowed "copyMove": external files copy, pool assets move.
        event.dataTransfer.dropEffect = event.dataTransfer.files.length > 0 ? 'copy' : 'move';
        event.currentTarget.classList.add('is-drop-target');
      }}
      onDrop={(event) => {
        event.preventDefault();
        event.stopPropagation();
        event.currentTarget.classList.remove('is-drop-target');
        if (event.dataTransfer.files.length) {
          onDropFiles(event.dataTransfer.files, targetFolderId);
          return;
        }
        const ids = assetIdsFromFolderDrop(event);
        if (!ids.length) return;
        if (onMoveAssets) onMoveAssets(ids, targetFolderId);
        else ids.forEach((id) => onMoveAsset(id, targetFolderId));
      }}
    >
      <span className="cc-media-entry-thumb"><Icon name={icon} size={28} strokeWidth={1.4} /></span>
      <strong className="cc-media-entry-name">{label}</strong>
      {onOpenMenu && (
        <button
          type="button"
          className="cc-asset-more cc-folder-more"
          aria-label={t('文件夹菜单')}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onOpenMenu(event.currentTarget);
          }}
        >
          <Icon name="more" size={17} />
        </button>
      )}
    </div>
  );
}

export const MediaFolderCard = memo(function MediaFolderCard({
  folder, onOpen, onFocusChange, onDropFiles, onMoveAsset, onMoveAssets, onOpenMenu,
}: MediaFolderCardProps) {
  return (
    <FolderDropTarget
      label={folder.name}
      ariaLabel={folder.name}
      icon="folder"
      targetFolderId={folder.id}
      onActivate={() => onOpen(folder.id)}
      onFocusChange={(focused) => onFocusChange(focused ? folder.id : null)}
      onDropFiles={onDropFiles}
      onMoveAsset={onMoveAsset}
      onMoveAssets={onMoveAssets}
      onOpenMenu={onOpenMenu
        ? (anchor, point) => onOpenMenu(folder.id, anchor, point)
        : undefined}
    />
  );
});

interface MediaParentFolderCardProps {
  /** Parent folder id; undefined means pool root. */
  parentId?: string;
  parentName: string;
  onOpen: () => void;
  onDropFiles: (files: FileList, folderId?: string) => void;
  onMoveAsset: (id: string, folderId?: string) => void;
  onMoveAssets?: (ids: string[], folderId?: string) => void;
}

/** Inside a subfolder: open / drop back to the parent (or pool root). */
export const MediaParentFolderCard = memo(function MediaParentFolderCard({
  parentId, parentName, onOpen, onDropFiles, onMoveAsset, onMoveAssets,
}: MediaParentFolderCardProps) {
  const t = useT();
  return (
    <FolderDropTarget
      label={t('上一层')}
      ariaLabel={t('返回上级：{name}（可拖入素材移回）', { name: parentName })}
      className="cc-folder-card cc-parent-folder"
      icon="prev"
      targetFolderId={parentId}
      onActivate={onOpen}
      onFocusChange={() => undefined}
      onDropFiles={onDropFiles}
      onMoveAsset={onMoveAsset}
      onMoveAssets={onMoveAssets}
    />
  );
});
