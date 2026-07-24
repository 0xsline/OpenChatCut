import { useState, type ReactNode } from 'react';
import { theme } from '../theme';
import { useT } from '../i18n/locale';
import { setLibraryDrag, type LibraryDragKind } from './drag';

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
  /** Plugin entry:Drag and drop payload Application data taken away(see drag.ts LibraryDragPayload.data) */
  data?: unknown;
  /** Plugin entry preview(data:image/* or URL);If there are cards, use them directly */
  thumb?: string;
}

interface ResourceBrowserProps {
  /** what this category applies to, e.g. "Click Apply to Selected Clips" */
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
   * custom thumb renderer (e.g. animated GLSL transition on hover).
   * `hovered` is true while the pointer is over that card.
   */
  renderThumb?: (id: string, hovered: boolean) => ReactNode;
  /** List (default) or card-grid layout. */
  layout?: 'list' | 'grid';
  /** enable HTML5 drag onto timeline clips (kind in payload) */
  dragKind?: LibraryDragKind;
}

export function ResourceBrowser({
  hint, items, onApply, applicable, disabledNote, thumb, renderThumb, layout = 'list', dragKind,
}: ResourceBrowserProps) {
  const t = useT();
  const clickable = applicable && !disabledNote;
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const canDrag = !!dragKind && !disabledNote;
  const hintText = disabledNote
    ? t(disabledNote)
    : applicable
      ? `${t(hint)}${canDrag ? t(' · You can also drag it onto a timeline clip') : ''}`
      : `${t(hint)}${t('(Select it on the timeline first, or drag it directly to the clip)')}`;

  const onCardDragStart = (e: React.DragEvent, it: ResourceItem) => {
    if (!canDrag || !dragKind) return;
    setLibraryDrag(e, { kind: dragKind, id: it.id, name: it.name, ...(it.data !== undefined ? { data: it.data } : {}) });
  };

  if (layout === 'grid') {
    return (
      <div className="cc-resource-browser">
        <div
          className="cc-resource-hint"
          style={{ color: disabledNote ? theme.accent : theme.textDim }}
        >
          {hintText}
        </div>
        <div className="cc-resource-grid">
          {items.map((it) => {
            const hovered = hoveredId === it.id;
            const src = !renderThumb ? (thumb?.(it.id) ?? '') : '';
            return (
              <button
                key={it.id}
                type="button"
                // Never use native disabled because hover previews must keep working.
                aria-disabled={!clickable}
                draggable={canDrag}
                onDragStart={(e) => onCardDragStart(e, it)}
                onClick={() => { if (clickable) onApply(it.id); }}
                title={
                  clickable
                    ? t('Click Apply / Drag to timeline:{name}', { name: it.name })
                    : canDrag
                      ? t('Drag clip to timeline:{name}', { name: it.name })
                      : t('Preview:{name}(Available after selecting the clip)', { name: it.name })
                }
                className={`cc-resource-card${clickable ? '' : ' disabled'}${hovered ? ' hovered' : ''}${canDrag ? ' draggable' : ''}`}
                onPointerEnter={() => setHoveredId(it.id)}
                onPointerLeave={() => setHoveredId((h) => (h === it.id ? null : h))}
                onFocus={() => setHoveredId(it.id)}
                onBlur={() => setHoveredId((h) => (h === it.id ? null : h))}
              >
                <div className="cc-resource-thumb">
                  {renderThumb
                    ? renderThumb(it.id, hovered)
                    : src
                      ? <img src={src} alt="" draggable={false} />
                      : <span className="cc-resource-thumb-placeholder" />}
                </div>
                <div className="cc-resource-name">{t(it.name)}</div>
              </button>
            );
          })}
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ fontSize: 11, color: disabledNote ? theme.accent : theme.textDim, marginBottom: 2, lineHeight: 1.4 }}>
        {hintText}
      </div>
      {items.map((it) => (
        <button key={it.id}
          type="button"
          aria-disabled={!clickable}
          draggable={canDrag}
          onDragStart={(e) => onCardDragStart(e, it)}
          onClick={() => { if (clickable) onApply(it.id); }}
          title={clickable ? t('Apply to selected clips:{name}', { name: it.name }) : canDrag ? t('Drag to timeline:{name}', { name: it.name }) : undefined}
          style={{
            cursor: canDrag || clickable ? 'grab' : 'default', textAlign: 'left', display: 'flex', flexDirection: 'column', gap: 3,
    padding: '9px 11px', border: `0.5px solid ${theme.border}`, borderRadius: 4, background: theme.panelAlt,
            color: clickable || canDrag ? theme.text : theme.textDim, opacity: clickable || canDrag ? 1 : 0.55,
          }}
          onMouseEnter={(e) => { if (clickable || canDrag) e.currentTarget.style.borderColor = theme.accent; }}
          onMouseLeave={(e) => { e.currentTarget.style.borderColor = theme.border; }}>
          {thumb && (() => { const src = thumb(it.id); return src
            ? <img src={src} alt="" draggable={false} style={{ width: '100%', height: 66, objectFit: 'cover', borderRadius: 5, marginBottom: 5, background: theme.inset }} />
            : null; })()}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 12.5, fontWeight: 500 }}>{t(it.name)}</span>
            {it.badge && <span style={{ fontSize: 9, color: theme.accent, border: `0.5px solid ${theme.accent}`, borderRadius: 3, padding: '0 3px' }}>{t(it.badge)}</span>}
          </div>
          {it.desc && <span style={{ fontSize: 10.5, color: theme.textDim, lineHeight: 1.35 }}>{t(it.desc)}</span>}
        </button>
      ))}
    </div>
  );
}
