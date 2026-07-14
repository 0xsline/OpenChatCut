import { theme } from '../theme';

// Generic resource-library category list (转场/特效/缩放/LUT): clickable cards
// that apply the resource to the currently-selected clip. Mirrors the source
// library tabs where you pick a preset and it attaches to the selected item.

export interface ResourceItem {
  id: string;
  name: string;
  desc?: string;
  badge?: string;
}

interface ResourceBrowserProps {
  /** what this category applies to, e.g. "点击应用到选中片段" */
  hint: string;
  items: ResourceItem[];
  onApply: (id: string) => void;
  /** is the current selection a valid target? */
  applicable: boolean;
  /** when set, cards are non-clickable and this explains why (e.g. LUT blocked) */
  disabledNote?: string;
  /** optional preview thumbnail (data URL) per item id */
  thumb?: (id: string) => string;
}

export function ResourceBrowser({ hint, items, onApply, applicable, disabledNote, thumb }: ResourceBrowserProps) {
  const clickable = applicable && !disabledNote;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ fontSize: 11, color: disabledNote ? theme.accent : theme.textDim, marginBottom: 2, lineHeight: 1.4 }}>
        {disabledNote ? disabledNote : applicable ? hint : `${hint}（先在时间线选中目标片段）`}
      </div>
      {items.map((it) => (
        <button key={it.id} disabled={!clickable} onClick={() => onApply(it.id)}
          title={clickable ? `应用到选中片段：${it.name}` : undefined}
          style={{
            cursor: clickable ? 'pointer' : 'default', textAlign: 'left', display: 'flex', flexDirection: 'column', gap: 3,
            padding: '9px 11px', border: `1px solid ${theme.border}`, borderRadius: 8, background: theme.panelAlt,
            color: clickable ? theme.text : theme.textDim, opacity: clickable ? 1 : 0.55,
          }}
          onMouseEnter={(e) => { if (clickable) e.currentTarget.style.borderColor = theme.accent; }}
          onMouseLeave={(e) => { e.currentTarget.style.borderColor = theme.border; }}>
          {thumb && (() => { const src = thumb(it.id); return src
            ? <img src={src} alt="" style={{ width: '100%', height: 66, objectFit: 'cover', borderRadius: 5, marginBottom: 5, background: '#141414' }} />
            : null; })()}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 12.5, fontWeight: 500 }}>{it.name}</span>
            {it.badge && <span style={{ fontSize: 9, color: theme.accent, border: `1px solid ${theme.accent}`, borderRadius: 3, padding: '0 3px' }}>{it.badge}</span>}
          </div>
          {it.desc && <span style={{ fontSize: 10.5, color: theme.textDim, lineHeight: 1.35 }}>{it.desc}</span>}
        </button>
      ))}
    </div>
  );
}
