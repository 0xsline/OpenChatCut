import { theme } from '../theme';
import type { Tpl } from '../types';
import type { ClipTransform, TimelineItem } from '../editor/types';
import { usePersistedState } from '../hooks/usePersistedState';

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

// Property editor for the selected timeline item (sits under the preview).
// Collapsible so it doesn't crowd the preview when you don't need it.
export function InspectorPanel({ templates, selectedItem, fps, onItemPropChange, onItemVolumeChange, onItemFadeChange, onItemTransformChange }: InspectorPanelProps) {
  const [collapsed, setCollapsed] = usePersistedState('cc.inspectorCollapsed', false);
  const schema = selectedItem
    ? templates.find((t) => t.id === selectedItem.templateId)?.propSchema ?? []
    : [];

  const hint = selectedItem
    ? selectedItem.kind === 'audio'
      ? '🎵 音频片段。可在时间线上拖动位置、裁剪首尾。'
      : selectedItem.kind === 'video'
      ? '🎬 视频片段。可在时间线上拖动位置、裁剪首尾（左裁剪推进源入点）。'
      : selectedItem.kind === 'image'
      ? '🖼 图片片段。'
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
        <span style={{ transform: collapsed ? 'rotate(-90deg)' : 'none', transition: 'transform 0.15s', display: 'inline-block' }}>▾</span>
        属性{selectedItem ? ` · ${selectedItem.name}` : ''}
      </button>
      {!collapsed && (
      <div style={{ flex: 1, overflowY: 'auto', padding: '10px 16px', minHeight: 0 }}>
        {!selectedItem ? (
          <div style={{ fontSize: 12, color: theme.textDim }}>选中时间线上的片段以编辑属性。</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            {hint && <div style={{ fontSize: 12, color: theme.textDim }}>{hint}</div>}
            {hasVolume && <VolumeControl item={selectedItem} onChange={onItemVolumeChange} />}
            {isVisual && <TransformControl item={selectedItem} onChange={onItemTransformChange} />}
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
