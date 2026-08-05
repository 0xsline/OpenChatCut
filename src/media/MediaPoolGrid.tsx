import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { Icon } from '../components/icons';
import type { MediaAsset, MediaFolder } from '../editor/types';
import { useFixedVirtualGrid } from '../hooks/useFixedVirtualGrid';
import { useT } from '../i18n/locale';
import { MediaAssetCard, MediaFolderCard } from './MediaPoolCard';
import { AddSolidCanvasCard } from './AddSolidCanvasCard';
import { marqueeAssetIds, marqueeRect, type MarqueePoint } from './mediaMarquee';

export type MediaGridEntry =
  | { kind: 'solid' }
  | { kind: 'favorites' }
  | { kind: 'folder'; folder: MediaFolder }
  | { kind: 'asset'; asset: MediaAsset };

interface MediaPoolGridProps {
  entries: MediaGridEntry[];
  assetsCount: number;
  fps: number;
  view: 'grid' | 'list';
  selected: ReadonlySet<string>;
  missing: ReadonlySet<string>;
  usedAssetIds: ReadonlySet<string>;
  assetMenu: string | null;
  canRelink: boolean;
  onOpenFolder: (id: string) => void;
  onDropFiles: (files: FileList, folderId: string) => void;
  onMoveAsset: (id: string, folderId: string) => void;
  onOpenFavorites: () => void;
  onAddSolid?: () => void;
  onSetFavorite: (id: string, favorite: boolean) => void;
  onAddAsset: (asset: MediaAsset) => void;
  onLoadError: (id: string) => void;
  onLoadSuccess: (id: string) => void;
  onOpenMenu: (id: string, anchor: HTMLElement, point?: { x: number; y: number }) => void;
  onRelink: (id: string) => void;
  onToggleSelected: (id: string) => void;
  onSetSelected: (ids: string[]) => void;
}

type MarqueeState = {
  pointerId: number;
  start: MarqueePoint;
  end: MarqueePoint;
  initialSelected: Set<string>;
};

function useMediaGridWindow(props: Pick<MediaPoolGridProps, 'entries' | 'view' | 'selected' | 'assetMenu'>) {
  const [pointerId, setPointerId] = useState<string | null>(null);
  const [focusedAssetId, setFocusedAssetId] = useState<string | null>(null);
  const [focusedFolderId, setFocusedFolderId] = useState<string | null>(null);
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const activePreviewId = focusedAssetId ?? pointerId;
  const pinnedIndexes = useMemo(() => {
    const ids = new Set([props.assetMenu, activePreviewId, draggedId].filter((id): id is string => id != null));
    for (const id of props.selected) ids.add(id);
    return props.entries.flatMap((entry, index) => (
      entry.kind === 'asset' && ids.has(entry.asset.id)
        || entry.kind === 'folder' && entry.folder.id === focusedFolderId ? [index] : []
    ));
  }, [activePreviewId, draggedId, focusedFolderId, props.assetMenu, props.entries, props.selected]);
  const grid = useFixedVirtualGrid({
    itemCount: props.entries.length,
    cardWidth: props.view === 'grid' ? 104 : 1,
    rowHeight: props.view === 'grid' ? 84 : 28,
    columnGap: props.view === 'grid' ? 12 : 0,
    rowGap: props.view === 'grid' ? 12 : 0,
    overscanRows: 2,
    fixedColumnCount: props.view === 'list' ? 1 : undefined,
    pinnedIndexes,
  });
  useEffect(() => {
    if (props.view === 'list') setPointerId(null);
    const pointerIndex = props.entries.findIndex((entry) => entry.kind === 'asset' && entry.asset.id === pointerId);
    if (pointerIndex >= 0 && (pointerIndex < grid.visibleStartIndex || pointerIndex >= grid.visibleEndIndex)) setPointerId(null);
  }, [grid.visibleEndIndex, grid.visibleStartIndex, pointerId, props.entries, props.view]);
  useEffect(() => {
    if (focusedAssetId && !props.entries.some((entry) => entry.kind === 'asset' && entry.asset.id === focusedAssetId)) setFocusedAssetId(null);
    if (focusedFolderId && !props.entries.some((entry) => entry.kind === 'folder' && entry.folder.id === focusedFolderId)) setFocusedFolderId(null);
  }, [focusedAssetId, focusedFolderId, props.entries]);
  return { activePreviewId, grid, setPointerId, setFocusedAssetId, setFocusedFolderId, setDraggedId };
}

export function MediaPoolGrid(props: MediaPoolGridProps) {
  const windowState = useMediaGridWindow(props);
  const t = useT();
  const gridRef = useRef<HTMLDivElement>(null);
  const [marquee, setMarquee] = useState<MarqueeState | null>(null);
  const updateMarquee = (state: MarqueeState, end: MarqueePoint) => {
    const grid = gridRef.current;
    if (!grid) return;
    const cards = Array.from(grid.querySelectorAll<HTMLElement>('[data-cc-media-asset-id]')).flatMap((card) => {
      const id = card.dataset.ccMediaAssetId;
      if (!id) return [];
      const rect = card.getBoundingClientRect();
      return [{ id, rect: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom } }];
    });
    props.onSetSelected([...state.initialSelected, ...marqueeAssetIds(marqueeRect(state.start, end), cards)]);
  };
  const startMarquee = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const target = event.target as HTMLElement;
    if (target.closest('[data-cc-media-asset-id], button, input, select, textarea')) return;
    const state: MarqueeState = {
      pointerId: event.pointerId,
      start: { x: event.clientX, y: event.clientY },
      end: { x: event.clientX, y: event.clientY },
      initialSelected: event.metaKey || event.ctrlKey ? new Set(props.selected) : new Set(),
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    props.onSetSelected([...state.initialSelected]);
    setMarquee(state);
    event.preventDefault();
  };
  const moveMarquee = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!marquee || marquee.pointerId !== event.pointerId) return;
    const end = { x: event.clientX, y: event.clientY };
    updateMarquee(marquee, end);
    setMarquee({ ...marquee, end });
    event.preventDefault();
  };
  const finishMarquee = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!marquee || marquee.pointerId !== event.pointerId) return;
    updateMarquee(marquee, { x: event.clientX, y: event.clientY });
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    setMarquee(null);
  };
  const marqueeStyle = (() => {
    const grid = gridRef.current;
    if (!marquee || !grid) return undefined;
    const selection = marqueeRect(marquee.start, marquee.end);
    const bounds = grid.getBoundingClientRect();
    return {
      left: selection.left - bounds.left + grid.scrollLeft,
      top: selection.top - bounds.top + grid.scrollTop,
      width: selection.right - selection.left,
      height: selection.bottom - selection.top,
    };
  })();
  return (
    <div
      ref={gridRef}
      className={`cc-media-grid ${props.view}${marquee ? ' is-marquee-selecting' : ''}`}
      onPointerDown={startMarquee}
      onPointerMove={moveMarquee}
      onPointerUp={finishMarquee}
      onPointerCancel={finishMarquee}
    >
      {marqueeStyle && <div className="cc-media-marquee" aria-hidden="true" style={marqueeStyle} />}
      <MediaVirtualRows {...props} {...windowState} />
      {props.entries.length === 0 && <div className="cc-media-empty">
        {props.assetsCount === 0
          ? <><Icon name="folder" size={28} /><strong>{t('这个文件夹是空的')}</strong><span>{t('导入媒体或把素材拖到这里。')}</span></>
          : <span>{t('当前筛选下没有素材')}</span>}
      </div>}
    </div>
  );
}

function MediaVirtualRows(props: MediaPoolGridProps & ReturnType<typeof useMediaGridWindow>) {
  const t = useT();
  return (
    <div ref={props.grid.containerRef} className="cc-media-virtual-canvas" style={{ height: props.grid.totalHeight }}>
      {props.grid.rows.map((row) => <div
        key={row.rowIndex}
        className="cc-media-virtual-row"
        style={{
          top: row.top,
          height: props.grid.rowHeight,
          gridTemplateColumns: props.view === 'grid' ? `repeat(${props.grid.columnCount}, ${props.grid.columnWidth}px)` : 'minmax(0, 1fr)',
          columnGap: props.view === 'grid' ? 12 : 0,
        }}
      >
        {props.entries.slice(row.startIndex, row.endIndex).map((entry) => entry.kind === 'solid'
          ? <AddSolidCanvasCard key="solid" label={t('添加纯色背景/画布')} onAdd={() => props.onAddSolid?.()} />
          : entry.kind === 'favorites'
            ? <button key="favorites" type="button" className="cc-folder-card cc-favorites-folder" onClick={props.onOpenFavorites}>
                <span className="cc-media-entry-thumb"><Icon name="star" size={20} strokeWidth={1.4} /></span>
                <strong className="cc-media-entry-name">{t('收藏夹')}</strong>
              </button>
            : entry.kind === 'folder'
              ? <MediaFolderCard key={`folder:${entry.folder.id}`} folder={entry.folder} onOpen={props.onOpenFolder} onFocusChange={props.setFocusedFolderId} onDropFiles={props.onDropFiles} onMoveAsset={props.onMoveAsset} />
              : <MediaAssetCard
              key={`asset:${entry.asset.id}`}
              asset={entry.asset}
              fps={props.fps}
              view={props.view}
              active={props.activePreviewId === entry.asset.id}
              selected={props.selected.has(entry.asset.id)}
              selectedAssetIds={[...props.selected]}
              missing={props.missing.has(entry.asset.id)}
              used={props.usedAssetIds.has(entry.asset.id)}
              canRelink={props.canRelink}
              onAdd={props.onAddAsset}
              onPointerChange={props.setPointerId}
              onDragChange={props.setDraggedId}
              onFocusChange={props.setFocusedAssetId}
              onLoadError={props.onLoadError}
              onLoadSuccess={props.onLoadSuccess}
              onOpenMenu={props.onOpenMenu}
              onRelink={props.onRelink}
              onToggleSelected={props.onToggleSelected}
              onSetSelected={props.onSetSelected}
              onSetFavorite={props.onSetFavorite}
            />)}
      </div>)}
    </div>
  );
}
