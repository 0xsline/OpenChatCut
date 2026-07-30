import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  memo,
  useRef,
  useMemo,
  useState,
  type DragEvent,
  type ReactNode,
} from 'react';
import { theme } from '../theme';
import { t as translate, useT } from '../i18n/locale';
import { setLibraryDrag, type LibraryDragKind } from './drag';
import { useFixedVirtualGrid } from '../hooks/useFixedVirtualGrid';

// Generic resource-library category browser (Transition/Special Effects/Scale/LUT).
// `layout="grid"` uses cards with a thumbnail and label;
// `layout="list"` is the denser list used by some categories.
//
// Grid cards never use native `disabled` — browsers suppress mouseenter on
// disabled <button>, which suppresses hover previews.
// Cards are always draggable onto the timeline (apply on drop even if nothing
// is selected). Click still requires a selected target when applicable.

export interface ResourceItem {
  id: string;
  name: string;
  desc?: string;
  badge?: string;
  /** Plugin entry: application data taken away with the drag payload (see drag.ts LibraryDragPayload.data) */
  data?: unknown;
  /** Plugin item preview image (data:image/* or URL); if available, use the card directly */
  thumb?: string;
}

interface ResourceBrowserProps {
  /** what this category applies to, e.g. "Click to apply to the selected fragment" */
  hint: string;
  items: ResourceItem[];
  onApply: (id: string) => void;
  /** is the current selection a valid target? */
  applicable: boolean;
  /** when set, cards are non-clickable and this explains why (e.g. LUT blocked) */
  disabledNote?: string;
  /** optional preview thumbnail (data URL) per item id */
  thumb?: (id: string) => string;
  /**
   * custom thumb renderer (e.g. animated GLSL transition while active).
   * `active` is shared across the browser and true for at most one hovered/focused card.
   */
  renderThumb?: (id: string, active: boolean) => ReactNode;
  /** List (default) or card-grid layout. */
  layout?: 'list' | 'grid';
  /** enable HTML5 drag onto timeline clips (kind in payload) */
  dragKind?: LibraryDragKind;
}

type Translate = typeof translate;
type PreviewCleanup = () => void;
type RegisterPreviewCleanup = (cleanup: PreviewCleanup) => void;

const PreviewCleanupContext = createContext<RegisterPreviewCleanup | null>(null);

export function useResourcePreviewCleanup(cleanup: PreviewCleanup): void {
  const register = useContext(PreviewCleanupContext);
  useEffect(() => {
    register?.(cleanup);
  }, [cleanup, register]);
}

interface ActiveInteraction {
  scope: LibraryDragKind | undefined;
  pointerId: string | null;
  focusId: string | null;
}

interface ResourceCardProps {
  item: ResourceItem;
  active: boolean;
  clickable: boolean;
  canDrag: boolean;
  renderThumb?: ResourceBrowserProps['renderThumb'];
  thumb?: ResourceBrowserProps['thumb'];
  onApply: (id: string) => void;
  onDragStart: (event: DragEvent<HTMLButtonElement>, item: ResourceItem) => void;
  onPointerChange: (id: string | null) => void;
  onFocusChange: (id: string | null) => void;
  onDragChange: (id: string | null) => void;
  t: Translate;
}

function resourceCardTitle(item: ResourceItem, clickable: boolean, canDrag: boolean, t: Translate): string {
  if (clickable) return t('点击应用 / 拖到时间线：{name}', { name: item.name });
  if (canDrag) return t('拖到时间线片段：{name}', { name: item.name });
  return t('预览：{name}（选中片段后可应用）', { name: item.name });
}

const ResourceCard = memo(function ResourceCard(props: ResourceCardProps) {
  const { item, active, clickable, canDrag, renderThumb, thumb, onApply, onDragStart } = props;
  const src = renderThumb ? '' : (thumb?.(item.id) ?? '');
  const classes = `cc-resource-card${clickable ? '' : ' disabled'}${active ? ' hovered' : ''}${canDrag ? ' draggable' : ''}`;
  return (
    <button
      type="button"
      aria-disabled={!clickable}
      draggable={canDrag}
      onDragStart={(event) => { props.onDragChange(item.id); onDragStart(event, item); }}
      onDragEnd={() => props.onDragChange(null)}
      onClick={() => { if (clickable) onApply(item.id); }}
      title={resourceCardTitle(item, clickable, canDrag, props.t)}
      className={classes}
      onPointerEnter={() => props.onPointerChange(item.id)}
      onPointerLeave={() => props.onPointerChange(null)}
      onFocus={() => props.onFocusChange(item.id)}
      onBlur={() => props.onFocusChange(null)}
    >
      <div className="cc-resource-thumb">
        {renderThumb
          ? renderThumb(item.id, active)
          : src
            ? <img src={src} alt="" draggable={false} loading="lazy" decoding="async" />
            : <span className="cc-resource-thumb-placeholder" />}
      </div>
      <div className="cc-resource-name">{props.t(item.name)}</div>
    </button>
  );
});

interface ResourceGridProps extends Omit<ResourceCardProps, 'item' | 'active'> {
  items: ResourceItem[];
  activeId: string | null;
  draggedId: string | null;
}

function ResourceGrid({ items, activeId, draggedId, ...cardProps }: ResourceGridProps) {
  const { onPointerChange } = cardProps;
  const pinnedIndexes = useMemo(() => {
    const ids = new Set([activeId, draggedId].filter((id): id is string => id != null));
    const indexes: number[] = [];
    items.forEach((item, index) => {
      if (ids.has(item.id)) indexes.push(index);
    });
    return indexes;
  }, [activeId, draggedId, items]);
  const virtualGrid = useFixedVirtualGrid({
    itemCount: items.length,
    cardWidth: 118,
    rowHeight: 98,
    columnGap: 8,
    rowGap: 10,
    overscanRows: 1,
    pinnedIndexes,
  });
  useEffect(() => {
    const activeIndex = items.findIndex((item) => item.id === activeId);
    if (activeIndex >= 0
      && (activeIndex < virtualGrid.visibleStartIndex || activeIndex >= virtualGrid.visibleEndIndex)) {
      onPointerChange(null);
    }
  }, [activeId, items, onPointerChange, virtualGrid.visibleEndIndex, virtualGrid.visibleStartIndex]);
  return (
    <div ref={virtualGrid.containerRef} className="cc-resource-grid" style={{ height: virtualGrid.totalHeight }}>
      {virtualGrid.rows.map((row) => (
        <div
          key={row.rowIndex}
          className="cc-resource-virtual-row"
          style={{
            top: row.top,
            height: virtualGrid.rowHeight,
            gridTemplateColumns: `repeat(${virtualGrid.columnCount}, ${virtualGrid.columnWidth}px)`,
          }}
        >
          {items.slice(row.startIndex, row.endIndex).map((item) => (
            <ResourceCard key={item.id} item={item} active={activeId === item.id} {...cardProps} />
          ))}
        </div>
      ))}
    </div>
  );
}

interface ResourceListItemProps {
  item: ResourceItem;
  clickable: boolean;
  canDrag: boolean;
  thumb?: ResourceBrowserProps['thumb'];
  onApply: (id: string) => void;
  onDragStart: (event: DragEvent<HTMLButtonElement>, item: ResourceItem) => void;
  onDragChange: (id: string | null) => void;
  t: Translate;
}

const ResourceListItem = memo(function ResourceListItem({ item, clickable, canDrag, thumb, onApply, onDragStart, onDragChange, t }: ResourceListItemProps) {
  const src = thumb?.(item.id) ?? '';
  const title = clickable
    ? t('应用到选中片段：{name}', { name: item.name })
    : canDrag ? t('拖到时间线：{name}', { name: item.name }) : undefined;
  return (
    <button
      className="cc-resource-list-item"
      type="button"
      aria-disabled={!clickable}
      draggable={canDrag}
      onDragStart={(event) => { onDragChange(item.id); onDragStart(event, item); }}
      onDragEnd={() => onDragChange(null)}
      onClick={() => { if (clickable) onApply(item.id); }}
      title={title}
      style={{
        cursor: canDrag || clickable ? 'grab' : 'default', textAlign: 'left', display: 'flex',
        flexDirection: 'column', gap: 3, padding: '9px 11px', border: `0.5px solid ${theme.border}`,
        borderRadius: 4, background: theme.panelAlt, color: clickable || canDrag ? theme.text : theme.textDim,
        opacity: clickable || canDrag ? 1 : 0.55,
      }}
    >
      {src ? <img src={src} alt="" draggable={false} loading="lazy" decoding="async"
        style={{ width: '100%', height: 66, objectFit: 'cover', borderRadius: 5, marginBottom: 5, background: theme.inset }} /> : null}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: 12.5, fontWeight: 500 }}>{t(item.name)}</span>
        {item.badge && <span style={{ fontSize: 9, color: theme.accent, border: `0.5px solid ${theme.accent}`, borderRadius: 3, padding: '0 3px' }}>{t(item.badge)}</span>}
      </div>
      {item.desc && <span style={{ fontSize: 10.5, color: theme.textDim, lineHeight: 1.35 }}>{t(item.desc)}</span>}
    </button>
  );
});

function runPreviewCleanups(cleanups: ReadonlySet<PreviewCleanup>): void {
  for (const cleanup of cleanups) cleanup();
}

interface ActivePreview {
  activeId: string | null;
  setPointerId: (id: string | null) => void;
  setFocusId: (id: string | null) => void;
}

function useActivePreview(scope: LibraryDragKind | undefined): ActivePreview {
  const [interaction, setInteraction] = useState<ActiveInteraction>({
    scope, pointerId: null, focusId: null,
  });
  const setPointerId = useCallback((pointerId: string | null) => {
    setInteraction((current) => ({ ...current, scope, pointerId }));
  }, [scope]);
  const setFocusId = useCallback((focusId: string | null) => {
    setInteraction((current) => ({ ...current, scope, focusId }));
  }, [scope]);
  const activeId = interaction.scope === scope ? interaction.focusId ?? interaction.pointerId : null;
  return { activeId, setPointerId, setFocusId };
}

function usePreviewCleanupRegistration(scope: LibraryDragKind | undefined): RegisterPreviewCleanup {
  const cleanups = useRef(new Set<PreviewCleanup>());
  const register = useCallback((cleanup: PreviewCleanup) => {
    cleanups.current.add(cleanup);
  }, []);
  useEffect(() => () => runPreviewCleanups(cleanups.current), [scope]);
  return register;
}

export function ResourceBrowser({
  hint, items, onApply, applicable, disabledNote, thumb, renderThumb, layout = 'list', dragKind,
}: ResourceBrowserProps) {
  const t = useT();
  const registerCleanup = usePreviewCleanupRegistration(dragKind);
  const { activeId, setPointerId, setFocusId } = useActivePreview(dragKind);
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const clickable = applicable && !disabledNote;
  const canDrag = !!dragKind && !disabledNote;
  const hintText = disabledNote
    ? t(disabledNote)
    : applicable
      ? `${t(hint)}${canDrag ? t(' · 也可拖到时间线片段上') : ''}`
      : `${t(hint)}${t('（先在时间线选中，或直接拖到片段上）')}`;
  const onDragStart = useCallback((event: DragEvent<HTMLButtonElement>, item: ResourceItem) => {
    if (!canDrag || !dragKind) return;
    setLibraryDrag(event, {
      kind: dragKind, id: item.id, name: item.name,
      ...(item.data !== undefined ? { data: item.data } : {}),
    });
  }, [canDrag, dragKind]);
  return (
    <PreviewCleanupContext.Provider value={registerCleanup}>
      <div className={layout === 'grid' ? 'cc-resource-browser' : undefined}
        style={layout === 'list' ? { display: 'flex', flexDirection: 'column', gap: 8 } : undefined}>
        <div className={layout === 'grid' ? 'cc-resource-hint' : undefined}
          style={{ color: disabledNote ? theme.accent : theme.textDim }}>
          {hintText}
        </div>
        {layout === 'grid' ? (
          <ResourceGrid items={items} activeId={activeId} draggedId={draggedId}
            clickable={clickable} canDrag={canDrag} renderThumb={renderThumb} thumb={thumb}
            onApply={onApply} onDragStart={onDragStart} onDragChange={setDraggedId}
            onPointerChange={setPointerId} onFocusChange={setFocusId} t={t} />
        ) : items.map((item) => (
          <ResourceListItem key={item.id} item={item} clickable={clickable} canDrag={canDrag}
            thumb={thumb} onApply={onApply} onDragStart={onDragStart} onDragChange={setDraggedId} t={t} />
        ))}
      </div>
    </PreviewCleanupContext.Provider>
  );
}
