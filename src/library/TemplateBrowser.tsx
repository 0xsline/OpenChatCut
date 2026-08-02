import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { theme, themeAlpha } from '../theme';
import { tData, useT } from '../i18n/locale';
import { usePersistedState } from '../hooks/usePersistedState';
import { ratioLabel } from '../editor/types';
import type { Tpl } from '../types';
import { Icon } from '../components/icons';
import { setLibraryDrag } from './drag';
import { loadRecentTemplateIds, pushRecentTemplateId } from '../persist/sessionPrefs';
import { useFixedVirtualGrid } from '../hooks/useFixedVirtualGrid';
import { LIBRARY_CARD_GRID_METRICS } from './libraryCardGrid';
import {
  createHorizontalTabDrag,
  getHorizontalTabRevealDirection,
  revealHorizontalTab,
} from './resourceTabDrag';

// MG animation browser: a horizontal chip row
// [Collection, recent, popular, <categories by count>] filters the card grid; cards show a
// ⭐ favorite toggle + a ⋮ menu (add to timeline / generate with AI / delete) on hover.
// Data model: collection = per-user collected (persisted to localStorage),
// recent = last-added template ids (local), popular = full gallery default.
// Delete = soft delete (local hidden list), used clips in the timeline are not affected; built-in/plugin entries can be removed from the list.
// Category ids come straight from the template `category`.

// Category id → Chinese label.
const CAT_LABEL: Record<string, string> = {
  'call-to-action': '行动号召',
  'data-visualization': '数据可视化',
  infographics: '信息图表',
  'lower-thirds': '下三分之一字幕',
  'quote-cards': '引用卡片',
  'social-ui': '社交界面',
  'talking-head-overlays': '出镜叠加',
  'text-effects': '文字特效',
  'title-cards': '标题卡片',
  'social-media': '社交媒体',
  'social-shorts': '竖屏自媒体',
  'koubo-scenes': '口播场景',
  插件: '插件',
  扩展: '扩展',
  uncategorized: '未分类',
};
const catLabel = (id: string) => CAT_LABEL[id] ?? id.replace(/-/g, ' ');

const FAV = '__fav__';
const RECENT = '__recent__';
const POPULAR = '__popular__';
const MENU_W = 168;
const MENU_H = 148;

interface TemplateBrowserProps {
  templates: Tpl[];
  onAdd: (tpl: Tpl) => void;
  onUseAI: (tpl: Tpl) => void;
}

export const TemplateBrowser = memo(function TemplateBrowser({ templates, onAdd, onUseAI }: TemplateBrowserProps) {
  const t = useT();
  const [favs, setFavs] = usePersistedState<string[]>('cc.favTemplates', []);
  /** Template id removed from the resource library list (soft deletion, persistence; does not affect the inserted clips in the timeline) */
  const [hidden, setHidden] = usePersistedState<string[]>('cc.hiddenTemplates', []);
  const [recents, setRecents] = useState<string[]>(() => loadRecentTemplateIds());
  const recentsRef = useRef(recents);
  const [chip, setChip] = usePersistedState<string>('cc.templateChip', POPULAR);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [menuPos, setMenuPos] = useState<{ top: number; left: number } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const chipScrollRef = useRef<HTMLDivElement | null>(null);
  const chipDragRef = useRef<ReturnType<typeof createHorizontalTabDrag> | null>(null);
  const suppressChipClickRef = useRef(false);
  const favSet = useMemo(() => new Set(favs), [favs]);
  const hiddenSet = useMemo(() => new Set(hidden), [hidden]);
  const toggleFav = useCallback((id: string) => {
    setFavs((current) => current.includes(id)
      ? current.filter((candidate) => candidate !== id)
      : [...current, id]);
  }, [setFavs]);
  const hideTemplate = useCallback((id: string) => {
    setHidden((current) => current.includes(id) ? current : [...current, id]);
    setFavs((current) => current.filter((candidate) => candidate !== id));
  }, [setFavs, setHidden]);
  const remember = useCallback((tpl: Tpl) => {
    const current = recentsRef.current;
    const next = pushRecentTemplateId(tpl.id, current);
    if (next === current) return;
    recentsRef.current = next;
    setRecents(next);
  }, []);
  const addAndRemember = useCallback((tpl: Tpl) => {
    remember(tpl);
    onAdd(tpl);
  }, [onAdd, remember]);

  const closeMenu = useCallback(() => {
    setMenuFor(null);
    setMenuPos(null);
    setConfirmDelete(false);
  }, []);

  // Close portal menu on scroll / resize so it doesn't float away from the card.
  useEffect(() => {
    if (!menuFor) return;
    const onDismiss = () => closeMenu();
    window.addEventListener('scroll', onDismiss, true);
    window.addEventListener('resize', onDismiss);
    return () => {
      window.removeEventListener('scroll', onDismiss, true);
      window.removeEventListener('resize', onDismiss);
    };
  }, [closeMenu, menuFor]);

  // Visible list (soft deleted ones are not included in chips/grid)
  const visible = useMemo(
    () => templates.filter((t) => !hiddenSet.has(t.id)),
    [templates, hiddenSet],
  );

  // chips: favorites, recent, popular, then categories sorted by descending count
  const chips = useMemo(() => {
    const counts = new Map<string, number>();
    for (const t of visible) counts.set(t.category, (counts.get(t.category) ?? 0) + 1);
    const cats = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([c]) => c);
    return [FAV, RECENT, POPULAR, ...cats];
  }, [visible]);

  const shown = useMemo(() => {
    if (chip === FAV) return visible.filter((t) => favSet.has(t.id));
    if (chip === RECENT) {
      const byId = new Map(visible.map((t) => [t.id, t]));
      return recents.map((id) => byId.get(id)).filter((t): t is Tpl => !!t);
    }
    if (chip === POPULAR) return visible;
    return visible.filter((t) => t.category === chip);
  }, [visible, chip, favSet, recents]);

  const pinnedIndexes = useMemo(() => {
    const pinnedIds = new Set([menuFor, focusedId, draggedId].filter((id): id is string => id != null));
    const indexes: number[] = [];
    shown.forEach((template, index) => {
      if (pinnedIds.has(template.id)) indexes.push(index);
    });
    return indexes;
  }, [draggedId, focusedId, menuFor, shown]);
  const virtualGrid = useFixedVirtualGrid({
    itemCount: shown.length,
    ...LIBRARY_CARD_GRID_METRICS,
    pinnedIndexes,
  });

  const menuTpl = menuFor ? shown.find((t) => t.id === menuFor) ?? visible.find((t) => t.id === menuFor) : null;

  const chipStyle = (active: boolean): React.CSSProperties => ({
    flexShrink: 0, cursor: 'pointer', fontSize: 12, padding: '4px 12px', borderRadius: 999,
    border: `0.5px solid ${active ? theme.text : theme.border}`,
    background: active ? theme.text : 'transparent',
    color: active ? theme.bg : theme.textDim, fontWeight: active ? 600 : 400, whiteSpace: 'nowrap',
  });

  const openMenu = useCallback((tpId: string, anchor: HTMLElement) => {
    if (menuFor === tpId) {
      closeMenu();
      return;
    }
    const r = anchor.getBoundingClientRect();
    const left = Math.min(window.innerWidth - MENU_W - 8, Math.max(8, r.right - MENU_W));
    const below = r.bottom + 6;
    const top = below + MENU_H > window.innerHeight - 8
      ? Math.max(8, r.top - MENU_H - 6)
      : below;
    setConfirmDelete(false);
    setMenuFor(tpId);
    setMenuPos({ top, left });
  }, [closeMenu, menuFor]);

  return (
    <>
      {/* chip row (horizontally scrollable) */}
      <div
        ref={chipScrollRef}
        className="cc-resource-tertiary-tabs cc-template-category-tabs"
        role="tablist"
        aria-label={t('MG 动画')}
        onDragStart={(event) => event.preventDefault()}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          chipDragRef.current = createHorizontalTabDrag(event, event.currentTarget);
        }}
        onPointerMove={(event) => {
          if (!chipDragRef.current?.move(event)) return;
          if (!event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.setPointerCapture(event.pointerId);
          }
          event.currentTarget.dataset.dragging = 'true';
        }}
        onPointerUp={(event) => {
          const didDrag = chipDragRef.current?.end() ?? false;
          chipDragRef.current = null;
          delete event.currentTarget.dataset.dragging;
          suppressChipClickRef.current = didDrag;
          requestAnimationFrame(() => { suppressChipClickRef.current = false; });
        }}
        onPointerCancel={(event) => {
          chipDragRef.current = null;
          suppressChipClickRef.current = false;
          delete event.currentTarget.dataset.dragging;
        }}
        onClickCapture={(event) => {
          if (!suppressChipClickRef.current) return;
          event.preventDefault();
          event.stopPropagation();
          suppressChipClickRef.current = false;
        }}
        style={{
          display: 'flex',
          gap: 8,
          overflowX: 'auto',
          paddingBottom: 10,
          marginBottom: 4,
          cursor: 'grab',
          touchAction: 'pan-y',
        }}
      >
        {chips.map((c) => (
          <button
            key={c}
            type="button"
            role="tab"
            aria-selected={chip === c}
            onClick={(event) => {
              const currentChipIndex = chips.indexOf(chip);
              const nextChipIndex = chips.indexOf(c);
              setChip(c);
              closeMenu();
              if (chipScrollRef.current) {
                revealHorizontalTab(
                  chipScrollRef.current,
                  event.currentTarget,
                  getHorizontalTabRevealDirection(currentChipIndex, nextChipIndex),
                );
              }
            }}
            style={chipStyle(chip === c)}
          >
            {c === FAV ? <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><Icon name="star" size={12} />{t('收藏')}</span> : c === RECENT ? t('最近') : c === POPULAR ? t('热门') : t(catLabel(c))}
          </button>
        ))}
      </div>

      {chip === FAV && shown.length === 0 ? (
        <div style={{ color: theme.textDim, fontSize: 12, padding: '20px 8px', textAlign: 'center' }}>{t('还没有收藏的模板。将鼠标移到卡片上点 ★ 收藏。')}</div>
      ) : chip === RECENT && shown.length === 0 ? (
        <div style={{ color: theme.textDim, fontSize: 12, padding: '20px 8px', textAlign: 'center' }}>{t('还没有最近使用的模板。点卡片或拖到时间线后会出现在这里。')}</div>
      ) : (
        /* Fixed-size rows keep scroll geometry stable while only viewport rows are mounted. */
        <div
          ref={virtualGrid.containerRef}
          className="cc-template-virtual-grid"
          style={{ position: 'relative', height: virtualGrid.totalHeight }}
        >
          {virtualGrid.rows.map((row) => (
            <div
              key={row.rowIndex}
              style={{
                position: 'absolute',
                top: row.top,
                left: 0,
                width: '100%',
                height: virtualGrid.rowHeight,
                display: 'grid',
                gridTemplateColumns: `repeat(${virtualGrid.columnCount}, ${virtualGrid.columnWidth}px)`,
                columnGap: 10,
                justifyContent: 'space-evenly',
              }}
            >
              {shown.slice(row.startIndex, row.endIndex).map((template) => (
                <TemplateCard
                  key={template.id}
                  template={template}
                  favorite={favSet.has(template.id)}
                  menuOpen={menuFor === template.id}
                  onAdd={addAndRemember}
                  onRemember={remember}
                  onToggleFavorite={toggleFav}
                  onOpenMenu={openMenu}
                  onFocusChange={setFocusedId}
                  onDragChange={setDraggedId}
                />
              ))}
            </div>
          ))}
        </div>

      )}

      {/* Portal menu — avoids clip from card overflow:hidden + scrollable grid parent */}
      {menuTpl && menuPos && createPortal(
        <>
          <div
            className="cc-asset-menu-backdrop"
            onClick={closeMenu}
            onContextMenu={(e) => { e.preventDefault(); closeMenu(); }}
          />
          <div
            role="menu"
            className="cc-media-popover cc-asset-menu-portal"
            style={{
              top: menuPos.top,
              left: menuPos.left,
              width: MENU_W,
              minWidth: MENU_W,
              background: theme.panelAlt,
              border: `0.5px solid ${theme.borderLight}`,
      borderRadius: 4,
              boxShadow: `0 8px 24px ${themeAlpha.shadow(0.5)}`,
              padding: 4,
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{
              fontSize: 11, color: theme.textDim, padding: '5px 8px',
              borderBottom: `0.5px solid ${theme.border}`,
              whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
              maxWidth: '100%',
            }} title={tData(menuTpl.name)}>{tData(menuTpl.name)}</div>
            <button
              type="button"
              role="menuitem"
              onClick={() => { addAndRemember(menuTpl); closeMenu(); }}
              style={menuItem}
            >≡ {t('添加到时间线')}</button>
            <button
              type="button"
              role="menuitem"
              onClick={() => { onUseAI(menuTpl); closeMenu(); }}
              style={{ ...menuItem, display: 'inline-flex', alignItems: 'center', gap: 6 }}
            ><Icon name="sparkles" size={13} />{t('用 AI 生成')}</button>
            <div style={{ height: 0.5, background: theme.border, margin: '4px 6px' }} />
            {confirmDelete ? (
              <div style={{ display: 'flex', gap: 4, padding: '2px 4px 4px' }}>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => { hideTemplate(menuTpl.id); closeMenu(); }}
                  style={{ ...menuItem, flex: 1, color: theme.danger, textAlign: 'center', padding: '7px 4px' }}
                >{t('确认删除')}</button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => setConfirmDelete(false)}
                  style={{ ...menuItem, flex: 1, color: theme.textDim, textAlign: 'center', padding: '7px 4px' }}
                >{t('取消')}</button>
              </div>
            ) : (
              <button
                type="button"
                role="menuitem"
                onClick={() => setConfirmDelete(true)}
                title={t('从资源库列表移除(本地隐藏);时间线已用片段不受影响')}
                style={{ ...menuItem, color: theme.danger }}
              >{t('删除')}</button>
            )}
          </div>
        </>,
        document.body,
      )}
    </>
  );
});
interface TemplateCardProps {
  template: Tpl;
  favorite: boolean;
  menuOpen: boolean;
  onAdd: (template: Tpl) => void;
  onRemember: (template: Tpl) => void;
  onToggleFavorite: (id: string) => void;
  onOpenMenu: (id: string, anchor: HTMLElement) => void;
  onFocusChange: (id: string | null) => void;
  onDragChange: (id: string | null) => void;
}

const TemplateCard = memo(function TemplateCard({
  template,
  favorite,
  menuOpen,
  onAdd,
  onRemember,
  onToggleFavorite,
  onOpenMenu,
  onFocusChange,
  onDragChange,
}: TemplateCardProps) {
  const t = useT();
  const portrait = (template.height ?? 0) > (template.width ?? 1);
  return (
    <div
      className={`cc-template-card${favorite ? ' favorite' : ''}${menuOpen ? ' menu-open' : ''}`}
      draggable
      onDragStart={(event) => {
        onDragChange(template.id);
        onRemember(template);
        setLibraryDrag(event, {
          kind: 'template',
          id: template.id,
          name: template.name,
          ...(template.id.startsWith('plugin:') ? { data: template } : {}),
        });
      }}
      onDragEnd={() => onDragChange(null)}
      onFocusCapture={() => onFocusChange(template.id)}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) onFocusChange(null);
      }}
    >
      <button
        className="cc-template-add"
        onClick={() => onAdd(template)}
        title={t('点击或拖到时间线：{name}', { name: template.name })}
      >
        <div className="cc-template-thumb">
          {template.thumb ? (
            <>
              {portrait && (
                <img
                  className="cc-template-thumb-backdrop"
                  src={template.thumb}
                  alt=""
                  aria-hidden
                  loading="lazy"
                  draggable={false}
                />
              )}
              <img
                className={`cc-template-thumb-image${portrait ? ' portrait' : ''}`}
                src={template.thumb}
                alt={tData(template.name)}
                loading="lazy"
                draggable={false}
              />
            </>
          ) : (
            <span className="cc-template-thumb-missing">＋</span>
          )}
        </div>
        <div className="cc-template-meta">
          <span className="cc-template-name">{tData(template.name)}</span>
          <span className="cc-template-ratio">{ratioLabel(template.width, template.height)}</span>
        </div>
      </button>
      <button
        type="button"
        className="cc-template-favorite"
        onClick={(event) => {
          event.stopPropagation();
          onToggleFavorite(template.id);
        }}
        title={favorite ? t('取消收藏') : t('收藏')}
      >
        <Icon name="star" size={12} filled={favorite} />
      </button>
      <button
        type="button"
        className="cc-template-more"
        onClick={(event) => {
          event.stopPropagation();
          onOpenMenu(template.id, event.currentTarget);
        }}
        title={t('更多操作')}
        aria-expanded={menuOpen}
      >
        ⋮
      </button>
    </div>
  );
});

const menuItem: React.CSSProperties = {
  display: 'block', width: '100%', textAlign: 'left', background: 'none', border: 'none',
  color: theme.text, cursor: 'pointer', fontSize: 12, padding: '7px 8px', borderRadius: 5,
  boxSizing: 'border-box',
};
