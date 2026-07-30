import { createContext, useContext, useEffect, useRef, useState, type RefObject } from 'react';
import type { PlayerRef } from '@remotion/player';
import { theme } from '../theme';
import type { PropSpec, Tpl } from '../types';
import type { ClipEffect, ClipEffectValue, ClipFilters, ClipTransform, Keyframe, KeyframeEasing, KeyframeProp, TimelineItem, TransitionItem, TransitionType, ZoomEffect, ZoomShape } from '../editor/types';
import { AUDIO_TRANSITION_ORDER, TRANSITION_LABELS, TRANSITION_ORDER, ZOOM_SHAPE_LABELS, ZOOM_SHAPE_ORDER } from '../editor/types';
import { sampleKeyframes } from '../editor/keyframes';
import { KEYFRAME_PROPS, getKeyframePropertyDefinition } from '../editor/keyframeRegistry';
import { ALL_FX as FX_EFFECTS, LUT_EFFECTS } from '../gl/fx/effects';
const FX_IDS = Object.keys(FX_EFFECTS);
const compactNumber = (value: number) => String(Number(value.toFixed(2)));
import { Icon } from './icons';
import { FONT_CATALOG } from '../fonts/googleFonts';
import { useT } from '../i18n/locale';
import { showAppToast } from '../ui/appToast';
import { importMedia } from '../media/upload';
import { ScalarControl } from './inspector/ScalarControl';
import { snapScalar } from './inspector/scalarMath';

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
              {f.family}{f.aliases[0] ? ` · ${f.aliases[0]}` : ''}{f.loadable ? '' : ` ${t('(预览)')}`}
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
            placeholder={spec.type === 'video' ? t('视频 URL 或 /media/uploads/…') : t('图片 URL 或 /media/uploads/…')}
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
  collapsed: boolean;
  onCollapsedChange: (collapsed: boolean) => void;
  onItemPropChange: (key: string, value: unknown) => void;
  onItemVolumeChange: (volume: number) => void;
  onItemFadeChange: (fade: FadePatch) => void;
  onItemTransformChange: (patch: ClipTransform) => void;
  onItemFiltersChange: (patch: ClipFilters) => void;
  autoGrade?: AutoGradeControlProps;
  onItemZoomChange: (patch: Partial<ZoomEffect> | null) => void;
  onItemEffectsChange: (effects: ClipEffect[]) => void;
  /** Variable speed (0.1–8×); preview/export preservePitch*/
  onItemSpeedChange?: (rate: number) => void;
  /** Loudness normalized to -14 LUFS (set volume after analysis)*/
  onNormalizeLoudness?: () => void | Promise<void>;
  /**
   * Vocal isolation (out of the box ffmpeg): apply hangs denoisedSrc, clear clears.
   * strength 0..100; returned by store setItemDenoise.
   */
  onIsolateVoice?: (action: 'apply' | 'clear', strength?: number) => void | Promise<void>;
  getPlayhead: () => number;
  onSetReframeKeyframe: (frame: number, focalPointX: number, focalPointY: number, magnification: number) => void;
  onRemoveReframeKeyframe: (frame: number) => void;
  /** generic transform keyframes (PRD §4.5) on the selected item — item-local frames */
  onSetItemKeyframe: (prop: KeyframeProp, frame: number, value: number, easing?: KeyframeEasing) => void;
  onRemoveItemKeyframe: (prop: KeyframeProp, frame: number) => void;
  onResetItemKeyframes: (props: readonly KeyframeProp[]) => void;
  /** seek the preview to an ABSOLUTE timeline frame (‹/› keyframe jumps) */
  onSeek: (frame: number) => void;
  transition: TransitionItem | null;
  onAddTransition: (type: TransitionType) => void;
  onSetTransition: (patch: Partial<TransitionItem>) => void;
  onRemoveTransition: () => void;
  /** Preview player handle: The keyframe bar should be updated in real time with the playhead disabled state and ◆ filled.*/
  playerRef: RefObject<PlayerRef | null>;
  /** Continuous gesture boundaries (drag slider/color picker): Changes between them are merged into one undo record.*/
  historyGesture: { begin: () => void; end: () => void };
}

/**
 * The boundaries of continuous gestures. The slider and color picker will be gradually dispatched during dragging (so that there is a real-time preview),
 * But those steps must be merged into **one** undo record - otherwise volume 0→2 in 0.05 steps will push in about 40 snapshots,
 * The upper limit of history is only 100. Dragging the slider twice will squeeze out the user's real editing history.
 * The purpose of passing context is to avoid adding parameters to each of the dozen slider call points.
 */
const HistoryGestureContext = createContext<{ begin: () => void; end: () => void } | null>(null);

/** The gesture starts when the pointer is pressed and ends when the pointer is released (no matter where it is released). The same goes for pressing the arrow keys on the keyboard.*/
function useHistoryGesture(): {
  onPointerDown: () => void;
  onKeyDown: () => void;
  onKeyUp: () => void;
} {
  const gesture = useContext(HistoryGestureContext);
  const active = useRef(false);
  const end = () => {
    if (!active.current) return;
    active.current = false;
    gesture?.end();
  };
  const begin = () => {
    if (active.current) return;
    active.current = true;
    gesture?.begin();
  };
  // When the component is uninstalled (for example, the selected fragment is switched during dragging), it must also be finished to prevent the gesture from being turned on all the time.
  useEffect(() => () => {
    if (!active.current) return;
    active.current = false;
    gesture?.end();
  }, [gesture]);
  return {
    onPointerDown: () => {
      begin();
      // The pointer may be released outside the control, so listen to window rather than the control itself
      window.addEventListener('pointerup', end, { once: true });
      window.addEventListener('pointercancel', end, { once: true });
    },
    onKeyDown: begin,
    onKeyUp: end,
  };
}

/** Color Picker: OnInput is triggered once when the mouse is moved in the color picker panel. Like the slider, it must be merged into an undo record.*/
function ColorParamInput({ value, onPick }: { value: number[]; onPick: (rgb: number[]) => void }) {
  const gesture = useHistoryGesture();
  return (
    <input
      type="color"
      value={rgbToHex(value)}
      onInput={(e) => onPick(hexToRgb(e.currentTarget.value))}
      {...gesture}
    />
  );
}

/** Compact one-line slider: label | track | value */
function SliderRow({
  label, val, min, max, step, fmt, inputScale, onChange, onReset, resetDisabled, disabled, disabledReason,
}: {
  label: string; val: number; min: number; max: number; step: number; fmt: string; onChange: (v: number) => void;
  inputScale?: number;
  onReset?: () => void;
  resetDisabled?: boolean;
  /** Disabled when keyframed but the playhead is not within the clip: dragging it will only write the keyframe to the clipped frame 0.*/
  disabled?: boolean;
  disabledReason?: string;
}) {
  const t = useT();
  const gesture = useHistoryGesture();
  return (
    <div className="cc-insp-row" title={disabled ? disabledReason : undefined} style={disabled ? { opacity: 0.45 } : undefined}>
      <span className="cc-insp-label">{label}</span>
      <input
        aria-label={label}
        className="cc-insp-range"
        type="range" min={min} max={max} step="any" value={val}
        disabled={disabled}
        onChange={(e) => onChange(snapScalar(Number(e.target.value), min, max, step))}
        {...gesture}
      />
      <span className="cc-insp-val">
        <ScalarControl
          ariaLabel={t('输入{name}的精确值', { name: label })}
          disabled={disabled}
          formatValue={fmt}
          inputScale={inputScale}
          max={max}
          min={min}
          onChange={onChange}
          onGestureEnd={gesture.onKeyUp}
          onGestureStart={gesture.onKeyDown}
          step={step}
          title={t('点击输入精确值；左右拖动调整；Shift ×10；⌘ ×0.1')}
          value={val}
        />
        {onReset && (
          <button
            aria-label={t('重置{name}', { name: label })}
            className="cc-insp-reset"
            disabled={resetDisabled}
            title={t('重置{name}', { name: label })}
            type="button"
            onClick={onReset}
          >
            <Icon name="undo" size={11} />
          </button>
        )}
      </span>
    </div>
  );
}

/** per-property keyframe API handed down by InspectorPanel (playhead in item-local frames) */
interface KfApi {
  localFrame: number;
  /**
   * Whether the playhead actually falls within this clip. localFrame is sandwiched into [0, dur), so the playhead is in the clip
   * When outside, it collapses to frame 0 - keyframing it will hit a place where the user is not even looking. Four keyframe controls
   * and "Whether there is a keyframe here" both rely on the same clipped frame number, so they need to press this switch together.
   */
  inRange: boolean;
  set: (prop: KeyframeProp, frame: number, value: number, easing?: KeyframeEasing) => void;
  remove: (prop: KeyframeProp, frame: number) => void;
  seekLocal: (frame: number) => void;
}

const EASING_OPTIONS: { value: 'linear' | 'easeIn' | 'easeOut' | 'easeInOut'; label: string }[] = [
  { value: 'linear', label: '线性' }, { value: 'easeIn', label: '缓入' },
  { value: 'easeOut', label: '缓出' }, { value: 'easeInOut', label: '缓入出' },
];

// end-of-row keyframe rail (PRD §4.5; UI imitates reframe keyframe mode, custom layout):
// ◆ punches/updates at the playhead (filled when one sits there), ‹ › jump
// between keyframes, × deletes the one under the playhead, plus segment easing.
function KfCell({ kfs, localFrame, inRange, punchValue, onSet, onRemove, onSeekLocal }: {
  kfs: Keyframe[] | undefined;
  localFrame: number;
  inRange: boolean;
  punchValue: number;
  onSet: (frame: number, value: number, easing?: KeyframeEasing) => void;
  onRemove: (frame: number) => void;
  onSeekLocal: (frame: number) => void;
}) {
  const t = useT();
  // When the playhead is not within the clip, localFrame is a false value that collapses to 0, and all judgments based on it cannot be used.
  const at = inRange ? kfs?.find((k) => k.frame === localFrame) : undefined;
  const prev = inRange && kfs ? [...kfs].reverse().find((k) => k.frame < localFrame) : undefined;
  const next = inRange ? kfs?.find((k) => k.frame > localFrame) : undefined;
  const outside = t('把播放头移进这个片段才能打关键帧');
  const btn: React.CSSProperties = { background: 'none', border: 'none', cursor: 'pointer', padding: 0, width: 13, height: 16, display: 'grid', placeItems: 'center', fontSize: 10, color: theme.textDim, lineHeight: 1 };
  const off: React.CSSProperties = { ...btn, opacity: 0.3, cursor: 'default' };
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 1, flexShrink: 0 }}>
      <button type="button" style={prev ? btn : off} disabled={!prev} title={t('上一关键帧')} onClick={() => prev && onSeekLocal(prev.frame)}>‹</button>
      <button
        type="button"
        disabled={!inRange}
        style={inRange
          ? { ...btn, fontSize: 11, color: at ? theme.accent : kfs?.length ? theme.textMuted : theme.textDim }
          : { ...off, fontSize: 11 }}
        title={!inRange ? outside : at ? t('更新播放头处的关键帧') : t('在播放头打关键帧')}
        onClick={() => inRange && onSet(localFrame, punchValue, at?.easing)}
      >{at ? '◆' : '◇'}</button>
      <button type="button" style={next ? btn : off} disabled={!next} title={t('下一关键帧')} onClick={() => next && onSeekLocal(next.frame)}>›</button>
      <button type="button" style={at ? btn : off} disabled={!at} title={t('删除播放头处的关键帧')} onClick={() => at && onRemove(localFrame)}>×</button>
      {at && (
        <select
          value={Array.isArray(at.easing) ? 'bezier' : at.easing ?? 'linear'}
          title={t('缓动（此关键帧到下一帧的曲线）')}
          onChange={(e) => {
            const v = e.target.value;
            if (v === 'bezier') return; // custom tuples are agent-authored; keep as-is
            onSet(localFrame, at.value, v === 'linear' ? undefined : (v as KeyframeEasing));
          }}
          style={{ background: theme.bg, color: theme.textDim, border: `0.5px solid ${theme.borderLight}`, borderRadius: 3, fontSize: 9, padding: '0 1px', maxWidth: 50 }}
        >
          {EASING_OPTIONS.map((o) => <option key={o.value} value={o.value}>{t(o.label)}</option>)}
          {Array.isArray(at.easing) && <option value="bezier">{t('贝塞尔')}</option>}
        </select>
      )}
    </span>
  );
}

// scale / position / rotation for visual clips (zoom tab) + per-property
// keyframe rails and an opacity curve row. A keyframed prop shows the
// value sampled at the playhead; dragging it then punches a keyframe there.
function TransformControl({
  item, onChange, onReset, kf,
}: {
  item: TimelineItem;
  onChange: (p: ClipTransform) => void;
  onReset: (props: readonly KeyframeProp[]) => void;
  kf: KfApi;
}) {
  const t = useT();
  const rows = KEYFRAME_PROPS
    .map(getKeyframePropertyDefinition)
    // Volume is not part of the transform stack — VolumeControl has its own keyframe track
    .filter((definition) => definition.id !== 'volume' && definition.supports(item));
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
                inputScale={r.id === 'scale' || r.id === 'opacity' ? 100 : 1}
                disabled={!!kfs?.length && !kf.inRange}
                disabledReason={t('把播放头移进这个片段才能改这里的关键帧')}
                onReset={() => onReset([r.id])}
                resetDisabled={!kfs?.length && Math.abs(r.getBaseValue(item) - r.defaultValue) < 1e-6}
                onChange={(next) => {
                  const patch = r.toTransformPatch?.(next);
                  if (!kfs?.length && patch) onChange(patch);
                  else if (kf.inRange) kf.set(r.id, kf.localFrame, next);
                }} />
            </div>
            <KfCell kfs={kfs} localFrame={kf.localFrame} inRange={kf.inRange} punchValue={value}
              onSet={(frame, next, easing) => kf.set(r.id, frame, next, easing)}
              onRemove={(frame) => kf.remove(r.id, frame)} onSeekLocal={kf.seekLocal} />
          </div>
        );
      })}
    </div>
  );
}

// audio + video clips carry a playback volume; image/MG do not. With volume
// keyframes present the slider shows the playhead-sampled value and edits punch
// a keyframe there (same override rule as TransformControl rows).
function VolumeControl({
  item, onChange, onNormalize, onReset, kf,
}: {
  item: TimelineItem;
  onChange: (v: number) => void;
  onNormalize?: () => void | Promise<void>;
  onReset: (props: readonly KeyframeProp[]) => void;
  kf: KfApi;
}) {
  const t = useT();
  const kfs = item.keyframes?.volume;
  const vol = kfs?.length ? sampleKeyframes(kfs, kf.localFrame) : item.volume ?? 1;
  const [busy, setBusy] = useState(false);
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <SliderRow label={t('音量')} val={vol} min={0} max={2} step={0.05} fmt={`${Math.round(vol * 100)}%`}
            inputScale={100}
            disabled={!!kfs?.length && !kf.inRange}
            disabledReason={t('把播放头移进这个片段才能改这里的关键帧')}
            onReset={() => onReset(['volume'])}
            resetDisabled={!kfs?.length && Math.abs((item.volume ?? 1) - 1) < 1e-6}
            onChange={(next) => {
              if (!kfs?.length) { onChange(next); return; }
              if (kf.inRange) kf.set('volume', kf.localFrame, next);
            }} />
        </div>
        <KfCell kfs={kfs} localFrame={kf.localFrame} inRange={kf.inRange} punchValue={vol}
          onSet={(frame, next, easing) => kf.set('volume', frame, next, easing)}
          onRemove={(frame) => kf.remove('volume', frame)} onSeekLocal={kf.seekLocal} />
      </div>
      {item.kind === 'audio' && onNormalize && (
        <button
          type="button"
          className="cc-insp-btn"
          disabled={busy || !item.src}
          title={t('分析并归一到 -14 LUFS')}
          style={{ marginTop: 6, width: '100%', fontSize: 11 }}
          onClick={() => {
            setBusy(true);
            void Promise.resolve(onNormalize()).finally(() => setBusy(false));
          }}
        >
          {busy ? t('分析中…') : t('响度归一 (-14 LUFS)')}
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
    if (action === 'apply') showAppToast(t('人声隔离处理中…'), { ms: 60_000 });
    void Promise.resolve(onIsolate(action, nextStrength))
      .then(() => {
        if (action === 'clear') showAppToast(t('已清除人声隔离'));
        else showAppToast(t('人声隔离已应用'));
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
        label={t('隔离强度')}
        val={strength}
        min={0}
        max={100}
        step={5}
        fmt={`${Math.round(strength)}`}
        onReset={() => setStrength(70)}
        resetDisabled={strength === 70}
        onChange={setStrength}
      />
      <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
        <button
          type="button"
          className="cc-insp-btn"
          disabled={busy || !canApply}
          title={!canApply ? t('需先上传到媒体池（/media/uploads）') : t('用本机 ffmpeg 频谱降噪，保留原轨')}
          style={{ flex: 1, fontSize: 11 }}
          onClick={() => run('apply', strength)}
        >
          {busy ? t('处理中…') : active ? t('重新隔离') : t('应用人声隔离')}
        </button>
        {active && (
          <button
            type="button"
            className="cc-insp-btn"
            disabled={busy}
            style={{ fontSize: 11 }}
            onClick={() => run('clear')}
          >
            {t('清除')}
          </button>
        )}
      </div>
      <div className="cc-insp-muted" style={{ fontSize: 10, marginTop: 4 }}>
        {active
          ? t('已应用 · 播放用隔离音轨 · master 不变')
          : t('开箱 ffmpeg 降噪（非 DeepFilterNet3）')}
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
        label={t('变速')}
        val={rate}
        min={0.25}
        max={4}
        step={0.05}
        fmt={`${rate.toFixed(2)}×`}
        onReset={() => onChange(1)}
        resetDisabled={Math.abs(rate - 1) < 1e-6}
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
        {t('保调变速（预览/导出）· 时长随速率伸缩并波纹合缝')}
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
        onReset={() => onChange({ [key]: 0 })}
        resetDisabled={sec === 0}
        onChange={(v) => onChange({ [key]: Math.round(v * fps) })}
      />
    );
  };
  return (
    <div className="cc-insp-stack">
      {row(t('淡入'), item.fadeInFrames, 'fadeInFrames')}
      {row(t('淡出'), item.fadeOutFrames, 'fadeOutFrames')}
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
        <div style={{ marginBottom: 4 }}>{t('文字内容')}</div>
        <textarea value={String(p.text ?? '')} onChange={(e) => onPropChange('text', e.target.value)} rows={2}
          style={{ width: '100%', padding: '6px 8px', background: theme.bg, color: theme.text, border: `0.5px solid ${theme.borderLight}`, borderRadius: 5, resize: 'vertical', fontFamily: 'inherit', fontSize: 12 }} />
      </label>
      <label style={{ fontSize: 11, color: theme.textDim }}>
        <div style={{ marginBottom: 4 }}>{t('字号')} <span style={{ opacity: 0.7 }}>{Number(p.fontSize ?? 96)}</span></div>
        <input type="range" min={24} max={300} step={2} value={Number(p.fontSize ?? 96)} onChange={(e) => onPropChange('fontSize', Number(e.target.value))} style={{ width: '100%' }} />
      </label>
      <div style={{ display: 'flex', gap: 14, alignItems: 'center', flexWrap: 'wrap' }}>
        <label style={{ fontSize: 11, color: theme.textDim, display: 'flex', alignItems: 'center', gap: 6 }}>
          {t('颜色')} <input type="color" value={String(p.color ?? '#ffffff')} onChange={(e) => onPropChange('color', e.target.value)} />
        </label>
        <label style={{ fontSize: 11, color: theme.textDim, display: 'flex', alignItems: 'center', gap: 6 }}>
          {t('对齐')}
          <select value={String(p.align ?? 'center')} onChange={(e) => onPropChange('align', e.target.value)} style={selStyle}>
            <option value="left">{t('左')}</option><option value="center">{t('中')}</option><option value="right">{t('右')}</option>
          </select>
        </label>
        <label style={{ fontSize: 11, color: theme.textDim, display: 'flex', alignItems: 'center', gap: 6 }}>
          {t('粗细')}
          <select value={String(p.fontWeight ?? 700)} onChange={(e) => onPropChange('fontWeight', Number(e.target.value))} style={selStyle}>
            <option value="400">{t('常规')}</option><option value="700">{t('粗体')}</option><option value="900">{t('特粗')}</option>
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
  const hasKeyframes = !!zoom?.reframeCurve?.keyframes.length;
  return (
    <div className="cc-insp-stack">
      <label className="cc-insp-row">
        <span className="cc-insp-label">{t('曲线')}</span>
        <select className="cc-insp-select" value={zoom?.shape ?? ''} onChange={(e) => {
          const v = e.target.value as ZoomShape | '';
          if (!v) onChange(null);
          else onChange({ shape: v });
        }}>
          <option value="">{t('无')}</option>
          {ZOOM_SHAPE_ORDER.map((k) => <option key={k} value={k}>{t(ZOOM_SHAPE_LABELS[k])}</option>)}
        </select>
      </label>
      {zoom && (
        <>
          <SliderRow label={t('倍数')} val={zoom.magnification ?? 1.5} min={1} max={4} step={0.05} fmt={`${(zoom.magnification ?? 1.5).toFixed(2)}×`}
            onReset={() => onChange({ magnification: 1.5, reframeCurve: undefined })} resetDisabled={!hasKeyframes && Math.abs((zoom.magnification ?? 1.5) - 1.5) < 1e-6}
            onChange={(v) => onChange({ magnification: v })} />
          <SliderRow label={t('焦点X')} val={zoom.focalPointX ?? 0.5} min={0} max={1} step={0.01} fmt={`${compactNumber((zoom.focalPointX ?? 0.5) * 100)}%`} inputScale={100}
            onReset={() => onChange({ focalPointX: 0.5, reframeCurve: undefined })} resetDisabled={!hasKeyframes && Math.abs((zoom.focalPointX ?? 0.5) - 0.5) < 1e-6}
            onChange={(v) => onChange({ focalPointX: v })} />
          <SliderRow label={t('焦点Y')} val={zoom.focalPointY ?? 0.5} min={0} max={1} step={0.01} fmt={`${compactNumber((zoom.focalPointY ?? 0.5) * 100)}%`} inputScale={100}
            onReset={() => onChange({ focalPointY: 0.5, reframeCurve: undefined })} resetDisabled={!hasKeyframes && Math.abs((zoom.focalPointY ?? 0.5) - 0.5) < 1e-6}
            onChange={(v) => onChange({ focalPointY: v })} />
          <div className="cc-insp-actions">
            <button
              type="button"
              onClick={() => onSetKeyframe(getLocalFrame(), zoom.focalPointX ?? 0.5, zoom.focalPointY ?? 0.5, zoom.magnification ?? 1.5)}
              title={t('在播放头记录焦点+倍数为关键帧')}
              className="cc-insp-btn"
            >
              <Icon name="diamond" size={12} />{t('关键帧')}
            </button>
            <span className="cc-insp-muted">@ {(localFrame / fps).toFixed(2)}s</span>
          </div>
          {(zoom.reframeCurve?.keyframes.length ?? 0) > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <div style={{ fontSize: 10.5, color: theme.textDim, opacity: 0.8 }}>{t('关键帧（覆盖曲线，逐帧插值）')}</div>
              {zoom.reframeCurve!.keyframes.map((k) => (
                <div key={k.frame} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11, color: theme.textDim }}>
                  <span style={{ fontVariantNumeric: 'tabular-nums', display: 'inline-flex', alignItems: 'center', gap: 4 }}><Icon name="diamond" size={11} />{(k.frame / fps).toFixed(2)}s</span>
                  <span style={{ opacity: 0.8 }}>{k.magnification.toFixed(2)}× · ({Math.round(k.focalPointX * 100)},{Math.round(k.focalPointY * 100)})</span>
                  <button onClick={() => onRemoveKeyframe(k.frame)} title={t('删除关键帧')} style={{ background: 'none', border: 'none', color: theme.textDim, cursor: 'pointer', fontSize: 12, marginLeft: 'auto', display: 'inline-flex', alignItems: 'center' }}><Icon name="x" size={12} /></button>
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
          ? t('与前一段相邻音频交叉淡化（出点渐弱 / 入点渐强）')
          : t('从前一个相邻片段进入本片段')}
      </div>
      <label style={{ fontSize: 11, color: theme.textDim, display: 'flex', alignItems: 'center', gap: 8 }}>
        {t('类型')}
        <select value={shown?.type ?? ''} style={selStyle} onChange={(e) => {
          const v = e.target.value as TransitionType | '';
          if (!v) { if (shown) onRemove(); }
          else if (shown) onSet({ type: v });
          else onAdd(v);
        }}>
          <option value="">{t('无')}</option>
          {options.map((k) => <option key={k} value={k}>{t(TRANSITION_LABELS[k])}</option>)}
        </select>
      </label>
      {shown && (
        <>
          <label style={{ fontSize: 11, color: theme.textDim }}>
            <div style={{ marginBottom: 4 }}>{t('时长')} <span style={{ opacity: 0.7 }}>{(shown.durationInFrames / fps).toFixed(1)}s</span></div>
            <input type="range" min={2} max={Math.max(4, fps * 2)} step={1} value={shown.durationInFrames} onChange={(e) => onSet({ durationInFrames: Number(e.target.value) })} style={{ width: '100%' }} />
          </label>
          {needsDir && !audioMode && (
            <label style={{ fontSize: 11, color: theme.textDim, display: 'flex', alignItems: 'center', gap: 8 }}>
              {t('方向')}
              <select value={shown.direction ?? 'left'} style={selStyle} onChange={(e) => onSet({ direction: e.target.value as TransitionItem['direction'] })}>
                <option value="left">{t('左')}</option><option value="right">{t('右')}</option><option value="up">{t('上')}</option><option value="down">{t('下')}</option>
              </select>
            </label>
          )}
        </>
      )}
    </div>
  );
}

// small uppercase-ish divider label between control groups.
function SectionLabel({
  children, onReset, resetDisabled,
}: {
  children: React.ReactNode;
  onReset?: () => void;
  resetDisabled?: boolean;
}) {
  const t = useT();
  return (
    <div className="cc-insp-section">
      <span>{children}</span>
      {onReset && (
        <button
          className="cc-insp-group-reset"
          disabled={resetDisabled}
          title={t('重置整个分组')}
          type="button"
          onClick={onReset}
        >
          {t('重置')}
        </button>
      )}
    </div>
  );
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
              <strong>{t('自动校色')}</strong>
              <span>{t('保守型技术修正')}</span>
            </div>
            <button
              type="button"
              className="cc-insp-btn"
              disabled={autoGrade.busy || autoGrade.targetCount === 0}
              onClick={() => void autoGrade.onAnalyze()}
            >
              {autoGrade.busy ? t('分析中…') : t('分析选中片段')}
            </button>
          </div>
          <div className="cc-auto-grade-note">
            {autoGrade.targetCount === 0
              ? t('请选择已导入媒体池的视频、图片或 GIF 片段')
              : t('本机抽样分析，仅做小幅亮度、对比和饱和度修正，不添加创意 LUT。')}
          </div>
          {autoGrade.previewCount > 0 && (
            <div className="cc-auto-grade-result">
              <div>
                <b>{t('预览中 · {n} 个片段', { n: autoGrade.previewCount })}</b>
                {autoGrade.failedCount > 0 && <span>{t(' · {n} 个失败', { n: autoGrade.failedCount })}</span>}
                {autoGrade.selectedPreview && (
                  <span>
                    {` · ${autoGrade.selectedPreview.bitDepth}-bit${autoGrade.selectedPreview.hdr ? ' HDR' : ' SDR'}`}
                    {` · ${Math.round(autoGrade.selectedPreview.filters.brightness * 100)}% / ${Math.round(autoGrade.selectedPreview.filters.contrast * 100)}% / ${Math.round(autoGrade.selectedPreview.filters.saturate * 100)}%`}
                  </span>
                )}
              </div>
              <div className="cc-insp-actions">
                <button type="button" className="cc-insp-btn primary" onClick={autoGrade.onApply}>{t('应用校色')}</button>
                <button type="button" className="cc-insp-btn" onClick={autoGrade.onCancel}>{t('取消预览')}</button>
              </div>
            </div>
          )}
        </div>
      )}
      <SliderRow label={t('亮度')} val={fl.brightness ?? 1} min={0} max={2} step={0.05} fmt={`${compactNumber((fl.brightness ?? 1) * 100)}%`} inputScale={100}
        onReset={() => onChange({ brightness: 1 })} resetDisabled={Math.abs((fl.brightness ?? 1) - 1) < 1e-6} onChange={(v) => onChange({ brightness: v })} />
      <SliderRow label={t('对比')} val={fl.contrast ?? 1} min={0} max={2} step={0.05} fmt={`${compactNumber((fl.contrast ?? 1) * 100)}%`} inputScale={100}
        onReset={() => onChange({ contrast: 1 })} resetDisabled={Math.abs((fl.contrast ?? 1) - 1) < 1e-6} onChange={(v) => onChange({ contrast: v })} />
      <SliderRow label={t('饱和')} val={fl.saturate ?? 1} min={0} max={2} step={0.05} fmt={`${compactNumber((fl.saturate ?? 1) * 100)}%`} inputScale={100}
        onReset={() => onChange({ saturate: 1 })} resetDisabled={Math.abs((fl.saturate ?? 1) - 1) < 1e-6} onChange={(v) => onChange({ saturate: v })} />
      <SliderRow label={t('模糊')} val={fl.blur ?? 0} min={0} max={30} step={1} fmt={`${compactNumber(fl.blur ?? 0)}px`}
        onReset={() => onChange({ blur: 0 })} resetDisabled={(fl.blur ?? 0) === 0} onChange={(v) => onChange({ blur: v })} />
    </div>
  );
}

const rgbToHex = (rgb: number[]) => `#${rgb.slice(0, 3).map((n) => Math.round(Math.min(1, Math.max(0, n)) * 255).toString(16).padStart(2, '0')).join('')}`;
const hexToRgb = (hex: string) => [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16) / 255);

// Per-clip WebGL effect stack (effects / builtin:fx-*). Order is render
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
        <option value="">{t('＋ 添加特效…')}</option>
        {FX_IDS.map((id) => <option key={id} value={id}>{t(FX_EFFECTS[id].name)}</option>)}
      </select>
      {active.length === 0 && <div style={{ fontSize: 10.5, color: theme.textDim }}>{t('尚未添加特效。')}</div>}
      {active.map((effect, index) => {
        const def = FX_EFFECTS[effect.assetId];
        return (
          <div key={effect.id} style={{ display: 'flex', flexDirection: 'column', gap: 9, border: `0.5px solid ${theme.border}`, borderRadius: 4, padding: 9 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11.5, color: theme.text }}>
              <b style={{ flex: 1 }}>{index + 1}. {t(def.name)}
                {effect.assetId in LUT_EFFECTS && <span style={{ fontSize: 9, fontWeight: 700, color: theme.textDim, border: `0.5px solid ${theme.border}`, borderRadius: 3, padding: '0 3px', marginLeft: 5, verticalAlign: 'middle' }}>LUT</span>}
              </b>
              <button title={t('上移')} disabled={index === 0} onClick={() => moveEffect(index, -1)}>↑</button>
              <button title={t('下移')} disabled={index === active.length - 1} onClick={() => moveEffect(index, 1)}>↓</button>
              <button title={t('移除特效')} onClick={() => onChange(effects.filter((fx) => fx.id !== effect.id))}>×</button>
            </div>
            <div style={{ fontSize: 10.5, color: theme.textDim, opacity: 0.75, lineHeight: 1.4 }}>{t(def.desc)}</div>
            {def.props.map((p) => {
              const raw = effect.overrides?.[p.key] ?? p.default;
              if (p.kind === 'color') {
                const value = Array.isArray(raw) ? raw : p.default;
                return (
                  <label key={p.key} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 11, color: theme.textDim }}>
                    {t(p.label)}
                    <ColorParamInput value={value} onPick={(rgb) => setParam(effect, p.key, rgb)} />
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

// Property editor for the selected timeline item, docked beside the preview.
export function InspectorPanel({ templates, selectedItem, fps, collapsed, onCollapsedChange, onItemPropChange, onItemVolumeChange, onItemFadeChange, onItemTransformChange, onItemFiltersChange, autoGrade, onItemZoomChange, onItemEffectsChange, onItemSpeedChange, onNormalizeLoudness, onIsolateVoice, getPlayhead, onSetReframeKeyframe, onRemoveReframeKeyframe, onSetItemKeyframe, onRemoveItemKeyframe, onResetItemKeyframes, onSeek, transition, onAddTransition, onSetTransition, onRemoveTransition, historyGesture, playerRef }: InspectorPanelProps) {
  const t = useT();
  const schema = selectedItem
    ? templates.find((tpl) => tpl.id === selectedItem.templateId)?.propSchema ?? []
    : [];

  const hint = selectedItem
    ? selectedItem.kind === 'audio'
      ? t('音频片段。可在时间线上拖动位置、裁剪首尾。')
      : selectedItem.kind === 'video'
      ? t('视频片段。可在时间线上拖动位置、裁剪首尾（左裁剪推进源入点）。')
      : selectedItem.kind === 'image'
      ? t('图片片段。')
      : selectedItem.kind === 'gif'
      ? t('GIF 片段。')
      : selectedItem.kind === 'svg'
      ? t('SVG 片段。')
      : selectedItem.kind === 'solid'
      ? t('纯色片段。')
      : selectedItem.kind === 'text'
      ? t('文字片段。')
      : null
    : null;
  // The keyframe bar (disabled state, ◆ filling or not, jump forward and backward) must follow the playhead. getPlayhead() only in
  // It is read once at the moment of rendering, and the movement of the playhead itself will not trigger the re-rendering of this component - so subscribe to frameupdate here,
  // Throttle refresh to ~100ms to ensure real-time without re-rendering every frame.
  const [playhead, setPlayhead] = useState(() => getPlayhead());
  useEffect(() => {
    const player = playerRef.current;
    if (!player) return undefined;
    let last = 0;
    let trailing: ReturnType<typeof setTimeout> | undefined;
    const apply = (frame: number) => {
      last = performance.now();
      setPlayhead((prev) => (prev === frame ? prev : frame));
    };
    apply(player.getCurrentFrame());
    const onFrame = (event: { detail: { frame: number } }) => {
      const { frame } = event.detail;
      const wait = 100 - (performance.now() - last);
      if (wait <= 0) { apply(frame); return; }
      // Trailing updates cannot be saved: once you drag the playhead, there is often only one event. If you lose it, the state will always stop at the old value.
      // (The next one will not come when paused), the keyframe bar will always show the wrong enabled status.
      clearTimeout(trailing);
      trailing = setTimeout(() => apply(frame), wait);
    };
    player.addEventListener('frameupdate', onFrame);
    return () => {
      clearTimeout(trailing);
      player.removeEventListener('frameupdate', onFrame);
    };
  }, [playerRef]);

  // The position of the playhead relative to the clip. Calculate the real difference first and then determine whether it is within the range. The clipped frame number is only used for display.
  const playheadLocal = (() => {
    if (!selectedItem) return { localFrame: 0, inRange: false };
    const raw = Math.round(playhead) - selectedItem.startFrame;
    return {
      localFrame: Math.max(0, Math.min(selectedItem.durationInFrames - 1, raw)),
      inRange: raw >= 0 && raw < selectedItem.durationInFrames,
    };
  })();
  const hasVolume = selectedItem?.kind === 'audio' || selectedItem?.kind === 'video';
  const isVisual = selectedItem != null && selectedItem.kind !== 'audio';
  const transformProps = selectedItem
    ? KEYFRAME_PROPS.filter((prop) => prop !== 'volume' && getKeyframePropertyDefinition(prop).supports(selectedItem))
    : [];
  const transformResetDisabled = !selectedItem || !transformProps.some((prop) => {
    const definition = getKeyframePropertyDefinition(prop);
    return !!selectedItem.keyframes?.[prop]?.length
      || Math.abs(definition.getBaseValue(selectedItem) - definition.defaultValue) >= 1e-6;
  });

  return (
    <HistoryGestureContext.Provider value={historyGesture}>
    <section className={`cc-inspector${collapsed ? ' collapsed' : ''}`}>
      <button
        type="button"
        onClick={() => onCollapsedChange(!collapsed)}
        title={collapsed ? t('展开属性') : t('收起属性')}
        className="cc-insp-header"
      >
        <span className={`cc-insp-chevron${collapsed ? ' closed' : ''}`}><Icon name="chevronDown" size={12} /></span>
        <span className="cc-insp-title">{t('属性')}{selectedItem ? ` · ${selectedItem.name}` : ''}</span>
        {selectedItem?.denoisedSrc && <span className="cc-insp-pill">{t('人声隔离')}</span>}
      </button>
      {!collapsed && (
      <div className="cc-insp-body">
        {!selectedItem ? (
          <div className="cc-insp-muted">{t('选中时间线上的片段以编辑属性。')}</div>
        ) : (
          <div className="cc-insp-groups">
            {hint && <div className="cc-insp-hint">{hint}</div>}
            {selectedItem.kind === 'text' && <><SectionLabel>{t('文字')}</SectionLabel><TextControl item={selectedItem} onPropChange={onItemPropChange} /></>}
            {hasVolume && (
              <>
                <SectionLabel>{t('音量')}</SectionLabel>
                <VolumeControl item={selectedItem} onChange={onItemVolumeChange} onNormalize={onNormalizeLoudness} onReset={onResetItemKeyframes} kf={{
                  ...playheadLocal,
                  set: onSetItemKeyframe,
                  remove: onRemoveItemKeyframe,
                  seekLocal: (frame) => onSeek(selectedItem.startFrame + frame),
                }} />
              </>
            )}
            {(selectedItem.kind === 'video' || selectedItem.kind === 'audio') && onIsolateVoice && (
              <><SectionLabel>{t('人声隔离')}</SectionLabel><IsolateVoiceControl item={selectedItem} onIsolate={onIsolateVoice} /></>
            )}
            {(selectedItem.kind === 'video' || selectedItem.kind === 'audio') && onItemSpeedChange && (
              <><SectionLabel>{t('变速')}</SectionLabel><SpeedControl item={selectedItem} onChange={onItemSpeedChange} /></>
            )}
            {isVisual && <><SectionLabel onReset={() => onResetItemKeyframes(transformProps)} resetDisabled={transformResetDisabled}>{t('变换')}</SectionLabel><TransformControl item={selectedItem} onChange={onItemTransformChange} onReset={onResetItemKeyframes} kf={{
              ...playheadLocal,
              set: onSetItemKeyframe,
              remove: onRemoveItemKeyframe,
              seekLocal: (frame) => onSeek(selectedItem.startFrame + frame),
            }} /></>}
            {isVisual && <><SectionLabel
              onReset={() => onItemFiltersChange({ brightness: 1, contrast: 1, saturate: 1, blur: 0 })}
              resetDisabled={Math.abs((selectedItem.filters?.brightness ?? 1) - 1) < 1e-6
                && Math.abs((selectedItem.filters?.contrast ?? 1) - 1) < 1e-6
                && Math.abs((selectedItem.filters?.saturate ?? 1) - 1) < 1e-6
                && (selectedItem.filters?.blur ?? 0) === 0}
            >{t('滤镜')}</SectionLabel><FilterControl item={selectedItem} onChange={onItemFiltersChange} autoGrade={autoGrade} /></>}
            {/* GIF does not enter the GL pipeline (the rendering side only textures video/image) and does not provide effects entry; historical legacy can be removed by right-clicking on the clip*/}
            {(selectedItem.kind === 'video' || selectedItem.kind === 'image') && <><SectionLabel>{t('特效')}</SectionLabel><EffectsControl item={selectedItem} onChange={onItemEffectsChange} /></>}
            {isVisual && <><SectionLabel
              onReset={() => onItemZoomChange(null)}
              resetDisabled={!selectedItem.zoom}
            >{t('缩放')}</SectionLabel><ZoomControl zoom={selectedItem.zoom} onChange={onItemZoomChange} getLocalFrame={() => Math.max(0, Math.min(selectedItem.durationInFrames - 1, getPlayhead() - selectedItem.startFrame))} fps={fps} onSetKeyframe={onSetReframeKeyframe} onRemoveKeyframe={onRemoveReframeKeyframe} /></>}
            {isVisual && <><SectionLabel>{t('转场')}</SectionLabel><TransitionControl transition={transition} fps={fps} onAdd={onAddTransition} onSet={onSetTransition} onRemove={onRemoveTransition} audioMode={false} /></>}
            {selectedItem.kind === 'audio' && (
              <><SectionLabel>{t('音频转场')}</SectionLabel>
              <TransitionControl transition={transition} fps={fps} onAdd={onAddTransition} onSet={onSetTransition} onRemove={onRemoveTransition} audioMode /></>
            )}
            <SectionLabel
              onReset={() => onItemFadeChange({ fadeInFrames: 0, fadeOutFrames: 0 })}
              resetDisabled={(selectedItem.fadeInFrames ?? 0) === 0 && (selectedItem.fadeOutFrames ?? 0) === 0}
            >{t('淡入淡出')}</SectionLabel>
            <FadeControl item={selectedItem} fps={fps} onChange={onItemFadeChange} />
            {selectedItem.kind === 'solid' && (
              <>
                <SectionLabel>{t('纯色')}</SectionLabel>
                <label className="cc-insp-mg-field">
                  <span>{t('填充颜色')}</span>
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
                <div className="cc-insp-muted">{t('该模板无可编辑属性。')}</div>
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
    </HistoryGestureContext.Provider>
  );
}
