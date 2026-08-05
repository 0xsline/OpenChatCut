import { useState } from 'react';
import type { TimelineItem } from '../../editor/types';
import { useT } from '../../i18n/locale';
import {
  bumpPreviewFontSize,
  previewTextEditFields,
} from './previewTextEdit';
import type { PreviewCandidateGeometry } from './previewTransform';

const COLOR_SWATCHES = ['#ffffff', '#0a0a0a', '#FFD84A', '#FF5A5A', '#6EE7F9', '#7CFF9B', '#FF8FD1', '#FFA94D'];

export interface PreviewTextEditBarProps {
  item: TimelineItem;
  selection: PreviewCandidateGeometry;
  composition: { width: number; height: number };
  onPropChange: (id: string, key: string, value: unknown) => void;
}

/**
 * Floating color / font-size bar for a selected text or text-like MG clip.
 * Sits above the transform outline; reuses caption edit chrome (cc-capedit-*).
 */
export function PreviewTextEditBar({ item, selection, composition, onPropChange }: PreviewTextEditBarProps) {
  const t = useT();
  const [pop, setPop] = useState<'color' | null>(null);
  const fields = previewTextEditFields(item);
  const topY = Math.min(...selection.corners.map((point) => point.y));
  const left = `${(selection.center.x / composition.width) * 100}%`;
  const top = `${(topY / composition.height) * 100}%`;

  if (!fields) return null;

  return (
    <div
      className="cc-capedit-bar cc-preview-text-edit-bar"
      style={{ left, top, transform: 'translate(-50%, calc(-100% - 14px))' }}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <span className="cc-preview-text-edit-tag">{item.kind === 'text' ? t('文字') : t('模板')}</span>
      <span className="cc-capedit-divider" aria-hidden />
      <button
        type="button"
        className={`cc-capedit-btn${pop === 'color' ? ' on' : ''}`}
        title={t('文字颜色')}
        onClick={() => setPop(pop === 'color' ? null : 'color')}
      >
        <span className="cc-capedit-colordot" style={{ background: fields.color }} />
      </button>
      <span className="cc-capedit-divider" aria-hidden />
      <button
        type="button"
        className="cc-capedit-btn"
        title={t('缩小字号')}
        onClick={() => onPropChange(item.id, fields.fontSizeKey, bumpPreviewFontSize(fields, -1))}
      >
        A−
      </button>
      <button
        type="button"
        className="cc-capedit-btn"
        title={t('放大字号')}
        onClick={() => onPropChange(item.id, fields.fontSizeKey, bumpPreviewFontSize(fields, 1))}
      >
        A+
      </button>
      {pop === 'color' && (
        <div className="cc-capedit-pop color">
          {COLOR_SWATCHES.map((hex) => (
            <button
              key={hex}
              type="button"
              className={`cc-capedit-swatch${fields.color.toLowerCase() === hex.toLowerCase() ? ' on' : ''}`}
              style={{ background: hex }}
              title={hex}
              onClick={() => {
                onPropChange(item.id, fields.colorKey, hex);
                setPop(null);
              }}
            />
          ))}
          <label className="cc-capedit-custom" title={t('自定义颜色')}>
            <input
              type="color"
              defaultValue={/^#[0-9a-fA-F]{6}$/.test(fields.color) ? fields.color : '#ffffff'}
              onBlur={(event) => {
                onPropChange(item.id, fields.colorKey, event.target.value);
                setPop(null);
              }}
            />
            <span>{t('自定义')}</span>
          </label>
        </div>
      )}
    </div>
  );
}
