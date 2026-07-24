import { useState } from 'react';
import { theme } from '../theme';
import type { PropSpec, Tpl } from '../types';
import type { ClipEffect, ClipEffectValue, ClipFilters, ClipTransform, Keyframe, KeyframeEasing, KeyframeProp, TimelineItem, TransitionItem, TransitionType, ZoomEffect, ZoomShape } from '../editor/types';
import { AUDIO_TRANSITION_ORDER, TRANSITION_LABELS, TRANSITION_ORDER, ZOOM_SHAPE_LABELS, ZOOM_SHAPE_ORDER } from '../editor/types';
import { sampleKeyframes } from '../editor/keyframes';
import { KEYFRAME_PROPS, getKeyframePropertyDefinition } from '../editor/keyframeRegistry';
import { ALL_FX as FX_EFFECTS, LUT_EFFECTS } from '../gl/fx/effects';
const FX_IDS = Object.keys(FX_EFFECTS);
import { usePersistedState } from '../hooks/usePersistedState';
import { Icon } from './icons';
import { FONT_CATALOG } from '../fonts/googleFonts';
import { useT } from '../i18n/locale';
import { showAppToast } from '../ui/appToast';
import { importMedia } from '../media/upload';

/** MG propSchema field types: text/number/color/boolean/font/select/image/asset/video. */
function PropSchemaField({
  spec, value, onChange,
}: {
  spec: PropSpec;
  value: unknown;
  onChange: (v: unknown) => void;
}) {
  const t = useT();
  const label = spec.label ?? spec.key;
  const fieldStyle: React.CSSProperties = {
    width: '100%', background: theme.bg, color: theme.text,
    border: `0.5px solid ${theme.borderLight}`, borderRadius: 5, padding: '4px 6px', fontSize: 12,
  };
  // Options come from propSchema; a select without options falls back
  // to a single current-value entry below.
  const opts = (spec.options ?? []).map((o) => (
    typeof o === 'string' ? { label: o, value: o } : o
  ));

  let control: React.ReactNode;
  switch (spec.type) {
    case 'boolean':
      control = (
        <input type="checkbox" checked={!!value} onChange={(e) => onChange(e.target.checked)} style={{ accentColor: theme.accent }} />
      );
      break;
    case 'color':
      control = (
        <input type="color" value={String(value ?? '#000000')} onChange={(e) => onChange(e.target.value)} />
      );
      break;
    case 'number': {
      // schema min+max → bounded slider next to the number box
      const bounded = typeof spec.min === 'number' && typeof spec.max === 'number';
      const numberInput = (
        <input
          type="number"
          min={spec.min}
          max={spec.max}
          step={spec.step ?? 1}
          value={value === undefined || value === null ? '' : Number(value)}
          onChange={(e) => onChange(e.target.value === '' ? 0 : Number(e.target.value))}
          style={bounded ? { ...fieldStyle, width: 72, flex: 'none' } : fieldStyle}
        />
      );
      control = bounded ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <input
            type="range"
            min={spec.min}
            max={spec.max}
            step={spec.step ?? 1}
            value={Number(value ?? spec.defaultValue ?? spec.min)}
            onChange={(e) => onChange(Number(e.target.value))}
            style={{ flex: 1, minWidth: 0 }}
          />
          {numberInput}
        </div>
      ) : numberInput;
      break;
    }
    case 'font':
      control = (
        <select
          value={String(value ?? spec.defaultValue ?? 'Inter')}
          onChange={(e) => onChange(e.target.value)}
          style={{ ...fieldStyle, fontFamily: String(value ?? 'Inter') }}
        >
          {FONT_CATALOG.map((f) => (
            <option key={f.family} value={f.family} style={{ fontFamily: f.family }}>
              {f.family}{f.aliases[0] ? ` · ${f.aliases[0]}` : ''}{f.loadable ? '' : ` ${t('(Preview)')}`}
            </option>
          ))}
          {/* keep custom values that aren't in catalog */}
          {typeof value === 'string' && value && !FONT_CATALOG.some((f) => f.family === value) ? (
            <option value={value}>{value}</option>
          ) : null}
        </select>
      );
      break;
    case 'select':
      control = (
        <select value={String(value ?? '')} onChange={(e) => onChange(e.target.value)} style={fieldStyle}>
          {opts.length === 0 && <option value={String(value ?? '')}>{String(value ?? '—')}</option>}
          {opts.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      );
      break;
    case 'image':
    case 'asset':
    case 'video': {
      const isVideo = spec.type === 'video' || /\.(mp4|webm|mov)(\?|$)/i.test(String(value ?? ''));
      control = (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <input
            type="text"
            placeholder={spec.type === 'video' ? t('video URL or /media/uploads/…') : t('picture URL or /media/uploads/…')}
            value={String(value ?? '')}
            onChange={(e) => onChange(e.target.value)}
            style={fieldStyle}
          />
          <input
            type="file"
            accept={spec.type === 'video' ? 'video/*' : 'image/*,.svg,.gif'}
            onChange={async (e) => {
              const file = e.target.files?.[0];
              if (!file) return;
              try {
                const asset = await importMedia(file, 30);
                onChange(asset.src);
              } catch {
                /* ignore */
              }
              e.target.value = '';
            }}
            style={{ fontSize: 11, color: theme.textDim }}
          />
          {typeof value === 'string' && value && (
            isVideo
              // preload=metadata does not decode the picture (black block), seek for a while to force the browser to draw the frame; incidentally avoid the black field of frame 0
              ? <video src={value} muted playsInline preload="metadata" style={{ maxWidth: '100%', maxHeight: 72, objectFit: 'contain', borderRadius: 4, background: theme.bg }}
                  onLoadedMetadata={(e) => { const v = e.currentTarget; if (Number.isFinite(v.duration) && v.duration > 0) v.currentTime = Math.min(1, v.duration / 2); }} />
              : <img src={value} alt="" style={{ maxWidth: '100%', maxHeight: 72, objectFit: 'contain', borderRadius: 4, background: theme.bg }} />
          )}
        </div>
      );
      break;
    }
    case 'text':
      control = (
        <textarea
          rows={2}
          value={String(value ?? '')}
          onChange={(e) => onChange(e.target.value)}
          style={{ ...fieldStyle, resize: 'vertical', fontFamily: 'inherit' }}
        />
      );
      break;
    default:
      control = (
        <input
          type="text"
          value={String(value ?? '')}
          onChange={(e) => onChange(e.target.value)}
          style={fieldStyle}
        />
      );
  }

  return (
    <label className="cc-insp-mg-field">
      <span title={spec.key}>{label}</span>
      {control}
    </label>
  );
}

interface FadePatch {
  fadeInFrames?: number;
  fadeOutFrames?: number;
}

interface AutoGradeControlProps {
  busy: boolean;
  targetCount: number;
  previewCount: number;
  failedCount: number;
  selectedPreview: {
    filters: Required<Pick<ClipFilters, 'brightness' | 'contrast' | 'saturate'>>;
    bitDepth: number;
    hdr: boolean;
  } | null;
  onAnalyze: () => void | Promise<void>;
  onApply: () => void;
  onCancel: () => void;
}

interface InspectorPanelProps {
  templates: Tpl[];
  selectedItem: TimelineItem | null;
  fps: number;
  onItemPropChange: (key: string, value: unknown) => void;
  onItemVolumeChange: (volume: number) => void;
  onItemFadeChange: (fade: FadePatch) => void;
  onItemTransformChange: (patch: ClipTransform) => void;
  onItemFiltersChange: (patch: ClipFilters) => void;
  autoGrade?: AutoGradeControlProps;
  onItemZoomChange: (patch: Partial<ZoomEffect> | null) => void;
  onItemEffectsChange: (effects: ClipEffect[]) => void;
  /** variable speed (0.1–8×); Preview/Export preservePitch */
  onItemSpeedChange?: (rate: number) => void;
  /** Loudness normalized to -14 LUFS(After analysis set volume） */
  onNormalizeLoudness?: () => void | Promise<void>;
  /**
   * Vocal isolation (unboxing ffmpeg）：apply hang denoisedSrc，clear Clear.
   * strength 0..100;Return by store setItemDenoise。
   */
  onIsolateVoice?: (action: 'apply' | 'clear', strength?: number) => void | Promise<void>;
  getPlayhead: () => number;
  onSetReframeKeyframe: (frame: number, focalPointX: number, focalPointY: number, magnification: number) => void;
  onRemoveReframeKeyframe: (frame: number) => void;
  /** generic transform keyframes (PRD §4.5) on the selected item — item-local frames */
  onSetItemKeyframe: (prop: KeyframeProp, frame: number, value: number, easing?: KeyframeEasing) => void;
  onRemoveItemKeyframe: (prop: KeyframeProp, frame: number) => void;
  /** seek the preview to an ABSOLUTE timeline frame (‹/› keyframe jumps) */
  onSeek: (frame: number) => void;
  transition: TransitionItem | null;
  onAddTransition: (type: TransitionType) => void;
  onSetTransition: (patch: Partial<TransitionItem>) => void;
  onRemoveTransition: () => void;
}

/** Compact one-line slider: label | track | value */
function SliderRow({
  label, val, min, max, step, fmt, onChange,
}: {
  label: string; val: number; min: number; max: number; step: number; fmt: string; onChange: (v: number) => void;
}) {
  return (
    <label className="cc-insp-row">
      <span className="cc-insp-label">{label}</span>
      <input
        className="cc-insp-range"
        type="range" min={min} max={max} step={step} value={val}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <span className="cc-insp-val">{fmt}</span>
    </label>
  );
}

/** per-property keyframe API handed down by InspectorPanel (playhead in item-local frames) */
interface KfApi {
  localFrame: number;
  set: (prop: KeyframeProp, frame: number, value: number, easing?: KeyframeEasing) => void;
  remove: (prop: KeyframeProp, frame: number) => void;
  seekLocal: (frame: number) => void;
}

const EASING_OPTIONS: { value: 'linear' | 'easeIn' | 'easeOut' | 'easeInOut'; label: string }[] = [
  { value: 'linear', label: 'Linear' }, { value: 'easeIn', label: 'Ease in' },
  { value: 'easeOut', label: 'Ease out' }, { value: 'easeInOut', label: 'Ease in and out' },
];

// end-of-row keyframe rail (PRD §4.5; UI imitates reframe keyframe mode, layout is customized):
// ◆ punches/updates at the playhead (filled when one sits there), ‹ › jump
// between keyframes, × deletes the one under the playhead, plus segment easing.
function KfCell({ kfs, localFrame, punchValue, onSet, onRemove, onSeekLocal }: {
  kfs: Keyframe[] | undefined;
  localFrame: number;
  punchValue: number;
  onSet: (frame: number, value: number, easing?: KeyframeEasing) => void;
  onRemove: (frame: number) => void;
  onSeekLocal: (frame: number) => void;
}) {
  const t = useT();
  const at = kfs?.find((k) => k.frame === localFrame);
  const prev = kfs ? [...kfs].reverse().find((k) => k.frame < localFrame) : undefined;
  const next = kfs?.find((k) => k.frame > localFrame);
  const btn: React.CSSProperties = { background: 'none', border: 'none', cursor: 'pointer', padding: 0, width: 13, height: 16, display: 'grid', placeItems: 'center', fontSize: 10, color: theme.textDim, lineHeight: 1 };
  const off: React.CSSProperties = { ...btn, opacity: 0.3, cursor: 'default' };
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 1, flexShrink: 0 }}>
      <button type="button" style={prev ? btn : off} disabled={!prev} title={t('Previous keyframe')} onClick={() => prev && onSeekLocal(prev.frame)}>‹</button>
      <button
        type="button"
        style={{ ...btn, fontSize: 11, color: at ? theme.accent : kfs?.length ? theme.textMuted : theme.textDim }}
        title={at ? t('Update keyframes at playhead') : t('Keyframe the playhead')}
        onClick={() => onSet(localFrame, punchValue, at?.easing)}
      >{at ? '◆' : '◇'}</button>
      <button type="button" style={next ? btn : off} disabled={!next} title={t('next keyframe')} onClick={() => next && onSeekLocal(next.frame)}>›</button>
      <button type="button" style={at ? btn : off} disabled={!at} title={t('Delete keyframes at playhead')} onClick={() => at && onRemove(localFrame)}>×</button>
      {at && (
        <select
          value={Array.isArray(at.easing) ? 'bezier' : at.easing ?? 'linear'}
          title={t('Easing (the curve from this keyframe to the next frame)')}
          onChange={(e) => {
            const v = e.target.value;
            if (v === 'bezier') return; // custom tuples are agent-authored; keep as-is
            onSet(localFrame, at.value, v === 'linear' ? undefined : (v as KeyframeEasing));
          }}
          style={{ background: theme.bg, color: theme.textDim, border: `0.5px solid ${theme.borderLight}`, borderRadius: 3, fontSize: 9, padding: '0 1px', maxWidth: 50 }}
        >
          {EASING_OPTIONS.map((o) => <option key={o.value} value={o.value}>{t(o.label)}</option>)}
          {Array.isArray(at.easing) && <option value="bezier">{t('bessel')}</option>}
        </select>
      )}
    </span>
  );
}

// scale / position / rotation for visual clips (zoom tab) + per-property
// keyframe rails and an opacity curve row. A keyframed prop shows the
// value sampled at the playhead; dragging it then punches a keyframe there.
function TransformControl({ item, onChange, kf }: { item: TimelineItem; onChange: (p: ClipTransform) => void; kf: KfApi }) {
  const t = useT();
  const rows = KEYFRAME_PROPS
    .map(getKeyframePropertyDefinition)
    .filter((definition) => definition.supports(item));
  return (
    <div className="cc-insp-stack">
      {rows.map((r) => {
        const kfs = item.keyframes?.[r.id];
        const value = kfs?.length ? sampleKeyframes(kfs, kf.localFrame) : r.getBaseValue(item);
        const [min, max] = r.editorRange;
        return (
          <div key={r.id} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <SliderRow label={t(r.label)} val={value} min={min} max={max} step={r.step} fmt={r.format(value)}
                onChange={(next) => {
                  const patch = r.toTransformPatch?.(next);
                  if (!kfs?.length && patch) onChange(patch);
                  else kf.set(r.id, kf.localFrame, next);
                }} />
            </div>
            <KfCell kfs={kfs} localFrame={kf.localFrame} punchValue={value}
              onSet={(frame, next, easing) => kf.set(r.id, frame, next, easing)}
              onRemove={(frame) => kf.remove(r.id, frame)} onSeekLocal={kf.seekLocal} />
          </div>
        );
      })}
    </div>
  );
}

// audio + video clips carry a playback volume; image/MG do not.
function VolumeControl({
  item, onChange, onNormalize,
}: {
  item: TimelineItem;
  onChange: (v: number) => void;
  onNormalize?: () => void | Promise<void>;
}) {
  const t = useT();
  const vol = item.volume ?? 1;
  const [busy, setBusy] = useState(false);
  return (
    <div>
      <SliderRow label={t('Volume')} val={vol} min={0} max={2} step={0.05} fmt={`${Math.round(vol * 100)}%`} onChange={onChange} />
      {item.kind === 'audio' && onNormalize && (
        <button
          type="button"
          className="cc-insp-btn"
          disabled={busy || !item.src}
          title={t('Analyze and normalize to -14 LUFS')}
          style={{ marginTop: 6, width: '100%', fontSize: 11 }}
          onClick={() => {
            setBusy(true);
            void Promise.resolve(onNormalize()).finally(() => setBusy(false));
          }}
        >
          {busy ? t('Analyzing…') : t('Loudness normalization (-14 LUFS)')}
        </button>
      )}
    </div>
  );
}

const SPEED_PRESETS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 4] as const;

function IsolateVoiceControl({
  item,
  onIsolate,
}: {
  item: TimelineItem;
  onIsolate: (action: 'apply' | 'clear', strength?: number) => void | Promise<void>;
}) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [strength, setStrength] = useState(item.denoiseStrength ?? 70);
  const active = Boolean(item.denoisedSrc);
  const canApply = Boolean(item.src?.startsWith('/media/uploads/'));

  const run = (action: 'apply' | 'clear', nextStrength?: number) => {
    setBusy(true);
    setErr(null);
    if (action === 'apply') showAppToast(t('Vocal isolation is being processed...'), { ms: 60_000 });
    void Promise.resolve(onIsolate(action, nextStrength))
      .then(() => {
        if (action === 'clear') showAppToast(t('Vocal isolation cleared'));
        else showAppToast(t('Vocal isolation applied'));
      })
      .catch((e: unknown) => {
        const msg = e instanceof Error ? e.message : String(e);
        setErr(msg);
        showAppToast(msg, { error: true });
      })
      .finally(() => setBusy(false));
  };

  return (
    <div>
      <SliderRow
        label={t('isolation strength')}
        val={strength}
        min={0}
        max={100}
        step={5}
        fmt={`${Math.round(strength)}`}
        onChange={setStrength}
      />
      <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
        <button
          type="button"
          className="cc-insp-btn"
          disabled={busy || !canApply}
          title={!canApply ? t('Need to be uploaded to the media pool first (/media/uploads）') : t('Use this machine ffmpeg Spectral noise reduction, retain original track')}
          style={{ flex: 1, fontSize: 11 }}
          onClick={() => run('apply', strength)}
        >
          {busy ? t('Processing…') : active ? t('re-isolate') : t('Apply vocal isolation')}
        </button>
        {active && (
          <button
            type="button"
            className="cc-insp-btn"
            disabled={busy}
            style={{ fontSize: 11 }}
            onClick={() => run('clear')}
          >
            {t('Clear')}
          </button>
        )}
      </div>
      <div className="cc-insp-muted" style={{ fontSize: 10, marginTop: 4 }}>
        {active
          ? t('Applied · Playback with isolated audio tracks · master unchanged')
          : t('Unboxing ffmpeg Noise reduction (not DeepFilterNet3）')}
      </div>
      {err && (
        <div style={{ fontSize: 10, color: 'var(--cc-danger, #f66)', marginTop: 4 }}>{err}</div>
      )}
    </div>
  );
}

function SpeedControl({ item, onChange }: { item: TimelineItem; onChange: (rate: number) => void }) {
  const t = useT();
  const rate = item.playbackRate ?? 1;
  return (
    <div>
      <SliderRow
        label={t('variable speed')}
        val={rate}
        min={0.25}
        max={4}
        step={0.05}
        fmt={`${rate.toFixed(2)}×`}
        onChange={onChange}
      />
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 4 }}>
        {SPEED_PRESETS.map((s) => (
          <button
            key={s}
            type="button"
            className="cc-insp-btn"
            style={{
              fontSize: 10,
              padding: '2px 6px',
              opacity: Math.abs(rate - s) < 0.01 ? 1 : 0.7,
              fontWeight: Math.abs(rate - s) < 0.01 ? 700 : 400,
            }}
            onClick={() => onChange(s)}
          >
            {s}×
          </button>
        ))}
      </div>
      <div className="cc-insp-muted" style={{ fontSize: 10, marginTop: 4 }}>
        {t('Pitch-maintaining speed change (preview/export)· Duration expands and contracts with speed and ripples together')}
      </div>
    </div>
  );
}

// fade in/out (seconds) — opacity ramp for visual clips, volume ramp for audio.
function FadeControl({ item, fps, onChange }: { item: TimelineItem; fps: number; onChange: (f: FadePatch) => void }) {
  const t = useT();
  const maxSec = Math.max(0.1, item.durationInFrames / fps);
  const row = (label: string, frames: number | undefined, key: keyof FadePatch) => {
    const sec = (frames ?? 0) / fps;
    return (
      <SliderRow
        key={key}
        label={label}
        val={sec}
        min={0}
        max={maxSec}
        step={0.1}
        fmt={`${sec.toFixed(1)}s`}
        onChange={(v) => onChange({ [key]: Math.round(v * fps) })}
      />
    );
  };
  return (
    <div className="cc-insp-stack">
      {row(t('fade in'), item.fadeInFrames, 'fadeInFrames')}
      {row(t('fade out'), item.fadeOutFrames, 'fadeOutFrames')}
    </div>
  );
}

// text clip content controls (text/fontSize/color/weight/align) — props-backed.
function TextControl({ item, onPropChange }: { item: TimelineItem; onPropChange: (key: string, value: unknown) => void }) {
  const t = useT();
  const p = item.props ?? {};
  const selStyle: React.CSSProperties = { background: theme.bg, color: theme.text, border: `0.5px solid ${theme.borderLight}`, borderRadius: 4, padding: '3px 5px' };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <label style={{ fontSize: 11, color: theme.textDim }}>
        <div style={{ marginBottom: 4 }}>{t('Text content')}</div>
        <textarea value={String(p.text ?? '')} onChange={(e) => onPropChange('text', e.target.value)} rows={2}
          style={{ width: '100%', padding: '6px 8px', background: theme.bg, color: theme.text, border: `0.5px solid ${theme.borderLight}`, borderRadius: 5, resize: 'vertical', fontFamily: 'inherit', fontSize: 12 }} />
      </label>
      <label style={{ fontSize: 11, color: theme.textDim }}>
        <div style={{ marginBottom: 4 }}>{t('Font size')} <span style={{ opacity: 0.7 }}>{Number(p.fontSize ?? 96)}</span></div>
        <input type="range" min={24} max={300} step={2} value={Number(p.fontSize ?? 96)} onChange={(e) => onPropChange('fontSize', Number(e.target.value))} style={{ width: '100%' }} />
      </label>
      <div style={{ display: 'flex', gap: 14, alignItems: 'center', flexWrap: 'wrap' }}>
        <label style={{ fontSize: 11, color: theme.textDim, display: 'flex', alignItems: 'center', gap: 6 }}>
          {t('color')} <input type="color" value={String(p.color ?? '#ffffff')} onChange={(e) => onPropChange('color', e.target.value)} />
        </label>
        <label style={{ fontSize: 11, color: theme.textDim, display: 'flex', alignItems: 'center', gap: 6 }}>
          {t('Align')}
          <select value={String(p.align ?? 'center')} onChange={(e) => onPropChange('align', e.target.value)} style={selStyle}>
            <option value="left">{t('left')}</option><option value="center">{t('in')}</option><option value="right">{t('right')}</option>
          </select>
        </label>
        <label style={{ fontSize: 11, color: theme.textDim, display: 'flex', alignItems: 'center', gap: 6 }}>
          {t('Thickness')}
          <select value={String(p.fontWeight ?? 700)} onChange={(e) => onPropChange('fontWeight', Number(e.target.value))} style={selStyle}>
            <option value="400">{t('regular')}</option><option value="700">{t('Bold')}</option><option value="900">{t('Extra thick')}</option>
          </select>
        </label>
      </div>
    </div>
  );
}


// animated zoom (builtin:zoom): shape curve + magnification + focal point,
// plus ReframeCurveV1 sparse keyframes (drop focal+mag at the playhead).
function ZoomControl({ zoom, onChange, getLocalFrame, fps, onSetKeyframe, onRemoveKeyframe }: {
  zoom: ZoomEffect | undefined;
  onChange: (patch: Partial<ZoomEffect> | null) => void;
  getLocalFrame: () => number;
  fps: number;
  onSetKeyframe: (frame: number, fx: number, fy: number, mag: number) => void;
  onRemoveKeyframe: (frame: number) => void;
}) {
  const t = useT();
  const localFrame = getLocalFrame();
  return (
    <div className="cc-insp-stack">
      <label className="cc-insp-row">
        <span className="cc-insp-label">{t('Curve')}</span>
        <select className="cc-insp-select" value={zoom?.shape ?? ''} onChange={(e) => {
          const v = e.target.value as ZoomShape | '';
          if (!v) onChange(null);
          else onChange({ shape: v });
        }}>
          <option value="">{t('None')}</option>
          {ZOOM_SHAPE_ORDER.map((k) => <option key={k} value={k}>{t(ZOOM_SHAPE_LABELS[k])}</option>)}
        </select>
      </label>
      {zoom && (
        <>
          <SliderRow label={t('multiple')} val={zoom.magnification ?? 1.5} min={1} max={4} step={0.05} fmt={`${(zoom.magnification ?? 1.5).toFixed(2)}×`} onChange={(v) => onChange({ magnification: v })} />
          <SliderRow label={t('focusX')} val={zoom.focalPointX ?? 0.5} min={0} max={1} step={0.01} fmt={`${Math.round((zoom.focalPointX ?? 0.5) * 100)}%`} onChange={(v) => onChange({ focalPointX: v })} />
          <SliderRow label={t('focusY')} val={zoom.focalPointY ?? 0.5} min={0} max={1} step={0.01} fmt={`${Math.round((zoom.focalPointY ?? 0.5) * 100)}%`} onChange={(v) => onChange({ focalPointY: v })} />
          <div className="cc-insp-actions">
            <button
              type="button"
              onClick={() => onSetKeyframe(getLocalFrame(), zoom.focalPointX ?? 0.5, zoom.focalPointY ?? 0.5, zoom.magnification ?? 1.5)}
              title={t('Record focus on playhead+Multiples are keyframes')}
              className="cc-insp-btn"
            >
              <Icon name="diamond" size={12} />{t('keyframe')}
            </button>
            <span className="cc-insp-muted">@ {(localFrame / fps).toFixed(2)}s</span>
          </div>
          {(zoom.reframeCurve?.keyframes.length ?? 0) > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <div style={{ fontSize: 10.5, color: theme.textDim, opacity: 0.8 }}>{t('Keyframes (overlay curves, frame-by-frame interpolation)')}</div>
              {zoom.reframeCurve!.keyframes.map((k) => (
                <div key={k.frame} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11, color: theme.textDim }}>
                  <span style={{ fontVariantNumeric: 'tabular-nums', display: 'inline-flex', alignItems: 'center', gap: 4 }}><Icon name="diamond" size={11} />{(k.frame / fps).toFixed(2)}s</span>
                  <span style={{ opacity: 0.8 }}>{k.magnification.toFixed(2)}× · ({Math.round(k.focalPointX * 100)},{Math.round(k.focalPointY * 100)})</span>
                  <button onClick={() => onRemoveKeyframe(k.frame)} title={t('Delete keyframes')} style={{ background: 'none', border: 'none', color: theme.textDim, cursor: 'pointer', fontSize: 12, marginLeft: 'auto', display: 'inline-flex', alignItems: 'center' }}><Icon name="x" size={12} /></button>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}


// transition INTO the selected clip from the previous adjacent same-track clip.
// Picking a type creates it; None removes it.
function TransitionControl({ transition, fps, onAdd, onSet, onRemove, audioMode }: {
  transition: TransitionItem | null;
  fps: number;
  onAdd: (type: TransitionType) => void;
  onSet: (patch: Partial<TransitionItem>) => void;
  onRemove: () => void;
  /** true = only audio-cross-fade (trAudioCrossFade) */
  audioMode?: boolean;
}) {
  const t = useT();
  const selStyle: React.CSSProperties = { background: theme.bg, color: theme.text, border: `0.5px solid ${theme.borderLight}`, borderRadius: 4, padding: '3px 5px' };
  const needsDir = transition && (transition.type === 'soft-wipe' || transition.type === 'whip-pan');
  const options = audioMode ? AUDIO_TRANSITION_ORDER : TRANSITION_ORDER;
  // When audioMode, ignore a visual transition on this clip (shouldn't exist)
  const shown = transition && (audioMode
    ? transition.type === 'audio-cross-fade'
    : transition.type !== 'audio-cross-fade')
    ? transition
    : null;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ fontSize: 10.5, color: theme.textDim, opacity: 0.8 }}>
        {audioMode
          ? t('Crossfade with the adjacent audio of the previous segment (fade out point / entry point crescendo)')
          : t('Enter this segment from the previous adjacent segment')}
      </div>
      <label style={{ fontSize: 11, color: theme.textDim, display: 'flex', alignItems: 'center', gap: 8 }}>
        {t('Type')}
        <select value={shown?.type ?? ''} style={selStyle} onChange={(e) => {
          const v = e.target.value as TransitionType | '';
          if (!v) { if (shown) onRemove(); }
          else if (shown) onSet({ type: v });
          else onAdd(v);
        }}>
          <option value="">{t('None')}</option>
          {options.map((k) => <option key={k} value={k}>{t(TRANSITION_LABELS[k])}</option>)}
        </select>
      </label>
      {shown && (
        <>
          <label style={{ fontSize: 11, color: theme.textDim }}>
            <div style={{ marginBottom: 4 }}>{t('duration')} <span style={{ opacity: 0.7 }}>{(shown.durationInFrames / fps).toFixed(1)}s</span></div>
            <input type="range" min={2} max={Math.max(4, fps * 2)} step={1} value={shown.durationInFrames} onChange={(e) => onSet({ durationInFrames: Number(e.target.value) })} style={{ width: '100%' }} />
          </label>
          {needsDir && !audioMode && (
            <label style={{ fontSize: 11, color: theme.textDim, display: 'flex', alignItems: 'center', gap: 8 }}>
              {t('direction')}
              <select value={shown.direction ?? 'left'} style={selStyle} onChange={(e) => onSet({ direction: e.target.value as TransitionItem['direction'] })}>
                <option value="left">{t('left')}</option><option value="right">{t('right')}</option><option value="up">{t('on')}</option><option value="down">{t('down')}</option>
              </select>
            </label>
          )}
        </>
      )}
    </div>
  );
}

// small uppercase-ish divider label between control groups.
function SectionLabel({ children }: { children: React.ReactNode }) {
  return <div className="cc-insp-section">{children}</div>;
}

// brightness / contrast / saturation / blur implemented with CSS filters.
function FilterControl({ item, onChange, autoGrade }: {
  item: TimelineItem;
  onChange: (p: ClipFilters) => void;
  autoGrade?: AutoGradeControlProps;
}) {
  const t = useT();
  const fl: ClipFilters = { ...item.filters, ...(autoGrade?.selectedPreview?.filters ?? {}) };
  return (
    <div className="cc-insp-stack">
      {autoGrade && (
        <div className={`cc-auto-grade${autoGrade.previewCount ? ' previewing' : ''}`}>
          <div className="cc-auto-grade-head">
            <div>
              <strong>{t('Automatic color correction')}</strong>
              <span>{t('conservative technical correction')}</span>
            </div>
            <button
              type="button"
              className="cc-insp-btn"
              disabled={autoGrade.busy || autoGrade.targetCount === 0}
              onClick={() => void autoGrade.onAnalyze()}
            >
              {autoGrade.busy ? t('Analyzing…') : t('Analyze selected clip')}
            </button>
          </div>
          <div className="cc-auto-grade-note">
            {autoGrade.targetCount === 0
              ? t('Please select a video, picture, or GIF fragment')
              : t('Native sampling analysis, only small brightness, contrast and saturation corrections, no creativity added LUT。')}
          </div>
          {autoGrade.previewCount > 0 && (
            <div className="cc-auto-grade-result">
              <div>
                <b>{t('Previewing · {n} fragments', { n: autoGrade.previewCount })}</b>
                {autoGrade.failedCount > 0 && <span>{t(' · {n} a failure', { n: autoGrade.failedCount })}</span>}
                {autoGrade.selectedPreview && (
                  <span>
                    {` · ${autoGrade.selectedPreview.bitDepth}-bit${autoGrade.selectedPreview.hdr ? ' HDR' : ' SDR'}`}
                    {` · ${Math.round(autoGrade.selectedPreview.filters.brightness * 100)}% / ${Math.round(autoGrade.selectedPreview.filters.contrast * 100)}% / ${Math.round(autoGrade.selectedPreview.filters.saturate * 100)}%`}
                  </span>
                )}
              </div>
              <div className="cc-insp-actions">
                <button type="button" className="cc-insp-btn primary" onClick={autoGrade.onApply}>{t('Apply color correction')}</button>
                <button type="button" className="cc-insp-btn" onClick={autoGrade.onCancel}>{t('Cancel preview')}</button>
              </div>
            </div>
          )}
        </div>
      )}
      <SliderRow label={t('brightness')} val={fl.brightness ?? 1} min={0} max={2} step={0.05} fmt={`${Math.round((fl.brightness ?? 1) * 100)}%`} onChange={(v) => onChange({ brightness: v })} />
      <SliderRow label={t('Contrast')} val={fl.contrast ?? 1} min={0} max={2} step={0.05} fmt={`${Math.round((fl.contrast ?? 1) * 100)}%`} onChange={(v) => onChange({ contrast: v })} />
      <SliderRow label={t('saturated')} val={fl.saturate ?? 1} min={0} max={2} step={0.05} fmt={`${Math.round((fl.saturate ?? 1) * 100)}%`} onChange={(v) => onChange({ saturate: v })} />
      <SliderRow label={t('blurry')} val={fl.blur ?? 0} min={0} max={30} step={1} fmt={`${Math.round(fl.blur ?? 0)}px`} onChange={(v) => onChange({ blur: v })} />
    </div>
  );
}

const rgbToHex = (rgb: number[]) => `#${rgb.slice(0, 3).map((n) => Math.round(Math.min(1, Math.max(0, n)) * 255).toString(16).padStart(2, '0')).join('')}`;
const hexToRgb = (hex: string) => [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16) / 255);

// Per-clip WebGL effect stack (special effects / builtin:fx-*). Order is render
// order: each card consumes the previous card's output.
function EffectsControl({ item, onChange }: { item: TimelineItem; onChange: (effects: ClipEffect[]) => void }) {
  const t = useT();
  const effects = item.effects ?? [];
  const active = effects.filter((fx) => fx.assetId in FX_EFFECTS);
  const addEffect = (assetId: string) => {
    if (assetId) onChange([...effects, { id: `fx_${crypto.randomUUID()}`, assetId, overrides: {} }]);
  };
  const updateEffect = (id: string, patch: Partial<ClipEffect>) => onChange(effects.map((fx) => fx.id === id ? { ...fx, ...patch } : fx));
  const setParam = (effect: ClipEffect, key: string, value: ClipEffectValue) => {
    updateEffect(effect.id, { overrides: { ...effect.overrides, [key]: value } });
  };
  const moveEffect = (index: number, delta: number) => {
    const other = active[index + delta];
    if (!other) return;
    const from = effects.findIndex((fx) => fx.id === active[index].id);
    const to = effects.findIndex((fx) => fx.id === other.id);
    const next = [...effects];
    [next[from], next[to]] = [next[to], next[from]];
    onChange(next);
  };
  const fmt = (step: number | undefined, v: number) => (step && step < 1 ? v.toFixed(2) : String(Math.round(v)));
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <select value="" onChange={(e) => addEffect(e.target.value)}
        style={{ width: '100%', background: theme.panelAlt, color: theme.text, border: `0.5px solid ${theme.border}`, borderRadius: 6, padding: '5px 7px', fontSize: 12 }}>
        <option value="">{t('+ Add special effects…')}</option>
        {FX_IDS.map((id) => <option key={id} value={id}>{t(FX_EFFECTS[id].name)}</option>)}
      </select>
      {active.length === 0 && <div style={{ fontSize: 10.5, color: theme.textDim }}>{t('No special effects have been added yet.')}</div>}
      {active.map((effect, index) => {
        const def = FX_EFFECTS[effect.assetId];
        return (
          <div key={effect.id} style={{ display: 'flex', flexDirection: 'column', gap: 9, border: `0.5px solid ${theme.border}`, borderRadius: 4, padding: 9 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11.5, color: theme.text }}>
              <b style={{ flex: 1 }}>{index + 1}. {t(def.name)}
                {effect.assetId in LUT_EFFECTS && <span style={{ fontSize: 9, fontWeight: 700, color: theme.textDim, border: `0.5px solid ${theme.border}`, borderRadius: 3, padding: '0 3px', marginLeft: 5, verticalAlign: 'middle' }}>LUT</span>}
              </b>
              <button title={t('move up')} disabled={index === 0} onClick={() => moveEffect(index, -1)}>↑</button>
              <button title={t('move down')} disabled={index === active.length - 1} onClick={() => moveEffect(index, 1)}>↓</button>
              <button title={t('Remove effects')} onClick={() => onChange(effects.filter((fx) => fx.id !== effect.id))}>×</button>
            </div>
            <div style={{ fontSize: 10.5, color: theme.textDim, opacity: 0.75, lineHeight: 1.4 }}>{t(def.desc)}</div>
            {def.props.map((p) => {
              const raw = effect.overrides?.[p.key] ?? p.default;
              if (p.kind === 'color') {
                const value = Array.isArray(raw) ? raw : p.default;
                return (
                  <label key={p.key} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 11, color: theme.textDim }}>
                    {t(p.label)}
                    <input type="color" value={rgbToHex(value)} onInput={(e) => setParam(effect, p.key, hexToRgb(e.currentTarget.value))} />
                  </label>
                );
              }
              const value = typeof raw === 'number' ? raw : p.default;
              return (
                <label key={p.key} style={{ display: 'block', fontSize: 11, color: theme.textDim }}>
                  <div style={{ marginBottom: 4 }}>{t(p.label)} <span style={{ opacity: 0.7 }}>{fmt(p.step, value)}</span></div>
                  <input type="range" min={p.min} max={p.max} step={p.step ?? 0.01} value={value} onChange={(e) => setParam(effect, p.key, Number(e.target.value))} style={{ width: '100%' }} />
                </label>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}

// Property editor for the selected timeline item (sits under the preview).
// Collapsible so it doesn't crowd the preview when you don't need it.
export function InspectorPanel({ templates, selectedItem, fps, onItemPropChange, onItemVolumeChange, onItemFadeChange, onItemTransformChange, onItemFiltersChange, autoGrade, onItemZoomChange, onItemEffectsChange, onItemSpeedChange, onNormalizeLoudness, onIsolateVoice, getPlayhead, onSetReframeKeyframe, onRemoveReframeKeyframe, onSetItemKeyframe, onRemoveItemKeyframe, onSeek, transition, onAddTransition, onSetTransition, onRemoveTransition }: InspectorPanelProps) {
  const t = useT();
  const [collapsed, setCollapsed] = usePersistedState('cc.inspectorCollapsed', false);
  const schema = selectedItem
    ? templates.find((tpl) => tpl.id === selectedItem.templateId)?.propSchema ?? []
    : [];

  const hint = selectedItem
    ? selectedItem.kind === 'audio'
      ? t('Audio clip. You can drag the position on the timeline and crop the beginning and end.')
      : selectedItem.kind === 'video'
      ? t('Video clips. You can drag the position on the timeline and crop the beginning and end (left cropping advances the source entry point).')
      : selectedItem.kind === 'image'
      ? t('Picture fragment.')
      : selectedItem.kind === 'gif'
      ? t('GIF fragment.')
      : selectedItem.kind === 'svg'
      ? t('SVG fragment.')
      : selectedItem.kind === 'solid'
      ? t('Solid color clip.')
      : selectedItem.kind === 'text'
      ? t('Text snippet.')
      : null
    : null;
  const hasVolume = selectedItem?.kind === 'audio' || selectedItem?.kind === 'video';
  const isVisual = selectedItem != null && selectedItem.kind !== 'audio';

  return (
    <section className={`cc-inspector${collapsed ? ' collapsed' : ''}`}>
      <button
        type="button"
        onClick={() => setCollapsed((v) => !v)}
        title={collapsed ? t('Expand properties') : t('Collapse properties')}
        className="cc-insp-header"
      >
        <span className={`cc-insp-chevron${collapsed ? ' closed' : ''}`}><Icon name="chevronDown" size={12} /></span>
        <span className="cc-insp-title">{t('Properties')}{selectedItem ? ` · ${selectedItem.name}` : ''}</span>
        {selectedItem?.denoisedSrc && <span className="cc-insp-pill">{t('Vocal isolation')}</span>}
      </button>
      {!collapsed && (
      <div className="cc-insp-body">
        {!selectedItem ? (
          <div className="cc-insp-muted">{t('Select a clip on the timeline to edit properties.')}</div>
        ) : (
          <div className="cc-insp-groups">
            {hint && <div className="cc-insp-hint">{hint}</div>}
            {selectedItem.kind === 'text' && <><SectionLabel>{t('text')}</SectionLabel><TextControl item={selectedItem} onPropChange={onItemPropChange} /></>}
            {hasVolume && (
              <>
                <SectionLabel>{t('Volume')}</SectionLabel>
                <VolumeControl item={selectedItem} onChange={onItemVolumeChange} onNormalize={onNormalizeLoudness} />
              </>
            )}
            {(selectedItem.kind === 'video' || selectedItem.kind === 'audio') && onIsolateVoice && (
              <><SectionLabel>{t('Vocal isolation')}</SectionLabel><IsolateVoiceControl item={selectedItem} onIsolate={onIsolateVoice} /></>
            )}
            {(selectedItem.kind === 'video' || selectedItem.kind === 'audio') && onItemSpeedChange && (
              <><SectionLabel>{t('variable speed')}</SectionLabel><SpeedControl item={selectedItem} onChange={onItemSpeedChange} /></>
            )}
            {isVisual && <><SectionLabel>{t('transform')}</SectionLabel><TransformControl item={selectedItem} onChange={onItemTransformChange} kf={{
              localFrame: Math.max(0, Math.min(selectedItem.durationInFrames - 1, Math.round(getPlayhead()) - selectedItem.startFrame)),
              set: onSetItemKeyframe,
              remove: onRemoveItemKeyframe,
              seekLocal: (frame) => onSeek(selectedItem.startFrame + frame),
            }} /></>}
            {isVisual && <><SectionLabel>{t('filter')}</SectionLabel><FilterControl item={selectedItem} onChange={onItemFiltersChange} autoGrade={autoGrade} /></>}
            {/* GIF Not entering GL pipeline(Rendering side only texturing video/image),No special effects entrance is provided;Historical legacy can be removed by right-clicking on the clip */}
            {(selectedItem.kind === 'video' || selectedItem.kind === 'image') && <><SectionLabel>{t('special effects')}</SectionLabel><EffectsControl item={selectedItem} onChange={onItemEffectsChange} /></>}
            {isVisual && <><SectionLabel>{t('Zoom')}</SectionLabel><ZoomControl zoom={selectedItem.zoom} onChange={onItemZoomChange} getLocalFrame={() => Math.max(0, Math.min(selectedItem.durationInFrames - 1, getPlayhead() - selectedItem.startFrame))} fps={fps} onSetKeyframe={onSetReframeKeyframe} onRemoveKeyframe={onRemoveReframeKeyframe} /></>}
            {isVisual && <><SectionLabel>{t('Transition')}</SectionLabel><TransitionControl transition={transition} fps={fps} onAdd={onAddTransition} onSet={onSetTransition} onRemove={onRemoveTransition} audioMode={false} /></>}
            {selectedItem.kind === 'audio' && (
              <><SectionLabel>{t('audio transition')}</SectionLabel>
              <TransitionControl transition={transition} fps={fps} onAdd={onAddTransition} onSet={onSetTransition} onRemove={onRemoveTransition} audioMode /></>
            )}
            <SectionLabel>{t('Fade in and out')}</SectionLabel>
            <FadeControl item={selectedItem} fps={fps} onChange={onItemFadeChange} />
            {selectedItem.kind === 'solid' && (
              <>
                <SectionLabel>{t('solid color')}</SectionLabel>
                <label className="cc-insp-mg-field">
                  <span>{t('fill color')}</span>
                  <input
                    type="color"
                    value={String(selectedItem.props?.color ?? '#1a1a1a')}
                    onChange={(e) => onItemPropChange('color', e.target.value)}
                  />
                </label>
              </>
            )}
            {selectedItem.kind === 'motion-graphic' && (
              schema.length === 0 ? (
                <div className="cc-insp-muted">{t('This template has no editable properties.')}</div>
              ) : (
                <div className="cc-insp-mg-grid">
                  {/* index in key: multi-asset templates may repeat a prop key */}
                  {schema.map((p, i) => (
                    <PropSchemaField
                      key={`${i}:${p.key}`}
                      spec={p}
                      value={selectedItem.props?.[p.key]}
                      onChange={(v) => onItemPropChange(p.key, v)}
                    />
                  ))}
                </div>
              )
            )}
          </div>
        )}
      </div>
      )}
    </section>
  );
}
