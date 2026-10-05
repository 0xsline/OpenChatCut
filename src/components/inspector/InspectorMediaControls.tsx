import { useState, type CSSProperties } from 'react';
import { theme } from '../../theme';
import { FONT_CATALOG } from '../../fonts/googleFonts';
import { FontFamilyPicker } from './FontFamilyPicker';
import type { TimelineItem, TransitionItem, TransitionType, ZoomEffect, ZoomShape } from '../../editor/types';
import { AUDIO_TRANSITION_ORDER, TRANSITION_LABELS, TRANSITION_ORDER, ZOOM_SHAPE_LABELS, ZOOM_SHAPE_ORDER } from '../../editor/types';
import type { SelectedPreviewStatus } from '../../gl/previewAdapter';
import { useT } from '../../i18n/locale';
import { showAppToast } from '../../ui/appToast';
import { Icon } from '../icons';
import { SliderRow } from './InspectorKeyframeControls';
import type { FadePatch } from './InspectorTypes';
import { PreviewFidelityStatus } from './PreviewFidelityStatus';

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
    if (action === 'apply') showAppToast('Isolating voice...', { ms: 60_000 });
    void Promise.resolve(onIsolate(action, nextStrength))
      .then(() => {
        if (action === 'clear') showAppToast('Voice isolation cleared');
        else showAppToast('Voice isolation applied');
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
        label="Isolation Strength"
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
          title={!canApply ? 'Requires upload to media pool first' : 'Denoise using local ffmpeg, preserving original audio track'}
          style={{ flex: 1, fontSize: 11 }}
          onClick={() => run('apply', strength)}
        >
          {busy ? 'Processing...' : active ? 'Re-isolate' : 'Apply Voice Isolation'}
        </button>
        {active && (
          <button
            type="button"
            className="cc-insp-btn"
            disabled={busy}
            style={{ fontSize: 11 }}
            onClick={() => run('clear')}
          >
            Clear
          </button>
        )}
      </div>
      <div className="cc-insp-muted" style={{ fontSize: 10, marginTop: 4 }}>
        {active
          ? 'Applied · Playing isolated audio track · Master unchanged'
          : 'Built-in ffmpeg spectral denoise'}
      </div>
      {err && (
        <div style={{ fontSize: 10, color: 'var(--cc-danger, #f66)', marginTop: 4 }}>{err}</div>
      )}
    </div>
  );
}

export function SpeedControl({ item, mixed, onChange }: { item: TimelineItem; mixed?: boolean; onChange: (rate: number) => void }) {
  const rate = item.playbackRate ?? 1;
  return (
    <div>
      <SliderRow
        label="Playback Speed"
        val={rate}
        mixed={mixed}
        min={0.25}
        max={4}
        step={0.05}
        fmt={`${rate.toFixed(2)}×`}
        onReset={() => onChange(1)}
        resetDisabled={!mixed && Math.abs(rate - 1) < 1e-6}
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
        Pitch-preserved speed adjustment (Preview & Export)
      </div>
    </div>
  );
}

// fade in/out (seconds) — opacity ramp for visual clips, volume ramp for audio.
export function FadeControl({ item, mixed, fps, onChange }: { item: TimelineItem; mixed?: Partial<Record<keyof FadePatch, boolean>>; fps: number; onChange: (f: FadePatch) => void }) {
  const maxSec = Math.max(0.1, item.durationInFrames / fps);
  const row = (label: string, frames: number | undefined, key: keyof FadePatch) => {
    const sec = (frames ?? 0) / fps;
    return (
      <SliderRow
        key={key}
        label={label}
        val={sec}
        mixed={mixed?.[key]}
        min={0}
        max={maxSec}
        step={0.1}
        fmt={`${sec.toFixed(1)}s`}
        onReset={() => onChange({ [key]: 0 })}
        resetDisabled={!mixed?.[key] && sec === 0}
        onChange={(v) => onChange({ [key]: Math.round(v * fps) })}
      />
    );
  };
  return (
    <div className="cc-insp-stack">
      {row('Fade In', item.fadeInFrames, 'fadeInFrames')}
      {row('Fade Out', item.fadeOutFrames, 'fadeOutFrames')}
    </div>
  );
}

// text clip content controls (text/fontFamily/fontSize/color/weight/align/spacing/backdrops) — props-backed.
export function TextControl({ item, mixed, onPropChange }: { item: TimelineItem; mixed?: (key: string) => boolean; onPropChange: (key: string, value: unknown) => void }) {
  const p = item.props ?? {};
  const isSub = item.track === 'V6' || (item.name && item.name.startsWith('Sub '));
  const isBadge = item.name && item.name.startsWith('Label ');
  const selStyle: CSSProperties = { background: theme.bg, color: theme.text, border: `0.5px solid ${theme.borderLight}`, borderRadius: 4, padding: '3px 5px' };

  const bgActive = Boolean(p.bgEnabled !== undefined ? p.bgEnabled : (isSub || isBadge));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {/* 1. Content */}
      <label style={{ fontSize: 11, color: theme.textDim }}>
        <div style={{ marginBottom: 4 }}>Text Content</div>
        <textarea value={mixed?.('text') ? '' : String(p.text ?? '')} placeholder={mixed?.('text') ? '—' : undefined} onChange={(e) => onPropChange('text', e.target.value)} rows={2}
          style={{ width: '100%', padding: '6px 8px', background: theme.bg, color: theme.text, border: `0.5px solid ${theme.borderLight}`, borderRadius: 5, resize: 'vertical', fontFamily: 'inherit', fontSize: 12 }} />
      </label>

      {/* 2. Font Family */}
      <label style={{ fontSize: 11, color: theme.textDim, display: 'flex', flexDirection: 'column', gap: 4 }}>
        <div style={{ marginBottom: 2 }}>Font Family {mixed?.('fontFamily') && <span>—</span>}</div>
        <FontFamilyPicker
          value={String(p.fontFamily ?? '')}
          mixed={mixed?.('fontFamily')}
          onChange={(fam) => onPropChange('fontFamily', fam)}
        />
      </label>

      {/* 3. Font Size */}
      <label style={{ fontSize: 11, color: theme.textDim }}>
        <div style={{ marginBottom: 4 }}>Font Size <span style={{ opacity: 0.7 }}>{mixed?.('fontSize') ? '—' : Number(p.fontSize ?? (isSub ? 30 : isBadge ? 26 : 96))}</span></div>
        {mixed?.('fontSize') ? <input type="number" min={16} max={300} step={2} placeholder="—" onBlur={(e) => {
          const value = Number(e.currentTarget.value);
          if (e.currentTarget.value && Number.isFinite(value)) onPropChange('fontSize', value);
        }} style={{ width: '100%', ...selStyle }} /> : <input type="range" min={16} max={300} step={2} value={Number(p.fontSize ?? (isSub ? 30 : isBadge ? 26 : 96))} onChange={(e) => onPropChange('fontSize', Number(e.target.value))} style={{ width: '100%' }} />}
      </label>

      {/* 4. Font Color, Align, Weight, Style */}
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        <label style={{ fontSize: 11, color: theme.textDim, display: 'flex', alignItems: 'center', gap: 6 }}>
          Color {mixed?.('color') && <span>—</span>} <input type="color" value={String(p.color ?? (isSub ? '#F8FAFC' : '#ffffff'))} onChange={(e) => onPropChange('color', e.target.value)} />
        </label>
        <label style={{ fontSize: 11, color: theme.textDim, display: 'flex', alignItems: 'center', gap: 6 }}>
          Align
          <select value={mixed?.('align') ? '__mixed' : String(p.align ?? 'center')} onChange={(e) => onPropChange('align', e.target.value)} style={selStyle}>
            {mixed?.('align') && <option value="__mixed" disabled>—</option>}
            <option value="left">Left</option><option value="center">Center</option><option value="right">Right</option>
          </select>
        </label>
        <label style={{ fontSize: 11, color: theme.textDim, display: 'flex', alignItems: 'center', gap: 6 }}>
          Weight
          <select value={mixed?.('fontWeight') ? '__mixed' : String(p.fontWeight ?? (isSub ? 600 : 700))} onChange={(e) => onPropChange('fontWeight', Number(e.target.value))} style={selStyle}>
            {mixed?.('fontWeight') && <option value="__mixed" disabled>—</option>}
            <option value="300">Light</option><option value="400">Regular</option><option value="600">Medium</option><option value="700">Bold</option><option value="900">Black</option>
          </select>
        </label>
        <label style={{ fontSize: 11, color: theme.textDim, display: 'flex', alignItems: 'center', gap: 6 }}>
          Style
          <select value={mixed?.('fontStyle') ? '__mixed' : String(p.fontStyle ?? 'normal')} onChange={(e) => onPropChange('fontStyle', e.target.value)} style={selStyle}>
            {mixed?.('fontStyle') && <option value="__mixed" disabled>—</option>}
            <option value="normal">Normal</option><option value="italic">Italic</option>
          </select>
        </label>
      </div>

      {/* 5. Typography Spacing (Letter Spacing & Line Height) */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 4, paddingTop: 8, borderTop: `0.5px solid ${theme.borderLight}` }}>
        <div style={{ fontSize: 11, fontWeight: 600, color: theme.text }}>Spacing & Typography</div>
        <label style={{ fontSize: 11, color: theme.textDim }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
            <span>Letter Spacing</span>
            <span style={{ opacity: 0.7 }}>{mixed?.('letterSpacing') ? '—' : `${p.letterSpacing ?? (isSub ? 0.5 : isBadge ? 1 : 0)}px`}</span>
          </div>
          <input type="range" min={-2} max={24} step={0.5} value={Number(p.letterSpacing ?? (isSub ? 0.5 : isBadge ? 1 : 0))} onChange={(e) => onPropChange('letterSpacing', Number(e.target.value))} style={{ width: '100%' }} />
        </label>
        <label style={{ fontSize: 11, color: theme.textDim }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
            <span>Line Height</span>
            <span style={{ opacity: 0.7 }}>{mixed?.('lineHeight') ? '—' : `${Number(p.lineHeight ?? (isSub ? 1.35 : 1.2)).toFixed(2)}×`}</span>
          </div>
          <input type="range" min={0.8} max={2.5} step={0.05} value={Number(p.lineHeight ?? (isSub ? 1.35 : 1.2))} onChange={(e) => onPropChange('lineHeight', Number(e.target.value))} style={{ width: '100%' }} />
        </label>
      </div>

      {/* 6. Backdrop & Capsule Pill Styling */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 4, paddingTop: 8, borderTop: `0.5px solid ${theme.borderLight}` }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ fontSize: 11, fontWeight: 600, color: theme.text }}>Backdrop Badge / Pill</span>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: theme.textDim, cursor: 'pointer' }}>
            <input type="checkbox" checked={bgActive} onChange={(e) => onPropChange('bgEnabled', e.target.checked)} />
            Enable Backdrop
          </label>
        </div>
        {bgActive && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 4 }}>
            <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
              <label style={{ fontSize: 11, color: theme.textDim, display: 'flex', alignItems: 'center', gap: 6 }}>
                Background Color <input type="color" value={String(p.bgColorHex ?? (isBadge ? (item.name?.includes('New') ? '#10b981' : '#475569') : '#0a0f1a'))} onChange={(e) => {
                  const hex = e.target.value;
                  onPropChange('bgColorHex', hex);
                  const r = parseInt(hex.slice(1, 3), 16);
                  const g = parseInt(hex.slice(3, 5), 16);
                  const b = parseInt(hex.slice(5, 7), 16);
                  const op = Number(p.bgOpacity ?? (isBadge ? 0.45 : 0.85));
                  onPropChange('bgColor', `rgba(${r}, ${g}, ${b}, ${op})`);
                }} />
              </label>
              <label style={{ fontSize: 11, color: theme.textDim, display: 'flex', alignItems: 'center', gap: 6 }}>
                Opacity
                <input type="range" min={0.1} max={1} step={0.05} value={Number(p.bgOpacity ?? (isBadge ? 0.45 : 0.85))} onChange={(e) => {
                  const op = Number(e.target.value);
                  onPropChange('bgOpacity', op);
                  const hex = String(p.bgColorHex ?? (isBadge ? (item.name?.includes('New') ? '#10b981' : '#475569') : '#0a0f1a'));
                  const r = parseInt(hex.slice(1, 3), 16);
                  const g = parseInt(hex.slice(3, 5), 16);
                  const b = parseInt(hex.slice(5, 7), 16);
                  onPropChange('bgColor', `rgba(${r}, ${g}, ${b}, ${op})`);
                }} style={{ width: 60 }} />
                <span style={{ fontSize: 10, opacity: 0.7 }}>{Math.round(Number(p.bgOpacity ?? (isBadge ? 0.45 : 0.85)) * 100)}%</span>
              </label>
            </div>

            <label style={{ fontSize: 11, color: theme.textDim }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                <span>Border Radius</span>
                <span style={{ opacity: 0.7 }}>{Number(p.bgRadius ?? 9999) >= 9999 ? 'Pill' : `${p.bgRadius ?? 9999}px`}</span>
              </div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <input type="range" min={0} max={40} step={2} value={Math.min(40, Number(p.bgRadius ?? 40))} onChange={(e) => onPropChange('bgRadius', Number(e.target.value))} style={{ flex: 1 }} />
                <button type="button" onClick={() => onPropChange('bgRadius', 9999)} style={{ ...selStyle, fontSize: 10, cursor: 'pointer' }}>Full Pill</button>
              </div>
            </label>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
              <label style={{ fontSize: 11, color: theme.textDim }}>
                <div style={{ marginBottom: 4 }}>Horizontal Padding ({Number(p.bgPaddingX ?? (isBadge ? 22 : 32))}px)</div>
                <input type="range" min={4} max={64} step={2} value={Number(p.bgPaddingX ?? (isBadge ? 22 : 32))} onChange={(e) => onPropChange('bgPaddingX', Number(e.target.value))} style={{ width: '100%' }} />
              </label>
              <label style={{ fontSize: 11, color: theme.textDim }}>
                <div style={{ marginBottom: 4 }}>Vertical Padding ({Number(p.bgPaddingY ?? (isBadge ? 6 : 10))}px)</div>
                <input type="range" min={2} max={32} step={1} value={Number(p.bgPaddingY ?? (isBadge ? 6 : 10))} onChange={(e) => onPropChange('bgPaddingY', Number(e.target.value))} style={{ width: '100%' }} />
              </label>
            </div>

            <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
              <label style={{ fontSize: 11, color: theme.textDim, display: 'flex', alignItems: 'center', gap: 6 }}>
                Backdrop Blur
                <input type="range" min={0} max={30} step={2} value={Number(p.bgBlur ?? (isBadge ? 16 : 20))} onChange={(e) => onPropChange('bgBlur', Number(e.target.value))} style={{ width: 60 }} />
                <span style={{ fontSize: 10, opacity: 0.7 }}>{Number(p.bgBlur ?? (isBadge ? 16 : 20))}px</span>
              </label>
              <label style={{ fontSize: 11, color: theme.textDim, display: 'flex', alignItems: 'center', gap: 6 }}>
                Border <input type="color" value={String(p.bgBorderColorHex ?? '#ffffff')} onChange={(e) => {
                  const hex = e.target.value;
                  onPropChange('bgBorderColorHex', hex);
                  const w = Number(p.bgBorderWidth ?? 1);
                  if (w > 0) onPropChange('bgBorder', `${w}px solid ${hex}40`);
                  else onPropChange('bgBorder', 'none');
                }} />
              </label>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}


// animated zoom (builtin:zoom): shape curve + magnification + focal point,
// plus ReframeCurveV1 sparse keyframes (drop focal+mag at the playhead).
export function ZoomControl({ zoom, mixed, onChange, getLocalFrame, fps, onSetKeyframe, onRemoveKeyframe }: {
  zoom: ZoomEffect | undefined;
  mixed?: Partial<Record<'shape' | 'magnification' | 'focalPointX' | 'focalPointY', boolean>>;
  onChange: (patch: Partial<ZoomEffect> | null) => void;
  getLocalFrame: () => number;
  fps: number;
  onSetKeyframe: (frame: number, fx: number, fy: number, mag: number) => void;
  onRemoveKeyframe: (frame: number) => void;
}) {
  const t = useT();
  const localFrame = getLocalFrame();
  const hasKeyframes = !!zoom?.reframeCurve?.keyframes.length;
  const zoomShapeNames: Record<string, string> = {
    punch: 'Punch',
    hold: 'Hold / Push & Pull',
    'slow-push': 'Slow Push',
    instant: 'Instant',
    'zoom-out': 'Zoom Out',
    'ease-in': 'Ease-In Push',
    bounce: 'Bouncy Push',
    snap: 'Snap Push',
    pulse: 'Pulse',
    'whip-in': 'Whip-In Push',
  };
  return (
    <div className="cc-insp-stack">
      <label className="cc-insp-row">
        <span className="cc-insp-label">Curve</span>
        <select className="cc-insp-select" value={mixed?.shape ? '__mixed' : zoom?.shape ?? ''} onChange={(e) => {
          const v = e.target.value as ZoomShape | '';
          if (!v) onChange(null);
          else onChange({ shape: v });
        }}>
          {mixed?.shape && <option value="__mixed" disabled>—</option>}
          <option value="">None</option>
          {ZOOM_SHAPE_ORDER.map((k) => <option key={k} value={k}>{zoomShapeNames[k] ?? t(ZOOM_SHAPE_LABELS[k])}</option>)}
        </select>
      </label>
      {zoom && (
        <>
          <SliderRow label="Magnification" val={zoom.magnification ?? 1.5} min={1} max={4} step={0.05} fmt={`${(zoom.magnification ?? 1.5).toFixed(2)}×`} mixed={mixed?.magnification}
            onReset={() => onChange({ magnification: 1.5, reframeCurve: undefined })} resetDisabled={!mixed?.magnification && !hasKeyframes && Math.abs((zoom.magnification ?? 1.5) - 1.5) < 1e-6}
            onChange={(v) => onChange({ magnification: v })} />
          <SliderRow label="Focal Point X" val={zoom.focalPointX ?? 0.5} min={0} max={1} step={0.01} fmt={`${compactNumber((zoom.focalPointX ?? 0.5) * 100)}%`} inputScale={100} mixed={mixed?.focalPointX}
            onReset={() => onChange({ focalPointX: 0.5, reframeCurve: undefined })} resetDisabled={!mixed?.focalPointX && !hasKeyframes && Math.abs((zoom.focalPointX ?? 0.5) - 0.5) < 1e-6}
            onChange={(v) => onChange({ focalPointX: v })} />
          <SliderRow label="Focal Point Y" val={zoom.focalPointY ?? 0.5} min={0} max={1} step={0.01} fmt={`${compactNumber((zoom.focalPointY ?? 0.5) * 100)}%`} inputScale={100} mixed={mixed?.focalPointY}
            onReset={() => onChange({ focalPointY: 0.5, reframeCurve: undefined })} resetDisabled={!mixed?.focalPointY && !hasKeyframes && Math.abs((zoom.focalPointY ?? 0.5) - 0.5) < 1e-6}
            onChange={(v) => onChange({ focalPointY: v })} />
          <div className="cc-insp-actions">
            <button
              type="button"
              onClick={() => onSetKeyframe(getLocalFrame(), zoom.focalPointX ?? 0.5, zoom.focalPointY ?? 0.5, zoom.magnification ?? 1.5)}
              title="Record focal point and magnification at playhead as keyframe"
              className="cc-insp-btn"
            >
              <Icon name="diamond" size={12} />Keyframe
            </button>
            <span className="cc-insp-muted">@ {(localFrame / fps).toFixed(2)}s</span>
          </div>
          {(zoom.reframeCurve?.keyframes.length ?? 0) > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <div style={{ fontSize: 10.5, color: theme.textDim, opacity: 0.8 }}>Keyframes (override curve, interpolated frame-by-frame)</div>
              {zoom.reframeCurve!.keyframes.map((k) => (
                <div key={k.frame} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11, color: theme.textDim }}>
                  <span style={{ fontVariantNumeric: 'tabular-nums', display: 'inline-flex', alignItems: 'center', gap: 4 }}><Icon name="diamond" size={11} />{(k.frame / fps).toFixed(2)}s</span>
                  <span style={{ opacity: 0.8 }}>{k.magnification.toFixed(2)}× · ({Math.round(k.focalPointX * 100)},{Math.round(k.focalPointY * 100)})</span>
                  <button onClick={() => onRemoveKeyframe(k.frame)} title="Delete keyframe" style={{ background: 'none', border: 'none', color: theme.textDim, cursor: 'pointer', fontSize: 12, marginLeft: 'auto', display: 'inline-flex', alignItems: 'center' }}><Icon name="x" size={12} /></button>
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
export function TransitionControl({ transition, fps, onAdd, onSet, onRemove, audioMode, previewStatus }: {
  transition: TransitionItem | null;
  fps: number;
  onAdd: (type: TransitionType) => void;
  onSet: (patch: Partial<TransitionItem>) => void;
  onRemove: () => void;
  /** true = only audio-cross-fade (trAudioCrossFade) */
  audioMode?: boolean;
  previewStatus?: SelectedPreviewStatus;
}) {
  const t = useT();
  const selStyle: CSSProperties = { background: theme.bg, color: theme.text, border: `0.5px solid ${theme.borderLight}`, borderRadius: 4, padding: '3px 5px' };
  const needsDir = transition && (transition.type === 'soft-wipe' || transition.type === 'whip-pan');
  const options = audioMode ? AUDIO_TRANSITION_ORDER : TRANSITION_ORDER;
  const transitionNames: Record<string, string> = {
    'anticipation-zoom': 'Anticipation Zoom',
    'clean-line-wipe': 'Clean Line Wipe',
    'cross-dissolve': 'Cross Dissolve',
    'dip-to-black': 'Dip to Black',
    flash: 'Flash',
    'impact-shake': 'Impact Shake',
    'luma-blend': 'Luma Blend',
    'organic-dissolve': 'Organic Dissolve',
    'page-curl': 'Page Curl',
    'rack-focus': 'Rack Focus',
    'soft-wipe': 'Soft Wipe',
    'whip-pan': 'Whip Pan',
    'circle-wipe': 'Circle Wipe',
    'radial-blur': 'Radial Blur',
    'glitch-cut': 'Glitch Cut',
    'dip-to-color': 'Dip to Color',
    'audio-cross-fade': 'Audio Cross Fade',
    'custom-shader': 'Custom Shader',
  };
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
          ? 'Cross-fade with adjacent audio (fade out / fade in)'
          : 'Transition from previous adjacent clip into this clip'}
      </div>
      <label style={{ fontSize: 11, color: theme.textDim, display: 'flex', alignItems: 'center', gap: 8 }}>
        Type
        <select value={shown?.type ?? ''} style={selStyle} onChange={(e) => {
          const v = e.target.value as TransitionType | '';
          if (!v) { if (shown) onRemove(); }
          else if (shown) onSet({ type: v });
          else onAdd(v);
        }}>
          <option value="">None</option>
          {options.map((k) => <option key={k} value={k}>{transitionNames[k] ?? t(TRANSITION_LABELS[k])}</option>)}
        </select>
      </label>
      {shown && !audioMode && <PreviewFidelityStatus status={previewStatus} />}
      {shown && (
        <>
          <label style={{ fontSize: 11, color: theme.textDim }}>
            <div style={{ marginBottom: 4 }}>Duration <span style={{ opacity: 0.7 }}>{(shown.durationInFrames / fps).toFixed(1)}s</span></div>
            <input type="range" min={2} max={Math.max(4, fps * 2)} step={1} value={shown.durationInFrames} onChange={(e) => onSet({ durationInFrames: Number(e.target.value) })} style={{ width: '100%' }} />
          </label>
          {needsDir && !audioMode && (
            <label style={{ fontSize: 11, color: theme.textDim, display: 'flex', alignItems: 'center', gap: 8 }}>
              Direction
              <select value={shown.direction ?? 'left'} style={selStyle} onChange={(e) => onSet({ direction: e.target.value as TransitionItem['direction'] })}>
                <option value="left">Left</option><option value="right">Right</option><option value="up">Up</option><option value="down">Down</option>
              </select>
            </label>
          )}
        </>
      )}
    </div>
  );
}

