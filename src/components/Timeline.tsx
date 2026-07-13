import { useRef, useState } from 'react';
import { theme } from '../theme';
import { TRACK_ORDER, timelineDuration, type TimelineState, type TrackId } from '../editor/types';
import type { EditorCommands } from '../editor/store';

interface TimelineProps {
  state: TimelineState;
  commands: EditorCommands;
}

const TRACK_META: Record<TrackId, { color: string; kind: 'video' | 'audio' }> = {
  V2: { color: theme.trackVideo, kind: 'video' },
  V1: { color: theme.trackVideo, kind: 'video' },
  A1: { color: theme.trackAudioA1, kind: 'audio' },
  A2: { color: theme.trackAudioA2, kind: 'audio' },
};

const HEADER_W = 120;
const PX_PER_FRAME = 6;
const toolBtn: React.CSSProperties = { background: 'none', border: 'none', color: theme.textDim, cursor: 'pointer', fontSize: 15, padding: '2px 6px' };

function fmt(frames: number, fps: number): string {
  const s = frames / fps;
  const mm = Math.floor(s / 60);
  const ss = Math.floor(s % 60);
  const cs = Math.floor((s * 100) % 100);
  return `${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

export function Timeline({ state, commands }: TimelineProps) {
  const total = timelineDuration(state);
  const [drag, setDrag] = useState<{ id: string; base: number; delta: number } | null>(null);
  const dragRef = useRef<{ startX: number } | null>(null);

  const onPointerDown = (e: React.PointerEvent, id: string, base: number) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    commands.selectItem(id);
    dragRef.current = { startX: e.clientX };
    setDrag({ id, base, delta: 0 });
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!drag || !dragRef.current) return;
    const deltaFrames = Math.round((e.clientX - dragRef.current.startX) / PX_PER_FRAME);
    setDrag((d) => (d ? { ...d, delta: Math.max(deltaFrames, -d.base) } : d));
  };
  const onPointerUp = () => {
    if (drag && drag.delta !== 0) commands.moveItem(drag.id, { startFrame: drag.base + drag.delta });
    setDrag(null);
    dragRef.current = null;
  };

  return (
    <section style={{ borderTop: `1px solid ${theme.border}`, background: theme.panel, display: 'flex', flexDirection: 'column', minHeight: 0, overflow: 'hidden' }}>
      {/* toolbar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '6px 10px', borderBottom: `1px solid ${theme.border}` }}>
        <button style={toolBtn}>＋</button>
        <button style={toolBtn}>▮</button>
        <button style={{ ...toolBtn, color: theme.accent }}>⧉</button>
        <button style={toolBtn}>▬</button>
        <button style={toolBtn} title="删除选中" onClick={() => state.selectedId && commands.removeItem(state.selectedId)}>🗑</button>
        <span style={{ flex: 1 }} />
        <span style={{ fontSize: 12, color: theme.text, fontVariantNumeric: 'tabular-nums' }}>00:00.00 / {fmt(total, state.fps)}</span>
        <span style={{ flex: 1 }} />
        <button style={toolBtn}>🔍−</button>
        <button style={toolBtn}>🔍＋</button>
        <button style={toolBtn}>CC</button>
      </div>

      {/* ruler */}
      <div style={{ display: 'flex', borderBottom: `1px solid ${theme.border}`, fontSize: 10, color: theme.textDim }}>
        <div style={{ width: HEADER_W, flexShrink: 0, textAlign: 'center', padding: '4px 0' }}>{fmt(0, state.fps)}</div>
        <div style={{ flex: 1, position: 'relative', height: 22, overflow: 'hidden' }}>
          {Array.from({ length: Math.ceil(total / (state.fps * 2)) + 1 }).map((_, i) => (
            <span key={i} style={{ position: 'absolute', left: i * state.fps * 2 * PX_PER_FRAME, top: 4 }}>{fmt(i * state.fps * 2, state.fps)}</span>
          ))}
        </div>
      </div>

      {/* tracks */}
      <div style={{ overflow: 'auto', flex: 1, minHeight: 0 }} onPointerMove={onPointerMove} onPointerUp={onPointerUp}>
        {TRACK_ORDER.map((trackId) => {
          const meta = TRACK_META[trackId];
          const items = state.items.filter((it) => it.track === trackId);
          return (
            <div key={trackId} style={{ display: 'flex', height: 56, borderBottom: `1px solid ${theme.border}` }}>
              <div style={{ width: HEADER_W, flexShrink: 0, display: 'flex', alignItems: 'center', gap: 6, padding: '0 8px', borderRight: `1px solid ${theme.border}` }}>
                <span style={{ background: meta.color, color: '#fff', fontSize: 11, fontWeight: 700, borderRadius: 4, padding: '2px 6px' }}>{trackId}</span>
                <span style={{ color: theme.textDim, fontSize: 12 }}>👁</span>
                <span style={{ color: theme.textDim, fontSize: 12 }}>🔊</span>
              </div>
              <div style={{ flex: 1, position: 'relative', background: theme.bg }}>
                {items.map((it) => {
                  const isDragging = drag?.id === it.id;
                  const startFrame = it.startFrame + (isDragging ? drag.delta : 0);
                  const selected = state.selectedId === it.id;
                  return (
                    <div
                      key={it.id}
                      title={it.name}
                      onPointerDown={(e) => onPointerDown(e, it.id, it.startFrame)}
                      style={{
                        position: 'absolute', left: startFrame * PX_PER_FRAME, top: 6, height: 44,
                        width: it.durationInFrames * PX_PER_FRAME,
                        background: meta.kind === 'video' ? theme.clipVideo : theme.clipAudio,
                        borderRadius: 5, color: '#fff', fontSize: 11,
                        display: 'flex', alignItems: 'center', padding: '0 8px', gap: 6, overflow: 'hidden', whiteSpace: 'nowrap',
                        border: selected ? '2px solid #fff' : '2px solid transparent',
                        cursor: 'grab', userSelect: 'none', touchAction: 'none',
                      }}
                    >
                      <span>✦</span>{it.name}
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
