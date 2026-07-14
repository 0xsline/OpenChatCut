import { memo, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { theme } from '../theme';
import { usePersistedState } from '../hooks/usePersistedState';
import type { Tpl } from '../types';
import { Icon } from '../components/icons';

// MG 动画 browser (source library-view template tab): a horizontal chip row
// [收藏, 热门, <categories by count>] filters the card grid; cards show a
// ⭐ favorite toggle + a ⋮ menu (添加到时间线 / 用 AI 生成) on hover.
// Source data model: 收藏 = per-user collected (we persist to localStorage),
// 热门 = server "popular" bucket (our template JSON has no popularity field →
// 热门 shows the full gallery, the sensible default landing). Category ids come
// straight from the template `category`.

// source category id → zh label (app-layout S2 map; hashes decoded from context dict)
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
  uncategorized: '未分类',
};
const catLabel = (id: string) => CAT_LABEL[id] ?? id.replace(/-/g, ' ');

const FAV = '__fav__';
const POPULAR = '__popular__';
const MENU_W = 168;
const MENU_H = 108;

interface TemplateBrowserProps {
  templates: Tpl[];
  onAdd: (tpl: Tpl) => void;
  onUseAI: (tpl: Tpl) => void;
}

export const TemplateBrowser = memo(function TemplateBrowser({ templates, onAdd, onUseAI }: TemplateBrowserProps) {
  const [favs, setFavs] = usePersistedState<string[]>('cc.favTemplates', []);
  const [chip, setChip] = useState<string>(POPULAR);
  const [hovered, setHovered] = useState<string | null>(null);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [menuPos, setMenuPos] = useState<{ top: number; left: number } | null>(null);
  const favSet = useMemo(() => new Set(favs), [favs]);
  const toggleFav = (id: string) =>
    setFavs((f) => (f.includes(id) ? f.filter((x) => x !== id) : [...f, id]));

  const closeMenu = () => {
    setMenuFor(null);
    setMenuPos(null);
  };

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
  }, [menuFor]);

  // chips: 收藏, 热门, then categories sorted by descending count
  const chips = useMemo(() => {
    const counts = new Map<string, number>();
    for (const t of templates) counts.set(t.category, (counts.get(t.category) ?? 0) + 1);
    const cats = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([c]) => c);
    return [FAV, POPULAR, ...cats];
  }, [templates]);

  const shown = useMemo(() => {
    if (chip === FAV) return templates.filter((t) => favSet.has(t.id));
    if (chip === POPULAR) return templates;
    return templates.filter((t) => t.category === chip);
  }, [templates, chip, favSet]);

  const menuTpl = menuFor ? shown.find((t) => t.id === menuFor) ?? templates.find((t) => t.id === menuFor) : null;

  const chipStyle = (active: boolean): React.CSSProperties => ({
    flexShrink: 0, cursor: 'pointer', fontSize: 12, padding: '4px 12px', borderRadius: 999,
    border: `1px solid ${active ? theme.text : theme.border}`,
    background: active ? theme.text : 'transparent',
    color: active ? theme.bg : theme.textDim, fontWeight: active ? 600 : 400, whiteSpace: 'nowrap',
  });

  const openMenu = (tpId: string, anchor: HTMLElement) => {
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
    setMenuFor(tpId);
    setMenuPos({ top, left });
  };

  return (
    <>
      {/* chip row (horizontally scrollable) */}
      <div style={{ display: 'flex', gap: 8, overflowX: 'auto', paddingBottom: 10, marginBottom: 4 }}>
        {chips.map((c) => (
          <button key={c} onClick={() => { setChip(c); closeMenu(); }} style={chipStyle(chip === c)}>
            {c === FAV ? <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><Icon name="star" size={12} />收藏</span> : c === POPULAR ? '热门' : catLabel(c)}
          </button>
        ))}
      </div>

      {chip === FAV && shown.length === 0 ? (
        <div style={{ color: theme.textDim, fontSize: 12, padding: '20px 8px', textAlign: 'center' }}>还没有收藏的模板。将鼠标移到卡片上点 ★ 收藏。</div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(120px, 1fr))', gap: 10 }}>
          {shown.map((tp) => {
            const isFav = favSet.has(tp.id);
            const showActions = hovered === tp.id || menuFor === tp.id || isFav;
            return (
              <div
                key={tp.id}
                onMouseEnter={() => setHovered(tp.id)}
                onMouseLeave={() => setHovered((h) => (h === tp.id ? null : h))}
                style={{
                  position: 'relative',
                  border: `1px solid ${theme.border}`,
                  borderRadius: 8,
                  background: theme.panelAlt,
                  // Keep overflow hidden so thumb corners clip; menu is portaled to body.
                  overflow: 'hidden',
                  minWidth: 0,
                }}
              >
                <button onClick={() => onAdd(tp)} title={`点击加到时间线：${tp.name}`}
                  style={{ cursor: 'pointer', textAlign: 'left', padding: 0, width: '100%', display: 'block', border: 'none', background: 'none', color: theme.text }}>
                  <div style={{ aspectRatio: '16 / 9', background: '#0c0c0c', display: 'grid', placeItems: 'center', overflow: 'hidden' }}>
                    {tp.thumb ? <img src={tp.thumb} alt={tp.name} loading="lazy" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                      : <span style={{ fontSize: 20, color: theme.textDim }}>＋</span>}
                  </div>
                  <div style={{
                    padding: '5px 7px', fontSize: 10.5, lineHeight: 1.3,
                    whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                    minWidth: 0, maxWidth: '100%', boxSizing: 'border-box',
                  }}>{tp.name}</div>
                </button>

                {/* hover actions: ★ favorite (top-left) + ⋮ menu (top-right) */}
                {showActions && (
                  <>
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); toggleFav(tp.id); }}
                      title={isFav ? '取消收藏' : '收藏'}
                      style={{ position: 'absolute', top: 5, left: 5, width: 22, height: 22, borderRadius: '50%', border: 'none', cursor: 'pointer', background: 'rgba(0,0,0,0.55)', color: isFav ? '#f5c518' : '#fff', fontSize: 12, lineHeight: 1, display: 'grid', placeItems: 'center' }}
                    >
                      <Icon name="star" size={12} filled={isFav} />
                    </button>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        openMenu(tp.id, e.currentTarget);
                      }}
                      title="更多操作"
                      aria-expanded={menuFor === tp.id}
                      style={{ position: 'absolute', top: 5, right: 5, width: 22, height: 22, borderRadius: '50%', border: 'none', cursor: 'pointer', background: 'rgba(0,0,0,0.55)', color: '#fff', fontSize: 13, lineHeight: 1, display: 'grid', placeItems: 'center' }}
                    >⋮</button>
                  </>
                )}
              </div>
            );
          })}
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
              border: `1px solid ${theme.borderLight}`,
              borderRadius: 8,
              boxShadow: '0 8px 24px rgba(0,0,0,0.5)',
              padding: 4,
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{
              fontSize: 11, color: theme.textDim, padding: '5px 8px',
              borderBottom: `1px solid ${theme.border}`,
              whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
              maxWidth: '100%',
            }} title={menuTpl.name}>{menuTpl.name}</div>
            <button
              type="button"
              role="menuitem"
              onClick={() => { onAdd(menuTpl); closeMenu(); }}
              style={menuItem}
              onMouseEnter={(e) => { e.currentTarget.style.background = '#303030'; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'none'; }}
            >≡ 添加到时间线</button>
            <button
              type="button"
              role="menuitem"
              onClick={() => { onUseAI(menuTpl); closeMenu(); }}
              style={{ ...menuItem, display: 'inline-flex', alignItems: 'center', gap: 6 }}
              onMouseEnter={(e) => { e.currentTarget.style.background = '#303030'; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'none'; }}
            ><Icon name="sparkles" size={13} />用 AI 生成</button>
          </div>
        </>,
        document.body,
      )}
    </>
  );
});

const menuItem: React.CSSProperties = {
  display: 'block', width: '100%', textAlign: 'left', background: 'none', border: 'none',
  color: theme.text, cursor: 'pointer', fontSize: 12, padding: '7px 8px', borderRadius: 5,
  boxSizing: 'border-box',
};
