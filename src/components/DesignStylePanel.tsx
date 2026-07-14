import { useEffect, useState } from 'react';
import { theme } from '../theme';
import { Icon } from './icons';
import {
  COLOR_ROLES, FONT_ROLES, colorOf, fontOf, type DesignStyle,
} from '../editor/types';
import { DESIGN_STYLE_PRESETS } from '../editor/design-presets';
import { loadOwnedStyles, saveOwnedStyle, deleteOwnedStyle, type OwnedStyle } from '../persist/projectStore';

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

/** 设计风格编辑器（source manage_design_style / aM 弹窗）——预设库 + 配色/字体/品牌指引，
 * 本地草稿即时预览,「应用到工程」一次性提交(单条历史)。 */
export function DesignStylePanel({ style, onApply, onClose }: DesignStylePanelProps) {
  const [draft, setDraft] = useState<DesignStyle>(style ?? EMPTY);

  // "我的风格" — the user's own saved-style library (source /api/design-styles/owned,
  // a GLOBAL personal library, not scoped to this project).
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

  // roles are free-form (source uses "accent copper", "Chinese heading", …) — show
  // every role the style actually has, then the canonical ones it's missing.
  const colorRoles = union(draft.colors.map((c) => c.role), COLOR_ROLES);
  const fontRoles = union(draft.fonts.map((f) => f.role), FONT_ROLES);

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
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px', borderBottom: `1px solid ${theme.border}` }}>
          <span style={{ color: primary, lineHeight: 0 }}><Icon name="palette" size={16} /></span>
          <span style={{ flex: 1, fontSize: 13, fontWeight: 600 }}>设计风格</span>
          <button onClick={onClose} title="关闭" style={iconBtn}><Icon name="x" size={15} /></button>
        </div>

        <div style={{ padding: '12px 12px 14px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 16 }}>
          {/* 风格选择器（像素对标源站 21_design_style：紧凑「缩略图 64×36 + 名 12px」行、
              11px/500 暗色区块标题、选中橙点、顶部「无」卡） */}
          <section>
            <div style={sectionTitle}>选择 MG 动画的视觉风格</div>
            <div style={styleList}>
              <StyleRow name="无" selected={isEmpty(draft)} onClick={() => setDraft(EMPTY)} />
            </div>

            <div style={{ ...sectionTitle, marginTop: 12 }}>预设</div>
            <div style={styleList}>
              {DESIGN_STYLE_PRESETS.map((p) => (
                <StyleRow key={p.id} name={p.name} title={p.style.styleGuide}
                  colors={p.style.colors.map((c) => c.value)}
                  selected={sameStyle(draft, p.style)} onClick={() => setDraft(p.style)} />
              ))}
            </div>

            {owned.length > 0 && (
              <>
                <div style={{ ...sectionTitle, marginTop: 12 }}>我的风格</div>
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
            <div style={sectionTitle}>配色</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 8 }}>
              {colorRoles.map((role) => {
                const value = colorOf(draft, role) ?? '';
                return (
                  <label key={role} style={colorRow}>
                    <input type="color" value={/^#[0-9a-fA-F]{6}$/.test(value) ? value : '#000000'} onChange={(e) => setColor(role, e.target.value)}
                      style={{ width: 24, height: 24, padding: 0, border: 'none', background: value || 'none', borderRadius: 4, cursor: 'pointer', flexShrink: 0 }} />
                    <span title={role} style={{ fontSize: 11, color: theme.textDim, minWidth: 40, flexShrink: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{COLOR_LABEL[role] ?? role}</span>
                    <input value={value} placeholder="#—" onChange={(e) => setColor(role, e.target.value)} style={hexInput} />
                  </label>
                );
              })}
            </div>
          </section>

          {/* fonts (free-form roles) */}
          <section>
            <div style={sectionTitle}>字体</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: 10 }}>
              {fontRoles.map((role) => (
                <label key={role} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <span title={role} style={{ fontSize: 11.5, color: theme.textDim, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{FONT_LABEL[role] ?? role}</span>
                  <input value={fontOf(draft, role) ?? ''} placeholder="如 Inter / Playfair Display"
                    onChange={(e) => setFont(role, e.target.value)} style={textInput} />
                </label>
              ))}
            </div>
          </section>

          {/* style guide */}
          <section>
            <div style={sectionTitle}>品牌指引（可选）</div>
            <textarea value={draft.styleGuide ?? ''} placeholder="用一句话描述这个品牌的视觉倾向,AI 生成时会遵守。"
              onChange={(e) => setDraft((d) => ({ ...d, styleGuide: e.target.value }))}
              style={{ ...textInput, minHeight: 54, resize: 'vertical', fontFamily: 'inherit' }} />
          </section>

          {/* live preview */}
          <section>
            <div style={sectionTitle}>预览</div>
            <div style={{ background: bg, color: fg, borderRadius: 8, padding: '20px 22px', border: `1px solid ${theme.border}` }}>
              <div style={{ fontFamily: heading, fontSize: 26, fontWeight: 800, marginBottom: 6 }}>标题示例 Heading</div>
              <div style={{ fontFamily: body, fontSize: 14, opacity: 0.85, marginBottom: 12 }}>正文示例:这段文字演示正文字体与文字颜色的搭配效果。</div>
              <div style={{ display: 'flex', gap: 8 }}>
                <span style={{ background: primary, color: bg, fontSize: 12, fontWeight: 700, padding: '5px 12px', borderRadius: 6 }}>主色按钮</span>
                <span style={{ background: accent, color: bg, fontSize: 12, fontWeight: 700, padding: '5px 12px', borderRadius: 6 }}>强调</span>
              </div>
            </div>
          </section>
        </div>

        {/* footer（窄 popover：按钮换行、内边距收紧） */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: '10px 12px', borderTop: `1px solid ${theme.border}` }}>
          {savingName !== null && (
            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <input autoFocus value={savingName} placeholder="风格名称"
                onChange={(e) => setSavingName(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') handleSaveOwned(); if (e.key === 'Escape') setSavingName(null); }}
                style={{ ...textInput, flex: 1 }} />
              <button onClick={handleSaveOwned} style={primaryBtn}>确定</button>
              <button onClick={() => setSavingName(null)} style={ghostBtn}>取消</button>
            </div>
          )}
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
            <button onClick={() => { onApply(null); onClose(); }} style={{ ...ghostBtn, color: theme.textDim }}>清除风格</button>
            <button onClick={() => setSavingName('')} style={ghostBtn}>保存为我的风格</button>
            <div style={{ flex: 1, minWidth: 8 }} />
            <button onClick={onClose} style={ghostBtn}>取消</button>
            <button onClick={() => { onApply(draft); onClose(); }} style={primaryBtn}>应用到工程</button>
          </div>
        </div>
      </div>
    </div>
  );
}

/** replace or append the entry for `role`; drop it when the value is blank. */
function upsert<T extends { role: string }>(list: T[], role: string, value: string, make: (v: string) => T): T[] {
  const rest = list.filter((x) => x.role !== role);
  return value.trim() ? [...rest, make(value)] : rest;
}

const isEmpty = (s: DesignStyle): boolean => s.colors.length === 0 && s.fonts.length === 0 && !s.styleGuide;
const sameStyle = (a: DesignStyle, b: DesignStyle): boolean => JSON.stringify(a) === JSON.stringify(b);

/** 一行风格选项（像素对标源站：64×36 缩略图 + 12px 名 + 选中橙点，行 hover 白@3.5%）。
 *  无 colors → 画一条对角线占位（源站「无」卡）。 */
function StyleRow({ colors, name, title, selected, onClick, onDelete }: {
  colors?: string[]; name: string; title?: string; selected: boolean; onClick: () => void; onDelete?: () => void;
}) {
  return (
    <div style={{ position: 'relative' }}>
      <button onClick={onClick} title={title} style={{ ...styleRowBtn, background: selected ? 'rgba(255,255,255,0.06)' : 'transparent', paddingRight: onDelete ? 28 : 12 }}
        onMouseEnter={(e) => { if (!selected) e.currentTarget.style.background = 'rgba(255,255,255,0.035)'; }}
        onMouseLeave={(e) => { if (!selected) e.currentTarget.style.background = selected ? 'rgba(255,255,255,0.06)' : 'transparent'; }}>
        <div style={colors && colors.length ? thumb : noneThumb}>
          {colors?.map((c, i) => <span key={i} style={{ flex: 1, background: c }} />)}
        </div>
        <span style={rowName}>{name}</span>
        <div style={{ flex: 1 }} />
        {selected && <span style={dot} />}
      </button>
      {onDelete && (
        <button onClick={onDelete} title="删除此风格"
          style={{ ...iconBtn, position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)', padding: 2 }}>
          <Icon name="x" size={11} />
        </button>
      )}
    </div>
  );
}

// 行样式（源站实测：行高 ~44、缩略图 64×36 radius 4、名 12px、gap 10、pl 8、radius 4）。
const styleList: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 2 };
const styleRowBtn: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 10, width: '100%',
  border: 'none', color: theme.text, borderRadius: 4, padding: '5px 12px 5px 8px',
  cursor: 'pointer', textAlign: 'left', transition: 'background 0.12s',
};
const thumb: React.CSSProperties = {
  display: 'flex', width: 64, height: 36, borderRadius: 4, overflow: 'hidden',
  flexShrink: 0, border: `1px solid ${theme.border}`,
};
const noneThumb: React.CSSProperties = {
  ...thumb,
  background: `linear-gradient(to top right, transparent calc(50% - 1px), ${theme.border} calc(50% - 1px), ${theme.border} calc(50% + 1px), transparent calc(50% + 1px))`,
};
const rowName: React.CSSProperties = { fontSize: 12, color: theme.text, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' };
const dot: React.CSSProperties = { width: 8, height: 8, borderRadius: '50%', background: theme.accent, flexShrink: 0 };

// 结构对标源站 21_design_style：不是居中大 modal，而是 AI 面板左侧的锚定 popover。
// backdrop 透明、仅作点击外部关闭；popover 左锚定、352 宽（源实测）。
const backdrop: React.CSSProperties = {
  position: 'fixed', inset: 0, background: 'transparent', zIndex: 60,
};
const card: React.CSSProperties = {
  position: 'fixed', left: 6, top: 92, width: 352, maxWidth: 'calc(100vw - 12px)',
  maxHeight: 'calc(100vh - 120px)', display: 'flex', flexDirection: 'column',
  // 源实测：bg rgb(42,42,42)、radius 4、阴影 0 18px 48px rgba(0,0,0,.34) + 顶部内高光。
  background: 'rgb(42,42,42)', color: theme.text, border: `1px solid ${theme.border}`, borderRadius: 4,
  boxShadow: '0 18px 48px rgba(0,0,0,.34), 0 1px 0 rgba(255,255,255,.04) inset',
};
// 区块标题：源站 21_design_style 实测 11px / font-weight 500 / oklch(0.6) 暗灰 / pl 8。
const sectionTitle: React.CSSProperties = { fontSize: 11, fontWeight: 500, color: theme.textDim, paddingLeft: 8, marginBottom: 6, letterSpacing: 0.2 };
const colorRow: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 6, background: theme.panelAlt,
  border: `1px solid ${theme.border}`, borderRadius: 7, padding: '4px 7px',
};
const hexInput: React.CSSProperties = {
  minWidth: 0, flex: 1, background: 'none', border: 'none', color: theme.text,
  fontSize: 12, fontFamily: 'ui-monospace, monospace', outline: 'none',
};
const textInput: React.CSSProperties = {
  width: '100%', background: theme.bg, color: theme.text, border: `1px solid ${theme.borderLight}`,
  borderRadius: 6, padding: '7px 9px', fontSize: 13, outline: 'none', boxSizing: 'border-box',
};
const iconBtn: React.CSSProperties = { background: 'none', border: 'none', color: theme.textDim, cursor: 'pointer', padding: 3, lineHeight: 0 };
const ghostBtn: React.CSSProperties = {
  background: 'none', border: `1px solid ${theme.border}`, color: theme.text,
  borderRadius: 7, padding: '6px 14px', fontSize: 13, cursor: 'pointer',
};
const primaryBtn: React.CSSProperties = {
  background: theme.accent, border: 'none', color: '#fff', borderRadius: 7,
  padding: '6px 16px', fontSize: 13, fontWeight: 600, cursor: 'pointer',
};
