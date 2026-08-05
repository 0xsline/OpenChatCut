import { useState, type CSSProperties, type PropsWithChildren } from 'react';
import type { ClipTransform, Keyframe, KeyframeEasing, KeyframeProp, TimelineItem } from '../../editor/types';
import { sampleKeyframes } from '../../editor/keyframes';
import { KEYFRAME_PROPS, getKeyframePropertyDefinition } from '../../editor/keyframeRegistry';
import { useT } from '../../i18n/locale';
import { Icon } from '../icons';
import { ScalarControl } from './ScalarControl';
import { snapScalar } from './scalarMath';

import { HistoryGestureContext, useHistoryGesture } from './historyGesture';

const rgbToHex = (rgb: number[]) => `#${rgb.slice(0, 3).map((n) => Math.round(Math.min(1, Math.max(0, n)) * 255).toString(16).padStart(2, '0')).join('')}`;
const hexToRgb = (hex: string) => [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16) / 255);

export function HistoryGestureProvider({ value, children }: PropsWithChildren<{ value: { begin: () => void; end: () => void } }>) {
  return <HistoryGestureContext.Provider value={value}>{children}</HistoryGestureContext.Provider>;
}

/** Color Picker: OnInput is triggered once when the mouse is moved in the color picker panel. Like the slider, it must be merged into an undo record.*/
export function ColorParamInput({ value, onPick }: { value: number[]; onPick: (rgb: number[]) => void }) {
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

interface SliderRowProps {
  label: string; val: number; min: number; max: number; step: number; fmt: string; onChange: (value: number) => void;
  inputScale?: number;
  mixed?: boolean;
  onReset?: () => void;
  resetDisabled?: boolean;
  disabled?: boolean;
  disabledReason?: string;
}

/** Compact one-line slider: label | track | value */
export function SliderRow({
  label, val, min, max, step, fmt, inputScale, mixed = false, onChange, onReset, resetDisabled, disabled, disabledReason,
}: SliderRowProps) {
  const t = useT();
  const gesture = useHistoryGesture();
  const progress = Math.min(100, Math.max(0, ((val - min) / (max - min)) * 100));
  return (
    <div className="cc-insp-row" title={disabled ? disabledReason : undefined} style={disabled ? { opacity: 0.45 } : undefined}>
      <span className="cc-insp-label">{label}</span>
      <input
        aria-label={label}
        className="cc-insp-range"
        style={{ '--cc-insp-range-fill': `${progress}%` } as CSSProperties}
        type="range" min={min} max={max} step="any" value={val}
        disabled={disabled || mixed}
        onChange={(e) => onChange(snapScalar(Number(e.target.value), min, max, step))}
        {...gesture}
      />
      <span className="cc-insp-val">
        <ScalarControl
          ariaLabel={t('输入{name}的精确值', { name: label })}
          disabled={disabled}
          formatValue={fmt}
          inputScale={inputScale}
          mixed={mixed}
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
  const previousTitle = prev ? t('上一关键帧') : t('没有更早的关键帧');
  const nextTitle = next ? t('下一关键帧') : t('没有更晚的关键帧');
  return (
    <span className="cc-insp-kf">
      <button className="cc-insp-kf-btn" type="button" disabled={!prev} title={previousTitle} aria-label={previousTitle} onClick={() => prev && onSeekLocal(prev.frame)}>
        <Icon name="prev" size={10} />
      </button>
      <button
        className={`cc-insp-kf-btn key${at ? ' active' : kfs?.length ? ' keyed' : ''}`}
        type="button"
        disabled={!inRange}
        title={!inRange ? outside : at ? t('更新播放头处的关键帧') : t('在播放头打关键帧')}
        aria-label={!inRange ? outside : at ? t('更新播放头处的关键帧') : t('在播放头打关键帧')}
        onClick={() => inRange && onSet(localFrame, punchValue, at?.easing)}
      >
        <Icon name="diamond" size={9} filled={!!at} />
      </button>
      <button className="cc-insp-kf-btn" type="button" disabled={!next} title={nextTitle} aria-label={nextTitle} onClick={() => next && onSeekLocal(next.frame)}>
        <Icon name="next" size={10} />
      </button>
      <button className="cc-insp-kf-btn danger" type="button" disabled={!at} title={t('删除播放头处的关键帧')} aria-label={t('删除播放头处的关键帧')} onClick={() => at && onRemove(localFrame)}>
        <Icon name="trash" size={10} />
      </button>
      {at && (
        <select
          className="cc-insp-kf-easing"
          value={Array.isArray(at.easing) ? 'bezier' : at.easing ?? 'linear'}
          title={t('缓动（此关键帧到下一帧的曲线）')}
          onChange={(e) => {
            const v = e.target.value;
            if (v === 'bezier') return;
            onSet(localFrame, at.value, v === 'linear' ? undefined : (v as KeyframeEasing));
          }}
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
export function TransformControl({
  item, mixed, onChange, onReset, kf,
}: {
  item: TimelineItem;
  mixed?: (prop: KeyframeProp) => boolean;
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
          <div key={r.id} className="cc-insp-control-line">
            <div style={{ flex: 1, minWidth: 0 }}>
              <SliderRow label={t(r.label)} val={value} min={min} max={max} step={r.step} fmt={r.format(value)}
                inputScale={r.id === 'scale' || r.id === 'opacity' ? 100 : 1}
                mixed={mixed?.(r.id)}
                disabled={!!kfs?.length && !kf.inRange}
                disabledReason={t('把播放头移进这个片段才能改这里的关键帧')}
                onReset={() => onReset([r.id])}
                resetDisabled={!mixed?.(r.id) && !kfs?.length && Math.abs(r.getBaseValue(item) - r.defaultValue) < 1e-6}
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

interface VolumeControlProps {
  item: TimelineItem;
  mixed?: boolean;
  onChange: (value: number) => void;
  onNormalize?: () => void | Promise<void>;
  onReset: (props: readonly KeyframeProp[]) => void;
  kf: KfApi;
}

// audio + video clips carry a playback volume; image/MG do not. With volume
// keyframes present the slider shows the playhead-sampled value and edits punch
// a keyframe there (same override rule as TransformControl rows).
export function VolumeControl({
  item, mixed, onChange, onNormalize, onReset, kf,
}: VolumeControlProps) {
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
            mixed={mixed}
            disabled={!!kfs?.length && !kf.inRange}
            disabledReason={t('把播放头移进这个片段才能改这里的关键帧')}
            onReset={() => onReset(['volume'])}
            resetDisabled={!mixed && !kfs?.length && Math.abs((item.volume ?? 1) - 1) < 1e-6}
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
