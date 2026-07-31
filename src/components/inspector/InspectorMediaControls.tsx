import { useState, type CSSProperties } from 'react';
import { theme } from '../../theme';
import type { TimelineItem, TransitionItem, TransitionType, ZoomEffect, ZoomShape } from '../../editor/types';
import { AUDIO_TRANSITION_ORDER, TRANSITION_LABELS, TRANSITION_ORDER, ZOOM_SHAPE_LABELS, ZOOM_SHAPE_ORDER } from '../../editor/types';
import { useT } from '../../i18n/locale';
import { showAppToast } from '../../ui/appToast';
import { Icon } from '../icons';
import { SliderRow } from './InspectorKeyframeControls';
import type { FadePatch } from './InspectorTypes';

const compactNumber = (value: number) => String(Number(value.toFixed(2)));

const SPEED_PRESETS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 4] as const;

export function IsolateVoiceControl({
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

export function SpeedControl({ item, onChange }: { item: TimelineItem; onChange: (rate: number) => void }) {
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
export function FadeControl({ item, fps, onChange }: { item: TimelineItem; fps: number; onChange: (f: FadePatch) => void }) {
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
export function TextControl({ item, onPropChange }: { item: TimelineItem; onPropChange: (key: string, value: unknown) => void }) {
  const t = useT();
  const p = item.props ?? {};
  const selStyle: CSSProperties = { background: theme.bg, color: theme.text, border: `0.5px solid ${theme.borderLight}`, borderRadius: 4, padding: '3px 5px' };
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
export function ZoomControl({ zoom, onChange, getLocalFrame, fps, onSetKeyframe, onRemoveKeyframe }: {
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
export function TransitionControl({ transition, fps, onAdd, onSet, onRemove, audioMode }: {
  transition: TransitionItem | null;
  fps: number;
  onAdd: (type: TransitionType) => void;
  onSet: (patch: Partial<TransitionItem>) => void;
  onRemove: () => void;
  /** true = only audio-cross-fade (trAudioCrossFade) */
  audioMode?: boolean;
}) {
  const t = useT();
  const selStyle: CSSProperties = { background: theme.bg, color: theme.text, border: `0.5px solid ${theme.borderLight}`, borderRadius: 4, padding: '3px 5px' };
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

