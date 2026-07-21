import { useEffect, useMemo, useRef, useState } from 'react';
import { theme, themeAlpha } from '../../theme';
import { useT } from '../../i18n/locale';
import { Icon } from '../icons';
import {
  COLOR_ROLES, FONT_ROLES, colorOf, fontOf, type DesignStyle,
} from '../../editor/types';
import { DESIGN_STYLE_PRESETS } from '../../editor/design-presets';
import { loadOwnedStyles, saveOwnedStyle, deleteOwnedStyle, type OwnedStyle } from '../../persist/projectStore';
import { FONT_CATALOG, searchFontCatalog } from '../../fonts/googleFonts';

interface DesignStylePanelProps {
  style: DesignStyle | undefined;
  onApply: (style: DesignStyle | null) => void;
  onClose: () => void;
}

// zh labels for the canonical roles; any other (free-form) role shows its own name.
const COLOR_LABEL: Record<string, string> = {
  primary: '主色', secondary: '辅色', accent: '强调色', background: '背景', text: '文字',
};
const FONT_LABEL: Record<string, string> = { heading: '标题字体', body: '正文字体' };

const EMPTY: DesignStyle = { colors: [], fonts: [] };

/** ordered unique union: everything in `first`, then items of `rest` not already present. */
const union = (first: string[], rest: readonly string[]): string[] => {
  const seen = new Set(first);
  return [...first, ...rest.filter((r) => !seen.has(r))];
};

/** first defined color among the preferred roles. */
const pick = (s: DesignStyle, roles: string[]): string | undefined => {
  for (const r of roles) { const v = colorOf(s, r); if (v) return v; }
  return undefined;
};

/** 设计风格编辑器（manage_design_style）——预设库 + 配色/字体/品牌指引，
 * 本地草稿即时预览,「应用到工程」一次性提交(单条历史)。 */
export function DesignStylePanel({ style, onApply, onClose }: DesignStylePanelProps) {
  const t = useT();
  const [draft, setDraft] = useState<DesignStyle>(style ?? EMPTY);

  // "我的风格" — the user's own saved-style library (a GLOBAL personal
  // library, not scoped to this project).
  const [owned, setOwned] = useState<OwnedStyle[]>([]);
  const [savingName, setSavingName] = useState<string | null>(null); // null = input hidden

  useEffect(() => {
    let cancelled = false;
    loadOwnedStyles().then((list) => { if (!cancelled) setOwned(list); });
    return () => { cancelled = true; };
  }, []);

  const refreshOwned = () => { loadOwnedStyles().then(setOwned); };

  const handleDeleteOwned = async (id: string) => {
    await deleteOwnedStyle(id);
    refreshOwned();
  };

  const handleSaveOwned = async () => {
    const name = (savingName ?? '').trim();
    if (!name) return;
    if (draft.colors.length === 0 && draft.fonts.length === 0 && !draft.styleGuide) return;
    await saveOwnedStyle(name, draft);
    setSavingName(null);
    refreshOwned();
  };

  const setColor = (role: string, value: string) =>
    setDraft((d) => ({ ...d, colors: upsert(d.colors, role, value, (v) => ({ role, value: v })) }));
  const setFont = (role: string, family: string) =>
    setDraft((d) => ({ ...d, fonts: upsert(d.fonts, role, family, (f) => ({ family: f, role })) }));

  // roles are free-form (e.g. "accent copper", "Chinese heading", …) — show the
  // style's own free-form roles first, then EVERY canonical role in fixed order. 规范
  // 角色位置恒定:空角色首次赋值若按「draft 在前」推导会当场跳行(配合 upsert 原地替换)。
  const colorRoles = union(draft.colors.map((c) => c.role).filter((r) => !COLOR_ROLES.includes(r)), COLOR_ROLES);
  const fontRoles = union(draft.fonts.map((f) => f.role).filter((r) => !FONT_ROLES.includes(r)), FONT_ROLES);

  // preview: fall back through likely roles so real presets (no "primary") still render
  const bg = colorOf(draft, 'background') ?? draft.colors[0]?.value ?? theme.panel;
  const fg = colorOf(draft, 'text') ?? theme.text;
  const primary = pick(draft, ['primary', 'accent']) ?? draft.colors[0]?.value ?? theme.gold;
  const accent = pick(draft, ['accent', 'primary']) ?? draft.colors.find((c) => c.role.includes('accent'))?.value ?? theme.accent;
  const heading = fontOf(draft, 'heading') ?? draft.fonts[0]?.family ?? 'inherit';
  const body = fontOf(draft, 'body') ?? draft.fonts[1]?.family ?? 'inherit';

  return (
    <div onClick={onClose} style={backdrop}>
      <div onClick={(e) => e.stopPropagation()} style={card}>
        {/* header（窄 popover：图标 + 标题 + 关闭，长副标题在 352 宽放不下，去掉） */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px', borderBottom: `0.5px solid ${theme.border}` }}>
          <span style={{ color: primary, lineHeight: 0 }}><Icon name="palette" size={16} /></span>
          <span style={{ flex: 1, fontSize: 13, fontWeight: 600 }}>{t('设计风格')}</span>
          <button onClick={onClose} title={t('关闭')} style={iconBtn}><Icon name="x" size={15} /></button>
        </div>

        <div style={{ padding: '12px 12px 14px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 16 }}>
          {/* 风格选择器：紧凑「缩略图 64×36 + 名 12px」行、
              11px/500 暗色区块标题、选中橙点、顶部「无」卡 */}
          <section>
            <div style={sectionTitle}>{t('选择 MG 动画的视觉风格')}</div>
            <div style={styleList}>
              <StyleRow name={t('无')} selected={isEmpty(draft)} onClick={() => setDraft(EMPTY)} />
            </div>

            <div style={{ ...sectionTitle, marginTop: 12 }}>{t('预设')}</div>
            <div style={styleList}>
              {DESIGN_STYLE_PRESETS.map((p) => (
                <StyleRow key={p.id} name={p.name} title={p.style.styleGuide}
                  colors={p.style.colors.map((c) => c.value)}
                  selected={sameStyle(draft, p.style)} onClick={() => setDraft(p.style)} />
              ))}
            </div>

            {owned.length > 0 && (
              <>
                <div style={{ ...sectionTitle, marginTop: 12 }}>{t('我的风格')}</div>
                <div style={styleList}>
                  {owned.map((o) => (
                    <StyleRow key={o.id} name={o.name} title={o.style.styleGuide}
                      colors={o.style.colors.map((c) => c.value)}
                      selected={sameStyle(draft, o.style)} onClick={() => setDraft(o.style)}
                      onDelete={() => handleDeleteOwned(o.id)} />
                  ))}
                </div>
              </>
            )}
          </section>

          {/* colors (roles are free-form; hex swatch only shows for #hex values) */}
          <section>
            <div style={sectionTitle}>{t('配色')}</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 8 }}>
              {colorRoles.map((role) => {
                const value = colorOf(draft, role) ?? '';
                return (
                  <label key={role} style={colorRow}>
                    <input type="color" value={/^#[0-9a-fA-F]{6}$/.test(value) ? value : '#000000'} onChange={(e) => setColor(role, e.target.value)}
                      style={{ width: 24, height: 24, padding: 0, border: 'none', background: value || 'none', borderRadius: 4, cursor: 'pointer', flexShrink: 0 }} />
                    <span title={role} style={{ fontSize: 11, color: theme.textDim, minWidth: 40, flexShrink: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t(COLOR_LABEL[role] ?? role)}</span>
                    <input value={value} placeholder="#—" onChange={(e) => setColor(role, e.target.value)} style={hexInput} />
                  </label>
                );
              })}
            </div>
          </section>

          {/* fonts (free-form roles) */}
          <section>
            <div style={sectionTitle}>{t('字体')}</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: 10 }}>
              {fontRoles.map((role) => (
                <FontField key={role} label={FONT_LABEL[role] ?? role} role={role}
                  value={fontOf(draft, role) ?? ''} onChange={(v) => setFont(role, v)} />
              ))}
            </div>
          </section>

          {/* style guide */}
          <section>
            <div style={sectionTitle}>{t('品牌指引（可选）')}</div>
            <textarea value={draft.styleGuide ?? ''} placeholder={t('用一句话描述这个品牌的视觉倾向,AI 生成时会遵守。')}
              onChange={(e) => setDraft((d) => ({ ...d, styleGuide: e.target.value }))}
              style={{ ...textInput, minHeight: 54, resize: 'vertical', fontFamily: 'inherit' }} />
          </section>

          {/* live preview */}
          <section>
            <div style={sectionTitle}>{t('预览')}</div>
      <div style={{ background: bg, color: fg, borderRadius: 4, padding: '20px 22px', border: `0.5px solid ${theme.border}` }}>
              <div style={{ fontFamily: heading, fontSize: 26, fontWeight: 800, marginBottom: 6 }}>{t('标题示例 Heading')}</div>
              <div style={{ fontFamily: body, fontSize: 14, opacity: 0.85, marginBottom: 12 }}>{t('正文示例:这段文字演示正文字体与文字颜色的搭配效果。')}</div>
              <div style={{ display: 'flex', gap: 8 }}>
                <span style={{ background: primary, color: bg, fontSize: 12, fontWeight: 700, padding: '5px 12px', borderRadius: 6 }}>{t('主色按钮')}</span>
                <span style={{ background: accent, color: bg, fontSize: 12, fontWeight: 700, padding: '5px 12px', borderRadius: 6 }}>{t('强调')}</span>
              </div>
            </div>
          </section>
        </div>

        {/* footer（窄 popover：按钮换行、内边距收紧） */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: '10px 12px', borderTop: `0.5px solid ${theme.border}` }}>
          {savingName !== null && (
            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <input autoFocus value={savingName} placeholder={t('风格名称')}
                onChange={(e) => setSavingName(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') handleSaveOwned(); if (e.key === 'Escape') setSavingName(null); }}
                style={{ ...textInput, flex: 1 }} />
              <button onClick={handleSaveOwned} style={primaryBtn}>{t('确定')}</button>
              <button onClick={() => setSavingName(null)} style={ghostBtn}>{t('取消')}</button>
            </div>
          )}
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
            <button onClick={() => { onApply(null); onClose(); }} style={{ ...ghostBtn, color: theme.textDim }}>{t('清除风格')}</button>
            <button onClick={() => setSavingName('')} style={ghostBtn}>{t('保存为我的风格')}</button>
            <div style={{ flex: 1, minWidth: 8 }} />
            <button onClick={onClose} style={ghostBtn}>{t('取消')}</button>
            <button onClick={() => { onApply(draft); onClose(); }} style={primaryBtn}>{t('应用到工程')}</button>
          </div>
        </div>
      </div>
    </div>
  );
}

/** replace IN PLACE / append the entry for `role`; drop it when the value is blank.
 * 必须原地替换而非删后追加:行序由 draft 顺序推导,挪位会让正在编辑的行跳走
 * (下拉选字体/输一个色值字符,该行立刻换位置)。 */
function upsert<T extends { role: string }>(list: T[], role: string, value: string, make: (v: string) => T): T[] {
  const at = list.findIndex((x) => x.role === role);
  if (!value.trim()) return at === -1 ? list : list.filter((x) => x.role !== role);
  if (at === -1) return [...list, make(value)];
  return list.map((x, i) => (i === at ? make(value) : x));
}

const isEmpty = (s: DesignStyle): boolean => s.colors.length === 0 && s.fonts.length === 0 && !s.styleGuide;
const sameStyle = (a: DesignStyle, b: DesignStyle): boolean => JSON.stringify(a) === JSON.stringify(b);

/** 一行风格选项（64×36 缩略图 + 12px 名 + 选中橙点，行 hover 白@3.5%）。
 *  无 colors → 画一条对角线占位（「无」卡）。 */
function StyleRow({ colors, name, title, selected, onClick, onDelete }: {
  colors?: string[]; name: string; title?: string; selected: boolean; onClick: () => void; onDelete?: () => void;
}) {
  const t = useT();
  return (
    <div style={{ position: 'relative' }}>
      <button onClick={onClick} title={title} style={{ ...styleRowBtn, background: selected ? themeAlpha.ink(0.06) : 'transparent', paddingRight: onDelete ? 28 : 12 }}
        onMouseEnter={(e) => { if (!selected) e.currentTarget.style.background = themeAlpha.ink(0.035); }}
        onMouseLeave={(e) => { if (!selected) e.currentTarget.style.background = selected ? themeAlpha.ink(0.06) : 'transparent'; }}>
        <div style={colors && colors.length ? thumb : noneThumb}>
          {colors?.map((c, i) => <span key={i} style={{ flex: 1, background: c }} />)}
        </div>
        <span style={rowName}>{name}</span>
        <div style={{ flex: 1 }} />
        {selected && <span style={dot} />}
      </button>
      {onDelete && (
        <button onClick={onDelete} title={t('删除此风格')}
          style={{ ...iconBtn, position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)', padding: 2 }}>
          <Icon name="x" size={11} />
        </button>
      )}
    </div>
  );
}

// 行样式：行高 ~44、缩略图 64×36 radius 4、名 12px、gap 10、pl 8、radius 4。
const styleList: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 2 };
const styleRowBtn: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 10, width: '100%',
  border: 'none', color: theme.text, borderRadius: 4, padding: '5px 12px 5px 8px',
  cursor: 'pointer', textAlign: 'left', transition: 'background 0.12s',
};
const thumb: React.CSSProperties = {
  display: 'flex', width: 64, height: 36, borderRadius: 4, overflow: 'hidden',
  flexShrink: 0, border: `0.5px solid ${theme.border}`,
};
const noneThumb: React.CSSProperties = {
  ...thumb,
  background: `linear-gradient(to top right, transparent calc(50% - 1px), ${theme.border} calc(50% - 1px), ${theme.border} calc(50% + 1px), transparent calc(50% + 1px))`,
};
const rowName: React.CSSProperties = { fontSize: 12, color: theme.text, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' };
const dot: React.CSSProperties = { width: 8, height: 8, borderRadius: '50%', background: theme.accent, flexShrink: 0 };

// ── 字体字段:可输可选(清单与 search_fonts/导出闸同源) ─────────

/** 输入任意 family,或从可加载清单下拉选。输入即过滤(family+中文别名);选项用
 * 各自字体渲染预览——google 子集按需拉、中文 woff2 走本地同源,开销可忽略。 */
function FontField({ label, role, value, onChange }: {
  label: string; role: string; value: string; onChange: (v: string) => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, [open]);

  const q = value.trim();
  const options = useMemo(() => {
    const loadable = FONT_CATALOG.filter((f) => f.loadable);
    // 空值或已选中清单项(重开想换别的)→ 全量;否则按输入过滤,无命中也回全量避免死胡同
    if (!q || loadable.some((f) => f.family.toLowerCase() === q.toLowerCase())) return loadable;
    const hits = searchFontCatalog(q, FONT_CATALOG.length).filter((h) => h.loadable);
    return hits.length ? hits : loadable;
  }, [q]);
  const zh = options.filter((o) => o.source === 'bundled');
  const west = options.filter((o) => o.source !== 'bundled');

  const pick = (family: string): void => { onChange(family); setOpen(false); };
  const group = (title: string, list: typeof options) => list.length === 0 ? null : (
    <div key={title}>
      <div style={{ ...sectionTitle, padding: '6px 8px 2px', marginBottom: 0 }}>{title}</div>
      {list.map((o) => (
        <button key={o.family} type="button" onMouseDown={(e) => { e.preventDefault(); pick(o.family); }} style={fontOption}>
          <span style={{ fontFamily: `'${o.family}'`, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{o.family}</span>
          {o.aliases[0] && <span style={{ fontSize: 10.5, color: theme.textDim, flexShrink: 0 }}>{o.aliases[0]}</span>}
        </button>
      ))}
    </div>
  );

  return (
    <div ref={boxRef} style={{ position: 'relative', display: 'flex', flexDirection: 'column', gap: 4 }}>
      <span title={role} style={{ fontSize: 11.5, color: theme.textDim, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t(label)}</span>
      <div style={{ position: 'relative' }}>
        <input value={value} placeholder={t('如 Inter / 得意黑')} onFocus={() => setOpen(true)}
          onClick={() => setOpen(true)}
          onChange={(e) => { onChange(e.target.value); setOpen(true); }}
          onKeyDown={(e) => { if (e.key === 'Escape') setOpen(false); }}
          style={{ ...textInput, paddingRight: 26 }} />
        <button type="button" aria-label={t('从清单选择字体')} onMouseDown={(e) => { e.preventDefault(); setOpen((v) => !v); }}
          style={caretBtn}>▾</button>
      </div>
      {open && (
        <div style={fontMenu}>
          {group(t('中文'), zh)}
          {group(t('西文'), west)}
        </div>
      )}
    </div>
  );
}

const caretBtn: React.CSSProperties = {
  position: 'absolute', right: 4, top: '50%', transform: 'translateY(-50%)',
  background: 'none', border: 'none', color: theme.textDim, cursor: 'pointer',
  fontSize: 11, padding: '2px 5px', lineHeight: 1,
};
const fontMenu: React.CSSProperties = {
  position: 'absolute', top: '100%', left: 0, right: 0, marginTop: 4, zIndex: 5,
  maxHeight: 224, overflowY: 'auto', background: theme.panelAlt, border: `0.5px solid ${theme.border}`,
    borderRadius: 4, boxShadow: `0 12px 32px ${themeAlpha.shadow(0.4)}`, padding: '2px 0 6px',
};
const fontOption: React.CSSProperties = {
  display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, width: '100%',
  background: 'none', border: 'none', color: theme.text, cursor: 'pointer',
  padding: '6px 10px', fontSize: 13, textAlign: 'left',
};

// 结构：不是居中大 modal，而是 AI 面板左侧的锚定 popover。
// backdrop 透明、仅作点击外部关闭；popover 左锚定、352 宽。
const backdrop: React.CSSProperties = {
  position: 'fixed', inset: 0, background: 'transparent', zIndex: 60,
};
const card: React.CSSProperties = {
  position: 'fixed', left: 6, top: 92, width: 352, maxWidth: 'calc(100vw - 12px)',
  maxHeight: 'calc(100vh - 120px)', display: 'flex', flexDirection: 'column',
  background: theme.panelAlt, color: theme.text, border: `0.5px solid ${theme.border}`, borderRadius: 4,
  boxShadow: `0 18px 48px ${themeAlpha.shadow(0.34)}, 0 1px 0 ${themeAlpha.ink(0.04)} inset`,
};
// 区块标题：11px / font-weight 500 / oklch(0.6) 暗灰 / pl 8。
const sectionTitle: React.CSSProperties = { fontSize: 11, fontWeight: 500, color: theme.textDim, paddingLeft: 8, marginBottom: 6, letterSpacing: 0.2 };
const colorRow: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 6, background: theme.panelAlt,
  border: `0.5px solid ${theme.border}`, borderRadius: 4, padding: '4px 7px',
};
const hexInput: React.CSSProperties = {
  minWidth: 0, flex: 1, background: 'none', border: 'none', color: theme.text,
  fontSize: 12, fontFamily: 'ui-monospace, monospace', outline: 'none',
};
const textInput: React.CSSProperties = {
  width: '100%', background: theme.bg, color: theme.text, border: `0.5px solid ${theme.borderLight}`,
  borderRadius: 6, padding: '7px 9px', fontSize: 13, outline: 'none', boxSizing: 'border-box',
};
const iconBtn: React.CSSProperties = { background: 'none', border: 'none', color: theme.textDim, cursor: 'pointer', padding: 3, lineHeight: 0 };
const ghostBtn: React.CSSProperties = {
  background: 'none', border: `0.5px solid ${theme.border}`, color: theme.text,
  borderRadius: 4, padding: '6px 14px', fontSize: 13, cursor: 'pointer',
};
const primaryBtn: React.CSSProperties = {
  background: theme.accent, border: 'none', color: theme.onAccent, borderRadius: 4,
  padding: '6px 16px', fontSize: 13, fontWeight: 600, cursor: 'pointer',
};
