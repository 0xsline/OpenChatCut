import { theme } from '../theme';
import type { PropSpec, Tpl } from '../types';
import type { ClipEffect, ClipEffectValue, ClipFilters, ClipTransform, Keyframe, KeyframeEasing, KeyframeProp, TimelineItem, TransitionItem, TransitionType, ZoomEffect, ZoomShape } from '../editor/types';
import { AUDIO_TRANSITION_ORDER, TRANSITION_LABELS, TRANSITION_ORDER, ZOOM_SHAPE_LABELS, ZOOM_SHAPE_ORDER } from '../editor/types';
import { sampleKeyframes } from '../editor/keyframes';
import { ALL_FX as FX_EFFECTS } from '../gl/fx/effects';
const FX_IDS = Object.keys(FX_EFFECTS);
import { usePersistedState } from '../hooks/usePersistedState';
import { Icon } from './icons';
import { FONT_CATALOG } from '../fonts/googleFonts';

/** MG propSchema field — source types: text/number/color/boolean/font/select/image/asset. */
function PropSchemaField({
  spec, value, onChange,
}: {
  spec: PropSpec;
  value: unknown;
  onChange: (v: unknown) => void;
}) {
  const label = spec.label ?? spec.key;
  const fieldStyle: React.CSSProperties = {
    width: '100%', background: theme.bg, color: theme.text,
    border: `1px solid ${theme.borderLight}`, borderRadius: 5, padding: '4px 6px', fontSize: 12,
  };
  // options come from the source propSchema; select without options falls back
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
              {f.family}{f.aliases[0] ? ` · ${f.aliases[0]}` : ''}{f.loadable ? '' : ' (预览)'}
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
      control = (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <input
            type="text"
            placeholder="图片 URL 或 /media/uploads/…"
            value={String(value ?? '')}
            onChange={(e) => onChange(e.target.value)}
            style={fieldStyle}
          />
          <input
            type="file"
            accept="image/*,.svg,.gif"
            onChange={async (e) => {
              const file = e.target.files?.[0];
              if (!file) return;
              try {
                const { importMedia } = await import('../media/upload');
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
            <img src={value} alt="" style={{ maxWidth: '100%', maxHeight: 72, objectFit: 'contain', borderRadius: 4, background: '#111' }} />
          )}
        </div>
      );
      break;
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

interface InspectorPanelProps {
  templates: Tpl[];
  selectedItem: TimelineItem | null;
  fps: number;
  onItemPropChange: (key: string, value: unknown) => void;
  onItemVolumeChange: (volume: number) => void;
  onItemFadeChange: (fade: FadePatch) => void;
  onItemTransformChange: (patch: ClipTransform) => void;
  onItemFiltersChange: (patch: ClipFilters) => void;
  onItemZoomChange: (patch: Partial<ZoomEffect> | null) => void;
  onItemEffectsChange: (effects: ClipEffect[]) => void;
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
  { value: 'linear', label: '线性' }, { value: 'easeIn', label: '缓入' },
  { value: 'easeOut', label: '缓出' }, { value: 'easeInOut', label: '缓入出' },
];

// end-of-row keyframe rail (PRD §4.5;UI 仿 reframe 关键帧模式,布局自定):
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
  const at = kfs?.find((k) => k.frame === localFrame);
  const prev = kfs ? [...kfs].reverse().find((k) => k.frame < localFrame) : undefined;
  const next = kfs?.find((k) => k.frame > localFrame);
  const btn: React.CSSProperties = { background: 'none', border: 'none', cursor: 'pointer', padding: 0, width: 13, height: 16, display: 'grid', placeItems: 'center', fontSize: 10, color: theme.textDim, lineHeight: 1 };
  const off: React.CSSProperties = { ...btn, opacity: 0.3, cursor: 'default' };
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 1, flexShrink: 0 }}>
      <button type="button" style={prev ? btn : off} disabled={!prev} title="上一关键帧" onClick={() => prev && onSeekLocal(prev.frame)}>‹</button>
      <button
        type="button"
        style={{ ...btn, fontSize: 11, color: at ? theme.accent : kfs?.length ? '#c8c8c8' : theme.textDim }}
        title={at ? '更新播放头处的关键帧' : '在播放头打关键帧'}
        onClick={() => onSet(localFrame, punchValue, at?.easing)}
      >{at ? '◆' : '◇'}</button>
      <button type="button" style={next ? btn : off} disabled={!next} title="下一关键帧" onClick={() => next && onSeekLocal(next.frame)}>›</button>
      <button type="button" style={at ? btn : off} disabled={!at} title="删除播放头处的关键帧" onClick={() => at && onRemove(localFrame)}>×</button>
      {at && (
        <select
          value={Array.isArray(at.easing) ? 'bezier' : at.easing ?? 'linear'}
          title="缓动（此关键帧到下一帧的曲线）"
          onChange={(e) => {
            const v = e.target.value;
            if (v === 'bezier') return; // custom tuples are agent-authored; keep as-is
            onSet(localFrame, at.value, v === 'linear' ? undefined : (v as KeyframeEasing));
          }}
          style={{ background: theme.bg, color: theme.textDim, border: `1px solid ${theme.borderLight}`, borderRadius: 3, fontSize: 9, padding: '0 1px', maxWidth: 50 }}
        >
          {EASING_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          {Array.isArray(at.easing) && <option value="bezier">贝塞尔</option>}
        </select>
      )}
    </span>
  );
}

// scale / position / rotation for visual clips (source 缩放 tab) + per-property
// keyframe rails and an opacity curve row (PRD §4.5). A keyframed prop shows the
// value sampled at the playhead; dragging it then punches a keyframe there.
function TransformControl({ item, onChange, kf }: { item: TimelineItem; onChange: (p: ClipTransform) => void; kf: KfApi }) {
  const t = item.transform ?? {};
  const rows: { prop: KeyframeProp; label: string; min: number; max: number; step: number; base: number; fmt: (v: number) => string; patch: (v: number) => ClipTransform }[] = [
    { prop: 'scale', label: '缩放', min: 0.1, max: 3, step: 0.05, base: t.scale ?? 1, fmt: (v) => `${Math.round(v * 100)}%`, patch: (v) => ({ scale: v }) },
    { prop: 'x', label: '水平', min: -100, max: 100, step: 1, base: t.x ?? 0, fmt: (v) => `${Math.round(v)}%`, patch: (v) => ({ x: v }) },
    { prop: 'y', label: '垂直', min: -100, max: 100, step: 1, base: t.y ?? 0, fmt: (v) => `${Math.round(v)}%`, patch: (v) => ({ y: v }) },
    { prop: 'rotation', label: '旋转', min: -180, max: 180, step: 1, base: t.rotation ?? 0, fmt: (v) => `${Math.round(v)}°`, patch: (v) => ({ rotation: v }) },
  ];
  // 透明度自身即关键帧曲线(无静态透明度字段;无关键帧时恒 1)——源站无据,自定
  const opacityKfs = item.keyframes?.opacity;
  const opacityVal = opacityKfs?.length ? sampleKeyframes(opacityKfs, kf.localFrame) : 1;
  return (
    <div className="cc-insp-stack">
      {rows.map((r) => {
        const kfs = item.keyframes?.[r.prop];
        const val = kfs?.length ? sampleKeyframes(kfs, kf.localFrame) : r.base;
        return (
          <div key={r.prop} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <SliderRow label={r.label} val={val} min={r.min} max={r.max} step={r.step} fmt={r.fmt(val)}
                onChange={(v) => (kfs?.length ? kf.set(r.prop, kf.localFrame, v) : onChange(r.patch(v)))} />
            </div>
            <KfCell kfs={kfs} localFrame={kf.localFrame} punchValue={val}
              onSet={(frame, value, easing) => kf.set(r.prop, frame, value, easing)}
              onRemove={(frame) => kf.remove(r.prop, frame)} onSeekLocal={kf.seekLocal} />
          </div>
        );
      })}
      <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <SliderRow label="透明" val={opacityVal} min={0} max={1} step={0.01} fmt={`${Math.round(opacityVal * 100)}%`}
            onChange={(v) => kf.set('opacity', kf.localFrame, v)} />
        </div>
        <KfCell kfs={opacityKfs} localFrame={kf.localFrame} punchValue={opacityVal}
          onSet={(frame, value, easing) => kf.set('opacity', frame, value, easing)}
          onRemove={(frame) => kf.remove('opacity', frame)} onSeekLocal={kf.seekLocal} />
      </div>
    </div>
  );
}

// audio + video clips carry a playback volume; image/MG do not.
function VolumeControl({ item, onChange }: { item: TimelineItem; onChange: (v: number) => void }) {
  const vol = item.volume ?? 1;
  return (
    <SliderRow label="音量" val={vol} min={0} max={2} step={0.05} fmt={`${Math.round(vol * 100)}%`} onChange={onChange} />
  );
}

// fade in/out (seconds) — opacity ramp for visual clips, volume ramp for audio.
function FadeControl({ item, fps, onChange }: { item: TimelineItem; fps: number; onChange: (f: FadePatch) => void }) {
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
      {row('淡入', item.fadeInFrames, 'fadeInFrames')}
      {row('淡出', item.fadeOutFrames, 'fadeOutFrames')}
    </div>
  );
}

// text clip content controls (text/fontSize/color/weight/align) — props-backed.
function TextControl({ item, onPropChange }: { item: TimelineItem; onPropChange: (key: string, value: unknown) => void }) {
  const p = item.props ?? {};
  const selStyle: React.CSSProperties = { background: theme.bg, color: theme.text, border: `1px solid ${theme.borderLight}`, borderRadius: 4, padding: '3px 5px' };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <label style={{ fontSize: 11, color: theme.textDim }}>
        <div style={{ marginBottom: 4 }}>文字内容</div>
        <textarea value={String(p.text ?? '')} onChange={(e) => onPropChange('text', e.target.value)} rows={2}
          style={{ width: '100%', padding: '6px 8px', background: theme.bg, color: theme.text, border: `1px solid ${theme.borderLight}`, borderRadius: 5, resize: 'vertical', fontFamily: 'inherit', fontSize: 12 }} />
      </label>
      <label style={{ fontSize: 11, color: theme.textDim }}>
        <div style={{ marginBottom: 4 }}>字号 <span style={{ opacity: 0.7 }}>{Number(p.fontSize ?? 96)}</span></div>
        <input type="range" min={24} max={300} step={2} value={Number(p.fontSize ?? 96)} onChange={(e) => onPropChange('fontSize', Number(e.target.value))} style={{ width: '100%' }} />
      </label>
      <div style={{ display: 'flex', gap: 14, alignItems: 'center', flexWrap: 'wrap' }}>
        <label style={{ fontSize: 11, color: theme.textDim, display: 'flex', alignItems: 'center', gap: 6 }}>
          颜色 <input type="color" value={String(p.color ?? '#ffffff')} onChange={(e) => onPropChange('color', e.target.value)} />
        </label>
        <label style={{ fontSize: 11, color: theme.textDim, display: 'flex', alignItems: 'center', gap: 6 }}>
          对齐
          <select value={String(p.align ?? 'center')} onChange={(e) => onPropChange('align', e.target.value)} style={selStyle}>
            <option value="left">左</option><option value="center">中</option><option value="right">右</option>
          </select>
        </label>
        <label style={{ fontSize: 11, color: theme.textDim, display: 'flex', alignItems: 'center', gap: 6 }}>
          粗细
          <select value={String(p.fontWeight ?? 700)} onChange={(e) => onPropChange('fontWeight', Number(e.target.value))} style={selStyle}>
            <option value="400">常规</option><option value="700">粗体</option><option value="900">特粗</option>
          </select>
        </label>
      </div>
    </div>
  );
}


// animated zoom (source builtin:zoom): shape curve + magnification + focal point,
// plus ReframeCurveV1 sparse keyframes (drop focal+mag at the playhead).
function ZoomControl({ zoom, onChange, getLocalFrame, fps, onSetKeyframe, onRemoveKeyframe }: {
  zoom: ZoomEffect | undefined;
  onChange: (patch: Partial<ZoomEffect> | null) => void;
  getLocalFrame: () => number;
  fps: number;
  onSetKeyframe: (frame: number, fx: number, fy: number, mag: number) => void;
  onRemoveKeyframe: (frame: number) => void;
}) {
  const localFrame = getLocalFrame();
  return (
    <div className="cc-insp-stack">
      <label className="cc-insp-row">
        <span className="cc-insp-label">曲线</span>
        <select className="cc-insp-select" value={zoom?.shape ?? ''} onChange={(e) => {
          const v = e.target.value as ZoomShape | '';
          if (!v) onChange(null);
          else onChange({ shape: v });
        }}>
          <option value="">无</option>
          {ZOOM_SHAPE_ORDER.map((k) => <option key={k} value={k}>{ZOOM_SHAPE_LABELS[k]}</option>)}
        </select>
      </label>
      {zoom && (
        <>
          <SliderRow label="倍数" val={zoom.magnification ?? 1.5} min={1} max={4} step={0.05} fmt={`${(zoom.magnification ?? 1.5).toFixed(2)}×`} onChange={(v) => onChange({ magnification: v })} />
          <SliderRow label="焦点X" val={zoom.focalPointX ?? 0.5} min={0} max={1} step={0.01} fmt={`${Math.round((zoom.focalPointX ?? 0.5) * 100)}%`} onChange={(v) => onChange({ focalPointX: v })} />
          <SliderRow label="焦点Y" val={zoom.focalPointY ?? 0.5} min={0} max={1} step={0.01} fmt={`${Math.round((zoom.focalPointY ?? 0.5) * 100)}%`} onChange={(v) => onChange({ focalPointY: v })} />
          <div className="cc-insp-actions">
            <button
              type="button"
              onClick={() => onSetKeyframe(getLocalFrame(), zoom.focalPointX ?? 0.5, zoom.focalPointY ?? 0.5, zoom.magnification ?? 1.5)}
              title="在播放头记录焦点+倍数为关键帧"
              className="cc-insp-btn"
            >
              <Icon name="diamond" size={12} />关键帧
            </button>
            <span className="cc-insp-muted">@ {(localFrame / fps).toFixed(2)}s</span>
          </div>
          {(zoom.reframeCurve?.keyframes.length ?? 0) > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <div style={{ fontSize: 10.5, color: theme.textDim, opacity: 0.8 }}>关键帧（覆盖曲线，逐帧插值）</div>
              {zoom.reframeCurve!.keyframes.map((k) => (
                <div key={k.frame} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11, color: theme.textDim }}>
                  <span style={{ fontVariantNumeric: 'tabular-nums', display: 'inline-flex', alignItems: 'center', gap: 4 }}><Icon name="diamond" size={11} />{(k.frame / fps).toFixed(2)}s</span>
                  <span style={{ opacity: 0.8 }}>{k.magnification.toFixed(2)}× · ({Math.round(k.focalPointX * 100)},{Math.round(k.focalPointY * 100)})</span>
                  <button onClick={() => onRemoveKeyframe(k.frame)} title="删除关键帧" style={{ background: 'none', border: 'none', color: theme.textDim, cursor: 'pointer', fontSize: 12, marginLeft: 'auto', display: 'inline-flex', alignItems: 'center' }}><Icon name="x" size={12} /></button>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}


// transition INTO the selected clip from the previous adjacent same-track clip
// (source transition_item). Picking a type creates it; 无 removes it.
function TransitionControl({ transition, fps, onAdd, onSet, onRemove, audioMode }: {
  transition: TransitionItem | null;
  fps: number;
  onAdd: (type: TransitionType) => void;
  onSet: (patch: Partial<TransitionItem>) => void;
  onRemove: () => void;
  /** true = only audio-cross-fade (source trAudioCrossFade) */
  audioMode?: boolean;
}) {
  const selStyle: React.CSSProperties = { background: theme.bg, color: theme.text, border: `1px solid ${theme.borderLight}`, borderRadius: 4, padding: '3px 5px' };
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
          ? '与前一段相邻音频交叉淡化（出点渐弱 / 入点渐强）'
          : '从前一个相邻片段进入本片段'}
      </div>
      <label style={{ fontSize: 11, color: theme.textDim, display: 'flex', alignItems: 'center', gap: 8 }}>
        类型
        <select value={shown?.type ?? ''} style={selStyle} onChange={(e) => {
          const v = e.target.value as TransitionType | '';
          if (!v) { if (shown) onRemove(); }
          else if (shown) onSet({ type: v });
          else onAdd(v);
        }}>
          <option value="">无</option>
          {options.map((k) => <option key={k} value={k}>{TRANSITION_LABELS[k]}</option>)}
        </select>
      </label>
      {shown && (
        <>
          <label style={{ fontSize: 11, color: theme.textDim }}>
            <div style={{ marginBottom: 4 }}>时长 <span style={{ opacity: 0.7 }}>{(shown.durationInFrames / fps).toFixed(1)}s</span></div>
            <input type="range" min={2} max={Math.max(4, fps * 2)} step={1} value={shown.durationInFrames} onChange={(e) => onSet({ durationInFrames: Number(e.target.value) })} style={{ width: '100%' }} />
          </label>
          {needsDir && !audioMode && (
            <label style={{ fontSize: 11, color: theme.textDim, display: 'flex', alignItems: 'center', gap: 8 }}>
              方向
              <select value={shown.direction ?? 'left'} style={selStyle} onChange={(e) => onSet({ direction: e.target.value as TransitionItem['direction'] })}>
                <option value="left">左</option><option value="right">右</option><option value="up">上</option><option value="down">下</option>
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

// brightness / contrast / saturation / blur (CSS filter) — source 特效/LUT.
function FilterControl({ item, onChange }: { item: TimelineItem; onChange: (p: ClipFilters) => void }) {
  const fl = item.filters ?? {};
  return (
    <div className="cc-insp-stack">
      <SliderRow label="亮度" val={fl.brightness ?? 1} min={0} max={2} step={0.05} fmt={`${Math.round((fl.brightness ?? 1) * 100)}%`} onChange={(v) => onChange({ brightness: v })} />
      <SliderRow label="对比" val={fl.contrast ?? 1} min={0} max={2} step={0.05} fmt={`${Math.round((fl.contrast ?? 1) * 100)}%`} onChange={(v) => onChange({ contrast: v })} />
      <SliderRow label="饱和" val={fl.saturate ?? 1} min={0} max={2} step={0.05} fmt={`${Math.round((fl.saturate ?? 1) * 100)}%`} onChange={(v) => onChange({ saturate: v })} />
      <SliderRow label="模糊" val={fl.blur ?? 0} min={0} max={30} step={1} fmt={`${Math.round(fl.blur ?? 0)}px`} onChange={(v) => onChange({ blur: v })} />
    </div>
  );
}

const rgbToHex = (rgb: number[]) => `#${rgb.slice(0, 3).map((n) => Math.round(Math.min(1, Math.max(0, n)) * 255).toString(16).padStart(2, '0')).join('')}`;
const hexToRgb = (hex: string) => [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16) / 255);

// Per-clip WebGL effect stack (source 特效 / builtin:fx-*). Order is render
// order: each card consumes the previous card's output.
function EffectsControl({ item, onChange }: { item: TimelineItem; onChange: (effects: ClipEffect[]) => void }) {
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
        style={{ width: '100%', background: theme.panelAlt, color: theme.text, border: `1px solid ${theme.border}`, borderRadius: 6, padding: '5px 7px', fontSize: 12 }}>
        <option value="">＋ 添加特效…</option>
        {FX_IDS.map((id) => <option key={id} value={id}>{FX_EFFECTS[id].name}</option>)}
      </select>
      {active.length === 0 && <div style={{ fontSize: 10.5, color: theme.textDim }}>尚未添加特效。</div>}
      {active.map((effect, index) => {
        const def = FX_EFFECTS[effect.assetId];
        return (
          <div key={effect.id} style={{ display: 'flex', flexDirection: 'column', gap: 9, border: `1px solid ${theme.border}`, borderRadius: 7, padding: 9 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11.5, color: theme.text }}>
              <b style={{ flex: 1 }}>{index + 1}. {def.name}</b>
              <button title="上移" disabled={index === 0} onClick={() => moveEffect(index, -1)}>↑</button>
              <button title="下移" disabled={index === active.length - 1} onClick={() => moveEffect(index, 1)}>↓</button>
              <button title="移除特效" onClick={() => onChange(effects.filter((fx) => fx.id !== effect.id))}>×</button>
            </div>
            <div style={{ fontSize: 10.5, color: theme.textDim, opacity: 0.75, lineHeight: 1.4 }}>{def.desc}</div>
            {def.props.map((p) => {
              const raw = effect.overrides?.[p.key] ?? p.default;
              if (p.kind === 'color') {
                const value = Array.isArray(raw) ? raw : p.default;
                return (
                  <label key={p.key} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 11, color: theme.textDim }}>
                    {p.label}
                    <input type="color" value={rgbToHex(value)} onInput={(e) => setParam(effect, p.key, hexToRgb(e.currentTarget.value))} />
                  </label>
                );
              }
              const value = typeof raw === 'number' ? raw : p.default;
              return (
                <label key={p.key} style={{ display: 'block', fontSize: 11, color: theme.textDim }}>
                  <div style={{ marginBottom: 4 }}>{p.label} <span style={{ opacity: 0.7 }}>{fmt(p.step, value)}</span></div>
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
export function InspectorPanel({ templates, selectedItem, fps, onItemPropChange, onItemVolumeChange, onItemFadeChange, onItemTransformChange, onItemFiltersChange, onItemZoomChange, onItemEffectsChange, getPlayhead, onSetReframeKeyframe, onRemoveReframeKeyframe, onSetItemKeyframe, onRemoveItemKeyframe, onSeek, transition, onAddTransition, onSetTransition, onRemoveTransition }: InspectorPanelProps) {
  const [collapsed, setCollapsed] = usePersistedState('cc.inspectorCollapsed', false);
  const schema = selectedItem
    ? templates.find((t) => t.id === selectedItem.templateId)?.propSchema ?? []
    : [];

  const hint = selectedItem
    ? selectedItem.kind === 'audio'
      ? '音频片段。可在时间线上拖动位置、裁剪首尾。'
      : selectedItem.kind === 'video'
      ? '视频片段。可在时间线上拖动位置、裁剪首尾（左裁剪推进源入点）。'
      : selectedItem.kind === 'image'
      ? '图片片段。'
      : selectedItem.kind === 'gif'
      ? 'GIF 片段。'
      : selectedItem.kind === 'svg'
      ? 'SVG 片段。'
      : selectedItem.kind === 'solid'
      ? '纯色片段。'
      : selectedItem.kind === 'text'
      ? '文字片段。'
      : null
    : null;
  const hasVolume = selectedItem?.kind === 'audio' || selectedItem?.kind === 'video';
  const isVisual = selectedItem != null && selectedItem.kind !== 'audio';

  return (
    <section className={`cc-inspector${collapsed ? ' collapsed' : ''}`}>
      <button
        type="button"
        onClick={() => setCollapsed((v) => !v)}
        title={collapsed ? '展开属性' : '收起属性'}
        className="cc-insp-header"
      >
        <span className={`cc-insp-chevron${collapsed ? ' closed' : ''}`}><Icon name="chevronDown" size={12} /></span>
        <span className="cc-insp-title">属性{selectedItem ? ` · ${selectedItem.name}` : ''}</span>
        {selectedItem?.denoisedSrc && <span className="cc-insp-pill">人声隔离</span>}
      </button>
      {!collapsed && (
      <div className="cc-insp-body">
        {!selectedItem ? (
          <div className="cc-insp-muted">选中时间线上的片段以编辑属性。</div>
        ) : (
          <div className="cc-insp-groups">
            {hint && <div className="cc-insp-hint">{hint}</div>}
            {selectedItem.kind === 'text' && <><SectionLabel>文字</SectionLabel><TextControl item={selectedItem} onPropChange={onItemPropChange} /></>}
            {hasVolume && <><SectionLabel>音量</SectionLabel><VolumeControl item={selectedItem} onChange={onItemVolumeChange} /></>}
            {isVisual && <><SectionLabel>变换</SectionLabel><TransformControl item={selectedItem} onChange={onItemTransformChange} kf={{
              localFrame: Math.max(0, Math.min(selectedItem.durationInFrames - 1, Math.round(getPlayhead()) - selectedItem.startFrame)),
              set: onSetItemKeyframe,
              remove: onRemoveItemKeyframe,
              seekLocal: (frame) => onSeek(selectedItem.startFrame + frame),
            }} /></>}
            {isVisual && <><SectionLabel>滤镜</SectionLabel><FilterControl item={selectedItem} onChange={onItemFiltersChange} /></>}
            {(selectedItem.kind === 'video' || selectedItem.kind === 'image' || selectedItem.kind === 'gif') && <><SectionLabel>特效</SectionLabel><EffectsControl item={selectedItem} onChange={onItemEffectsChange} /></>}
            {isVisual && <><SectionLabel>缩放</SectionLabel><ZoomControl zoom={selectedItem.zoom} onChange={onItemZoomChange} getLocalFrame={() => Math.max(0, Math.min(selectedItem.durationInFrames - 1, getPlayhead() - selectedItem.startFrame))} fps={fps} onSetKeyframe={onSetReframeKeyframe} onRemoveKeyframe={onRemoveReframeKeyframe} /></>}
            {isVisual && <><SectionLabel>转场</SectionLabel><TransitionControl transition={transition} fps={fps} onAdd={onAddTransition} onSet={onSetTransition} onRemove={onRemoveTransition} audioMode={false} /></>}
            {selectedItem.kind === 'audio' && (
              <><SectionLabel>音频转场</SectionLabel>
              <TransitionControl transition={transition} fps={fps} onAdd={onAddTransition} onSet={onSetTransition} onRemove={onRemoveTransition} audioMode /></>
            )}
            <SectionLabel>淡入淡出</SectionLabel>
            <FadeControl item={selectedItem} fps={fps} onChange={onItemFadeChange} />
            {selectedItem.kind === 'solid' && (
              <>
                <SectionLabel>纯色</SectionLabel>
                <label className="cc-insp-mg-field">
                  <span>填充颜色</span>
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
                <div className="cc-insp-muted">该模板无可编辑属性。</div>
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
