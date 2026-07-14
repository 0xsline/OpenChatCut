import { theme } from '../theme';
import type { Tpl } from '../types';
import type { ClipEffect, ClipEffectValue, ClipFilters, ClipTransform, TimelineItem, TransitionItem, TransitionType, ZoomEffect, ZoomShape } from '../editor/types';
import { TRANSITION_LABELS, TRANSITION_ORDER, ZOOM_SHAPE_LABELS } from '../editor/types';
import { ALL_FX as FX_EFFECTS } from '../gl/fx/effects';
const FX_IDS = Object.keys(FX_EFFECTS);
import { usePersistedState } from '../hooks/usePersistedState';
import { Icon } from './icons';

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
  transition: TransitionItem | null;
  onAddTransition: (type: TransitionType) => void;
  onSetTransition: (patch: Partial<TransitionItem>) => void;
  onRemoveTransition: () => void;
}

// scale / position / rotation for visual clips (source 缩放 tab).
function TransformControl({ item, onChange }: { item: TimelineItem; onChange: (p: ClipTransform) => void }) {
  const t = item.transform ?? {};
  const slider = (label: string, val: number, min: number, max: number, step: number, fmt: string, key: keyof ClipTransform) => (
    <label style={{ display: 'block', fontSize: 11, color: theme.textDim }}>
      <div style={{ marginBottom: 4 }}>{label} <span style={{ opacity: 0.7 }}>{fmt}</span></div>
      <input type="range" min={min} max={max} step={step} value={val} onChange={(e) => onChange({ [key]: Number(e.target.value) })} style={{ width: '100%' }} />
    </label>
  );
  const scale = t.scale ?? 1;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {slider('缩放', scale, 0.1, 3, 0.05, `${Math.round(scale * 100)}%`, 'scale')}
      {slider('水平位置', t.x ?? 0, -100, 100, 1, `${Math.round(t.x ?? 0)}%`, 'x')}
      {slider('垂直位置', t.y ?? 0, -100, 100, 1, `${Math.round(t.y ?? 0)}%`, 'y')}
      {slider('旋转', t.rotation ?? 0, -180, 180, 1, `${Math.round(t.rotation ?? 0)}°`, 'rotation')}
    </div>
  );
}

// audio + video clips carry a playback volume; image/MG do not.
function VolumeControl({ item, onChange }: { item: TimelineItem; onChange: (v: number) => void }) {
  const vol = item.volume ?? 1;
  return (
    <label style={{ display: 'block', fontSize: 11, color: theme.textDim }}>
      <div style={{ marginBottom: 4 }}>音量 <span style={{ opacity: 0.7 }}>{Math.round(vol * 100)}%</span></div>
      <input type="range" min={0} max={2} step={0.05} value={vol} onChange={(e) => onChange(Number(e.target.value))} style={{ width: '100%' }} />
    </label>
  );
}

// fade in/out (seconds) — opacity ramp for visual clips, volume ramp for audio.
function FadeControl({ item, fps, onChange }: { item: TimelineItem; fps: number; onChange: (f: FadePatch) => void }) {
  const maxSec = Math.max(0.1, item.durationInFrames / fps);
  const row = (label: string, frames: number | undefined, key: keyof FadePatch) => {
    const sec = (frames ?? 0) / fps;
    return (
      <label style={{ display: 'block', fontSize: 11, color: theme.textDim }}>
        <div style={{ marginBottom: 4 }}>{label} <span style={{ opacity: 0.7 }}>{sec.toFixed(1)}s</span></div>
        <input type="range" min={0} max={maxSec} step={0.1} value={sec}
          onChange={(e) => onChange({ [key]: Math.round(Number(e.target.value) * fps) })} style={{ width: '100%' }} />
      </label>
    );
  };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
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
  const selStyle: React.CSSProperties = { background: theme.bg, color: theme.text, border: `1px solid ${theme.borderLight}`, borderRadius: 4, padding: '3px 5px' };
  const slider = (label: string, val: number, min: number, max: number, step: number, fmt: string, key: keyof ZoomEffect) => (
    <label style={{ display: 'block', fontSize: 11, color: theme.textDim }}>
      <div style={{ marginBottom: 4 }}>{label} <span style={{ opacity: 0.7 }}>{fmt}</span></div>
      <input type="range" min={min} max={max} step={step} value={val} onChange={(e) => onChange({ [key]: Number(e.target.value) })} style={{ width: '100%' }} />
    </label>
  );
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <label style={{ fontSize: 11, color: theme.textDim, display: 'flex', alignItems: 'center', gap: 8 }}>
        曲线
        <select value={zoom?.shape ?? ''} style={selStyle} onChange={(e) => {
          const v = e.target.value as ZoomShape | '';
          if (!v) onChange(null);
          else onChange({ shape: v });
        }}>
          <option value="">无</option>
          {(Object.keys(ZOOM_SHAPE_LABELS) as ZoomShape[]).map((k) => <option key={k} value={k}>{ZOOM_SHAPE_LABELS[k]}</option>)}
        </select>
      </label>
      {zoom && (
        <>
          {slider('放大倍数', zoom.magnification ?? 1.5, 1, 4, 0.05, `${(zoom.magnification ?? 1.5).toFixed(2)}×`, 'magnification')}
          {slider('焦点 X', zoom.focalPointX ?? 0.5, 0, 1, 0.01, `${Math.round((zoom.focalPointX ?? 0.5) * 100)}%`, 'focalPointX')}
          {slider('焦点 Y', zoom.focalPointY ?? 0.5, 0, 1, 0.01, `${Math.round((zoom.focalPointY ?? 0.5) * 100)}%`, 'focalPointY')}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 2 }}>
            <button
              onClick={() => onSetKeyframe(getLocalFrame(), zoom.focalPointX ?? 0.5, zoom.focalPointY ?? 0.5, zoom.magnification ?? 1.5)}
              title="在播放头记录焦点+倍数为关键帧"
              style={{ background: theme.panelAlt, border: `1px solid ${theme.borderLight}`, borderRadius: 5, color: theme.text, cursor: 'pointer', fontSize: 11, padding: '4px 9px', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              <Icon name="diamond" size={12} />在播放头打关键帧
            </button>
            <span style={{ fontSize: 10.5, color: theme.textDim }}>@ {(localFrame / fps).toFixed(2)}s</span>
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
function TransitionControl({ transition, fps, onAdd, onSet, onRemove }: {
  transition: TransitionItem | null;
  fps: number;
  onAdd: (type: TransitionType) => void;
  onSet: (patch: Partial<TransitionItem>) => void;
  onRemove: () => void;
}) {
  const selStyle: React.CSSProperties = { background: theme.bg, color: theme.text, border: `1px solid ${theme.borderLight}`, borderRadius: 4, padding: '3px 5px' };
  const needsDir = transition && (transition.type === 'soft-wipe' || transition.type === 'whip-pan');
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ fontSize: 10.5, color: theme.textDim, opacity: 0.8 }}>从前一个相邻片段进入本片段</div>
      <label style={{ fontSize: 11, color: theme.textDim, display: 'flex', alignItems: 'center', gap: 8 }}>
        类型
        <select value={transition?.type ?? ''} style={selStyle} onChange={(e) => {
          const v = e.target.value as TransitionType | '';
          if (!v) { if (transition) onRemove(); }
          else if (transition) onSet({ type: v });
          else onAdd(v);
        }}>
          <option value="">无</option>
          {TRANSITION_ORDER.map((k) => <option key={k} value={k}>{TRANSITION_LABELS[k]}</option>)}
        </select>
      </label>
      {transition && (
        <>
          <label style={{ fontSize: 11, color: theme.textDim }}>
            <div style={{ marginBottom: 4 }}>时长 <span style={{ opacity: 0.7 }}>{(transition.durationInFrames / fps).toFixed(1)}s</span></div>
            <input type="range" min={2} max={Math.max(4, fps * 2)} step={1} value={transition.durationInFrames} onChange={(e) => onSet({ durationInFrames: Number(e.target.value) })} style={{ width: '100%' }} />
          </label>
          {needsDir && (
            <label style={{ fontSize: 11, color: theme.textDim, display: 'flex', alignItems: 'center', gap: 8 }}>
              方向
              <select value={transition.direction ?? 'left'} style={selStyle} onChange={(e) => onSet({ direction: e.target.value as TransitionItem['direction'] })}>
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
  return <div style={{ fontSize: 10.5, color: theme.textDim, letterSpacing: '0.08em', opacity: 0.7, marginTop: 2, borderTop: `1px solid ${theme.border}`, paddingTop: 8 }}>{children}</div>;
}

// brightness / contrast / saturation / blur (CSS filter) — source 特效/LUT.
function FilterControl({ item, onChange }: { item: TimelineItem; onChange: (p: ClipFilters) => void }) {
  const fl = item.filters ?? {};
  const slider = (label: string, val: number, min: number, max: number, step: number, fmt: string, key: keyof ClipFilters) => (
    <label style={{ display: 'block', fontSize: 11, color: theme.textDim }}>
      <div style={{ marginBottom: 4 }}>{label} <span style={{ opacity: 0.7 }}>{fmt}</span></div>
      <input type="range" min={min} max={max} step={step} value={val} onChange={(e) => onChange({ [key]: Number(e.target.value) })} style={{ width: '100%' }} />
    </label>
  );
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {slider('亮度', fl.brightness ?? 1, 0, 2, 0.05, `${Math.round((fl.brightness ?? 1) * 100)}%`, 'brightness')}
      {slider('对比度', fl.contrast ?? 1, 0, 2, 0.05, `${Math.round((fl.contrast ?? 1) * 100)}%`, 'contrast')}
      {slider('饱和度', fl.saturate ?? 1, 0, 2, 0.05, `${Math.round((fl.saturate ?? 1) * 100)}%`, 'saturate')}
      {slider('模糊', fl.blur ?? 0, 0, 30, 1, `${Math.round(fl.blur ?? 0)}px`, 'blur')}
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
export function InspectorPanel({ templates, selectedItem, fps, onItemPropChange, onItemVolumeChange, onItemFadeChange, onItemTransformChange, onItemFiltersChange, onItemZoomChange, onItemEffectsChange, getPlayhead, onSetReframeKeyframe, onRemoveReframeKeyframe, transition, onAddTransition, onSetTransition, onRemoveTransition }: InspectorPanelProps) {
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
      : selectedItem.kind === 'text'
      ? '文字片段。'
      : null
    : null;
  const hasVolume = selectedItem?.kind === 'audio' || selectedItem?.kind === 'video';
  const isVisual = selectedItem != null && selectedItem.kind !== 'audio';

  return (
    <section style={{ borderTop: `1px solid ${theme.border}`, background: theme.panel, display: 'flex', flexDirection: 'column', minHeight: 0, flex: '0 0 auto', maxHeight: collapsed ? undefined : '42%', overflow: 'hidden' }}>
      <button
        onClick={() => setCollapsed((v) => !v)}
        title={collapsed ? '展开属性' : '收起属性'}
        style={{ display: 'flex', alignItems: 'center', gap: 6, width: '100%', textAlign: 'left', padding: '8px 16px', fontSize: 12, color: theme.textDim, background: 'none', border: 'none', borderBottom: `1px solid ${theme.border}`, cursor: 'pointer', flexShrink: 0 }}
      >
        <span style={{ transform: collapsed ? 'rotate(-90deg)' : 'none', transition: 'transform 0.15s', display: 'inline-flex', alignItems: 'center' }}><Icon name="chevronDown" size={13} /></span>
        属性{selectedItem ? ` · ${selectedItem.name}` : ''}
      </button>
      {!collapsed && (
      <div style={{ flex: 1, overflowY: 'auto', padding: '10px 16px', minHeight: 0 }}>
        {!selectedItem ? (
          <div style={{ fontSize: 12, color: theme.textDim }}>选中时间线上的片段以编辑属性。</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            {hint && <div style={{ fontSize: 12, color: theme.textDim }}>{hint}</div>}
            {selectedItem.kind === 'text' && <><SectionLabel>文字</SectionLabel><TextControl item={selectedItem} onPropChange={onItemPropChange} /></>}
            {hasVolume && <><SectionLabel>音量</SectionLabel><VolumeControl item={selectedItem} onChange={onItemVolumeChange} /></>}
            {isVisual && <><SectionLabel>变换</SectionLabel><TransformControl item={selectedItem} onChange={onItemTransformChange} /></>}
            {isVisual && <><SectionLabel>滤镜</SectionLabel><FilterControl item={selectedItem} onChange={onItemFiltersChange} /></>}
            {(selectedItem.kind === 'video' || selectedItem.kind === 'image') && <><SectionLabel>特效 FX</SectionLabel><EffectsControl item={selectedItem} onChange={onItemEffectsChange} /></>}
            {isVisual && <><SectionLabel>缩放动画</SectionLabel><ZoomControl zoom={selectedItem.zoom} onChange={onItemZoomChange} getLocalFrame={() => Math.max(0, Math.min(selectedItem.durationInFrames - 1, getPlayhead() - selectedItem.startFrame))} fps={fps} onSetKeyframe={onSetReframeKeyframe} onRemoveKeyframe={onRemoveReframeKeyframe} /></>}
            {isVisual && <><SectionLabel>转场</SectionLabel><TransitionControl transition={transition} fps={fps} onAdd={onAddTransition} onSet={onSetTransition} onRemove={onRemoveTransition} /></>}
            <SectionLabel>淡入淡出</SectionLabel>
            <FadeControl item={selectedItem} fps={fps} onChange={onItemFadeChange} />
            {selectedItem.kind === 'motion-graphic' && (
              schema.length === 0 ? (
                <div style={{ fontSize: 12, color: theme.textDim }}>该模板用内置默认值（无可编辑属性）。</div>
              ) : (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 12 }}>
                  {schema.map((p) => (
                    <label key={p.key} style={{ fontSize: 11, color: theme.textDim }}>
                      <div style={{ marginBottom: 4 }}>{p.key} <em style={{ opacity: 0.5 }}>({p.type})</em></div>
                      {p.type === 'boolean' ? (
                        <input type="checkbox" checked={!!selectedItem.props?.[p.key]} onChange={(e) => onItemPropChange(p.key, e.target.checked)} />
                      ) : p.type === 'color' ? (
                        <input type="color" value={String(selectedItem.props?.[p.key] ?? '#000000')} onChange={(e) => onItemPropChange(p.key, e.target.value)} />
                      ) : (
                        <input
                          type={p.type === 'number' ? 'number' : 'text'}
                          value={String(selectedItem.props?.[p.key] ?? '')}
                          onChange={(e) => onItemPropChange(p.key, p.type === 'number' ? Number(e.target.value) : e.target.value)}
                          style={{ width: '100%', padding: '5px 7px', background: theme.bg, color: theme.text, border: `1px solid ${theme.borderLight}`, borderRadius: 5 }}
                        />
                      )}
                    </label>
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
