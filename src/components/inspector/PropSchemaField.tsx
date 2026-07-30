import type { CSSProperties, ReactNode } from 'react';
import { theme } from '../../theme';
import type { PropSpec } from '../../types';
import { FONT_CATALOG } from '../../fonts/googleFonts';
import { useT } from '../../i18n/locale';
import { importMedia } from '../../media/upload';

interface PropSchemaFieldProps {
  spec: PropSpec;
  value: unknown;
  onChange: (value: unknown) => void;
}

const FIELD_STYLE: CSSProperties = {
  width: '100%',
  padding: '4px 6px',
  border: `0.5px solid ${theme.borderLight}`,
  borderRadius: 5,
  background: theme.bg,
  color: theme.text,
  fontSize: 12,
};

export function PropSchemaField(props: PropSchemaFieldProps) {
  const label = props.spec.label ?? props.spec.key;
  return (
    <label className="cc-insp-mg-field">
      <span title={props.spec.key}>{label}</span>
      <PropControl {...props} />
    </label>
  );
}

function PropControl({ spec, value, onChange }: PropSchemaFieldProps): ReactNode {
  if (spec.type === 'boolean') return <input type="checkbox" checked={!!value} onChange={(event) => onChange(event.target.checked)} style={{ accentColor: theme.accent }} />;
  if (spec.type === 'color') return <input type="color" value={String(value ?? '#000000')} onChange={(event) => onChange(event.target.value)} />;
  if (spec.type === 'number') return <NumberField spec={spec} value={value} onChange={onChange} />;
  if (spec.type === 'font') return <FontField spec={spec} value={value} onChange={onChange} />;
  if (spec.type === 'select') return <SelectField spec={spec} value={value} onChange={onChange} />;
  if (spec.type === 'image' || spec.type === 'asset' || spec.type === 'video') return <MediaField spec={spec} value={value} onChange={onChange} />;
  if (spec.type === 'text') return <textarea rows={2} value={String(value ?? '')} onChange={(event) => onChange(event.target.value)} style={{ ...FIELD_STYLE, resize: 'vertical', fontFamily: 'inherit' }} />;
  return <input type="text" value={String(value ?? '')} onChange={(event) => onChange(event.target.value)} style={FIELD_STYLE} />;
}

function NumberField({ spec, value, onChange }: PropSchemaFieldProps) {
  const bounded = typeof spec.min === 'number' && typeof spec.max === 'number';
  const input = <input
    type="number"
    min={spec.min}
    max={spec.max}
    step={spec.step ?? 1}
    value={value == null ? '' : Number(value)}
    onChange={(event) => onChange(event.target.value === '' ? 0 : Number(event.target.value))}
    style={bounded ? { ...FIELD_STYLE, width: 72, flex: 'none' } : FIELD_STYLE}
  />;
  if (!bounded) return input;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <input
        type="range"
        min={spec.min}
        max={spec.max}
        step={spec.step ?? 1}
        value={Number(value ?? spec.defaultValue ?? spec.min)}
        onChange={(event) => onChange(Number(event.target.value))}
        style={{ flex: 1, minWidth: 0 }}
      />
      {input}
    </div>
  );
}

function FontField({ spec, value, onChange }: PropSchemaFieldProps) {
  const t = useT();
  const selected = String(value ?? spec.defaultValue ?? 'Inter');
  return (
    <select value={selected} onChange={(event) => onChange(event.target.value)} style={{ ...FIELD_STYLE, fontFamily: selected }}>
      {FONT_CATALOG.map((font) => <option key={font.family} value={font.family} style={{ fontFamily: font.family }}>
        {font.family}{font.aliases[0] ? ` · ${font.aliases[0]}` : ''}{font.loadable ? '' : ` ${t('(预览)')}`}
      </option>)}
      {typeof value === 'string' && value && !FONT_CATALOG.some((font) => font.family === value) ? <option value={value}>{value}</option> : null}
    </select>
  );
}

function SelectField({ spec, value, onChange }: PropSchemaFieldProps) {
  const options = (spec.options ?? []).map((option) => typeof option === 'string' ? { label: option, value: option } : option);
  return (
    <select value={String(value ?? '')} onChange={(event) => onChange(event.target.value)} style={FIELD_STYLE}>
      {options.length === 0 && <option value={String(value ?? '')}>{String(value ?? '—')}</option>}
      {options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
    </select>
  );
}

async function importFieldMedia(file: File | undefined, onChange: (value: unknown) => void): Promise<void> {
  if (!file) return;
  try {
    const asset = await importMedia(file, 30);
    onChange(asset.src);
  } catch {
    return;
  }
}

function MediaField({ spec, value, onChange }: PropSchemaFieldProps) {
  const t = useT();
  const source = String(value ?? '');
  const isVideo = spec.type === 'video' || /\.(mp4|webm|mov)(\?|$)/i.test(source);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <input type="text" placeholder={spec.type === 'video' ? t('视频 URL 或 /media/uploads/…') : t('图片 URL 或 /media/uploads/…')} value={source} onChange={(event) => onChange(event.target.value)} style={FIELD_STYLE} />
      <input type="file" accept={spec.type === 'video' ? 'video/*' : 'image/*,.svg,.gif'} onChange={(event) => {
        void importFieldMedia(event.target.files?.[0], onChange);
        event.target.value = '';
      }} style={{ fontSize: 11, color: theme.textDim }} />
      {source && (isVideo
        ? <video src={source} muted playsInline preload="metadata" style={{ maxWidth: '100%', maxHeight: 72, objectFit: 'contain', borderRadius: 4, background: theme.bg }} onLoadedMetadata={(event) => {
            const video = event.currentTarget;
            if (Number.isFinite(video.duration) && video.duration > 0) video.currentTime = Math.min(1, video.duration / 2);
          }} />
        : <img src={source} alt="" style={{ maxWidth: '100%', maxHeight: 72, objectFit: 'contain', borderRadius: 4, background: theme.bg }} />)}
    </div>
  );
}
