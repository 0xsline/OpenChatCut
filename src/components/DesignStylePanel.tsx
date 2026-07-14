import { useState } from 'react';
import { theme } from '../theme';
import { Icon } from './icons';
import {
  COLOR_ROLES, FONT_ROLES, colorOf, fontOf, type DesignStyle,
} from '../editor/types';
import { DESIGN_STYLE_PRESETS } from '../editor/design-presets';

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
        {/* header */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '13px 16px', borderBottom: `1px solid ${theme.border}` }}>
          <span style={{ color: primary, lineHeight: 0 }}><Icon name="palette" size={17} /></span>
          <span style={{ flex: 1, fontSize: 14, fontWeight: 600 }}>设计风格</span>
          <span style={{ fontSize: 11.5, color: theme.textDim }}>工程品牌 · 驱动 MG/字幕配色字体</span>
          <button onClick={onClose} title="关闭" style={iconBtn}><Icon name="x" size={15} /></button>
        </div>

        <div style={{ padding: 16, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 18 }}>
          {/* presets */}
          <section>
            <div style={sectionTitle}>预设风格</div>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              {DESIGN_STYLE_PRESETS.map((p) => (
                <button key={p.id} onClick={() => setDraft(p.style)} title={p.style.styleGuide} style={presetChip}>
                  <div style={{ display: 'flex', borderRadius: 4, overflow: 'hidden', height: 18, width: 66 }}>
                    {p.style.colors.map((c) => <span key={c.role} style={{ flex: 1, background: c.value }} />)}
                  </div>
                  <span style={{ fontSize: 12 }}>{p.name}</span>
                </button>
              ))}
            </div>
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

        {/* footer */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 16px', borderTop: `1px solid ${theme.border}` }}>
          <button onClick={() => { onApply(null); onClose(); }} style={{ ...ghostBtn, color: theme.textDim }}>清除风格</button>
          <div style={{ flex: 1 }} />
          <button onClick={onClose} style={ghostBtn}>取消</button>
          <button onClick={() => { onApply(draft); onClose(); }} style={primaryBtn}>应用到工程</button>
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

const backdrop: React.CSSProperties = {
  position: 'fixed', inset: 0, background: 'rgba(0,0,0,.55)', zIndex: 60,
  display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
};
const card: React.CSSProperties = {
  width: 560, maxWidth: '100%', maxHeight: '90vh', display: 'flex', flexDirection: 'column',
  background: theme.panel, color: theme.text, border: `1px solid ${theme.border}`, borderRadius: 12,
  boxShadow: '0 20px 60px rgba(0,0,0,.5)',
};
const sectionTitle: React.CSSProperties = { fontSize: 12, fontWeight: 600, color: theme.textDim, marginBottom: 8 };
const presetChip: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 8, background: theme.panelAlt, color: theme.text,
  border: `1px solid ${theme.border}`, borderRadius: 8, padding: '7px 10px', cursor: 'pointer',
};
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
