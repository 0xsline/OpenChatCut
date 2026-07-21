import { memo, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { theme, themeAlpha } from '../theme';
import { tData, useT } from '../i18n/locale';
import { usePersistedState } from '../hooks/usePersistedState';
import { ratioLabel } from '../editor/types';
import type { Tpl } from '../types';
import { Icon } from '../components/icons';
import { setLibraryDrag } from './drag';
import { loadRecentTemplateIds, pushRecentTemplateId } from '../persist/sessionPrefs';

// MG 动画 browser: a horizontal chip row
// [收藏, 最近, 热门, <categories by count>] filters the card grid; cards show a
// ⭐ favorite toggle + a ⋮ menu (添加到时间线 / 用 AI 生成 / 删除) on hover.
// Data model: 收藏 = per-user collected (persisted to localStorage),
// 最近 = last-added template ids (local), 热门 = full gallery default.
// 删除 = 软删除(本地隐藏列表),时间线已用片段不受影响;内置/插件条目均可从列表移除。
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
  /** 从资源库列表移除的模板 id(软删除,持久化;不影响时间线已插入片段) */
  const [hidden, setHidden] = usePersistedState<string[]>('cc.hiddenTemplates', []);
  const [recents, setRecents] = useState<string[]>(() => loadRecentTemplateIds());
  const [chip, setChip] = usePersistedState<string>('cc.templateChip', POPULAR);
  const [hovered, setHovered] = useState<string | null>(null);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [menuPos, setMenuPos] = useState<{ top: number; left: number } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const favSet = useMemo(() => new Set(favs), [favs]);
  const hiddenSet = useMemo(() => new Set(hidden), [hidden]);
  const toggleFav = (id: string) =>
    setFavs((f) => (f.includes(id) ? f.filter((x) => x !== id) : [...f, id]));
  const hideTemplate = (id: string) => {
    setHidden((h) => (h.includes(id) ? h : [...h, id]));
    setFavs((f) => f.filter((x) => x !== id));
  };
  const remember = (tpl: Tpl) => setRecents(pushRecentTemplateId(tpl.id));
  const addAndRemember = (tpl: Tpl) => { remember(tpl); onAdd(tpl); };

  const closeMenu = () => {
    setMenuFor(null);
    setMenuPos(null);
    setConfirmDelete(false);
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

  // 可见列表(已软删除的不进 chips/网格)
  const visible = useMemo(
    () => templates.filter((t) => !hiddenSet.has(t.id)),
    [templates, hiddenSet],
  );

  // chips: 收藏, 最近, 热门, then categories sorted by descending count
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

  const menuTpl = menuFor ? shown.find((t) => t.id === menuFor) ?? visible.find((t) => t.id === menuFor) : null;

  const chipStyle = (active: boolean): React.CSSProperties => ({
    flexShrink: 0, cursor: 'pointer', fontSize: 12, padding: '4px 12px', borderRadius: 999,
    border: `0.5px solid ${active ? theme.text : theme.border}`,
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
    setConfirmDelete(false);
    setMenuFor(tpId);
    setMenuPos({ top, left });
  };

  return (
    <>
      {/* chip row (horizontally scrollable) */}
      <div style={{ display: 'flex', gap: 8, overflowX: 'auto', paddingBottom: 10, marginBottom: 4 }}>
        {chips.map((c) => (
          <button key={c} onClick={() => { setChip(c); closeMenu(); }} style={chipStyle(chip === c)}>
            {c === FAV ? <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><Icon name="star" size={12} />{t('收藏')}</span> : c === RECENT ? t('最近') : c === POPULAR ? t('热门') : t(catLabel(c))}
          </button>
        ))}
      </div>

      {chip === FAV && shown.length === 0 ? (
        <div style={{ color: theme.textDim, fontSize: 12, padding: '20px 8px', textAlign: 'center' }}>{t('还没有收藏的模板。将鼠标移到卡片上点 ★ 收藏。')}</div>
      ) : chip === RECENT && shown.length === 0 ? (
        <div style={{ color: theme.textDim, fontSize: 12, padding: '20px 8px', textAlign: 'center' }}>{t('还没有最近使用的模板。点卡片或拖到时间线后会出现在这里。')}</div>
      ) : (
        /* 统一 16:9 卡片盒:竖版(9:16)缩略图居中 contain 展示、两侧用模糊放大的
           自身画面垫底(视频平台竖内容惯例),卡片高度与横版一致不再窜层。 */
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(120px, 1fr))', gap: 10 }}>
          {shown.map((tp) => {
            const isFav = favSet.has(tp.id);
            const isHover = hovered === tp.id;
            const showActions = isHover || menuFor === tp.id || isFav;
            const portrait = (tp.height ?? 0) > (tp.width ?? 1);
            return (
              <div
                key={tp.id}
                draggable
                onDragStart={(e) => {
                  remember(tp);
                  // 插件模板不在 drop 端的 TEMPLATES 里,Tpl 全量随 payload 走
                  setLibraryDrag(e, { kind: 'template', id: tp.id, name: tp.name, ...(tp.id.startsWith('plugin:') ? { data: tp } : {}) });
                }}
                onMouseEnter={() => setHovered(tp.id)}
                onMouseLeave={() => setHovered((h) => (h === tp.id ? null : h))}
                style={{
                  position: 'relative',
                  border: `0.5px solid ${isHover ? theme.borderLight : theme.border}`,
    borderRadius: 4,
                  background: theme.panelAlt,
                  // Keep overflow hidden so thumb corners clip; menu is portaled to body.
                  overflow: 'hidden',
                  minWidth: 0,
                  cursor: 'grab',
                  boxShadow: isHover ? `0 8px 24px ${themeAlpha.shadow(0.35)}` : 'none',
                  transition: 'border-color .18s ease, box-shadow .18s ease',
                }}
              >
                <button onClick={() => addAndRemember(tp)} title={t('点击或拖到时间线：{name}', { name: tp.name })}
                  style={{ cursor: 'inherit', textAlign: 'left', padding: 0, width: '100%', display: 'block', border: 'none', background: 'none', color: theme.text }}>
                  {/* 两层图都绝对定位铺满:百分比高度在 grid 轨道里会解析失败,
                      contain 退化成裁切(9:16 曾被裁成横条)——绝对定位对着
                      aspectRatio 盒子解析,信箱式居中才稳定成立。 */}
                  <div style={{ aspectRatio: '16 / 9', position: 'relative', background: theme.bg, overflow: 'hidden' }}>
                    {tp.thumb ? (
                      <>
                        {portrait && (
                          <img src={tp.thumb} alt="" aria-hidden loading="lazy" draggable={false}
                            style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover', filter: 'blur(16px) brightness(0.5)', transform: 'scale(1.25)' }} />
                        )}
                        <img src={tp.thumb} alt={tData(tp.name)} loading="lazy" draggable={false}
                          style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: portrait ? 'contain' : 'cover', transform: isHover ? 'scale(1.035)' : 'none', transition: 'transform .3s ease' }} />
                      </>
                    ) : <span style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', fontSize: 20, color: theme.textDim }}>＋</span>}
                  </div>
                  <div style={{ padding: '6px 8px 7px', display: 'flex', alignItems: 'center', gap: 6, minWidth: 0, boxSizing: 'border-box' }}>
                    <span style={{
                      flex: 1, fontSize: 10.5, lineHeight: 1.3,
                      whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0,
                    }}>{tData(tp.name)}</span>
                    <span style={{
                      flexShrink: 0, fontSize: 8.5, color: theme.textDim, lineHeight: 1.4,
                      border: `0.5px solid ${theme.border}`, borderRadius: 4, padding: '0.5px 4px',
                    }}>{ratioLabel(tp.width, tp.height)}</span>
                  </div>
                </button>

                {/* hover actions: ★ favorite (top-left) + ⋮ menu (top-right) */}
                {showActions && (
                  <>
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); toggleFav(tp.id); }}
                      title={isFav ? t('取消收藏') : t('收藏')}
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
                      title={t('更多操作')}
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
              onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--cc-hover)'; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'none'; }}
            >≡ {t('添加到时间线')}</button>
            <button
              type="button"
              role="menuitem"
              onClick={() => { onUseAI(menuTpl); closeMenu(); }}
              style={{ ...menuItem, display: 'inline-flex', alignItems: 'center', gap: 6 }}
              onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--cc-hover)'; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'none'; }}
            ><Icon name="sparkles" size={13} />{t('用 AI 生成')}</button>
            <div style={{ height: 0.5, background: theme.border, margin: '4px 6px' }} />
            {confirmDelete ? (
              <div style={{ display: 'flex', gap: 4, padding: '2px 4px 4px' }}>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => { hideTemplate(menuTpl.id); closeMenu(); }}
                  style={{ ...menuItem, flex: 1, color: theme.danger, textAlign: 'center', padding: '7px 4px' }}
                  onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--cc-hover)'; }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = 'none'; }}
                >{t('确认删除')}</button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => setConfirmDelete(false)}
                  style={{ ...menuItem, flex: 1, color: theme.textDim, textAlign: 'center', padding: '7px 4px' }}
                  onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--cc-hover)'; }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = 'none'; }}
                >{t('取消')}</button>
              </div>
            ) : (
              <button
                type="button"
                role="menuitem"
                onClick={() => setConfirmDelete(true)}
                title={t('从资源库列表移除(本地隐藏);时间线已用片段不受影响')}
                style={{ ...menuItem, color: theme.danger }}
                onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--cc-hover)'; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = 'none'; }}
              >{t('删除')}</button>
            )}
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
