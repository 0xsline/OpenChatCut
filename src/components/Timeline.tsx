import { useEffect, useRef, useState, type RefObject } from 'react';
import type { PlayerRef } from '@remotion/player';
import { theme } from '../theme';
import { TRACK_ORDER, timelineDuration, type TimelineState, type TrackId } from '../editor/types';
import type { EditorCommands } from '../editor/store';

interface TimelineProps {
  state: TimelineState;
  commands: EditorCommands;
  playerRef: RefObject<PlayerRef | null>;
}

const TRACK_META: Record<TrackId, { color: string; kind: 'video' | 'audio' }> = {
  V2: { color: theme.trackVideo, kind: 'video' },
  V1: { color: theme.trackVideo, kind: 'video' },
  A1: { color: theme.trackAudioA1, kind: 'audio' },
  A2: { color: theme.trackAudioA2, kind: 'audio' },
};

const HEADER_W = 104;
const MIN_ROW = 34;
const RULER_H = 22;
const PX_PER_FRAME = 6;
const toolBtn: React.CSSProperties = { background: 'none', border: 'none', color: theme.textDim, cursor: 'pointer', fontSize: 14, padding: '2px 5px' };

function fmt(frames: number, fps: number): string {
  const s = frames / fps;
  const mm = Math.floor(s / 60);
  const ss = Math.floor(s % 60);
  const cs = Math.floor((s * 100) % 100);
  return `${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

type DragMode = 'move' | 'trim-left' | 'trim-right';
interface Drag {
  id: string; mode: DragMode; baseStart: number; baseDur: number; baseTrack: TrackId;
  startX: number; deltaF: number; targetTrack: TrackId;
}

export function Timeline({ state, commands, playerRef }: TimelineProps) {
  const total = timelineDuration(state);
  const innerW = HEADER_W + total * PX_PER_FRAME + 240;
  const [playhead, setPlayhead] = useState(0);
  const [drag, setDrag] = useState<Drag | null>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [rowH, setRowH] = useState(38);

  // tracks fill the timeline's height: split the scroll area (minus the ruler)
  // among the tracks so dragging the timeline taller grows every row to match.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const measure = () => setRowH(Math.max(MIN_ROW, (el.clientHeight - RULER_H) / TRACK_ORDER.length));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // sync playhead with the Remotion Player (follow playback + reflect seeks)
  useEffect(() => {
    let raf = 0;
    let detach: (() => void) | null = null;
    const attach = () => {
      const p = playerRef.current;
      if (!p) { raf = requestAnimationFrame(attach); return; }
      const onFrame = (e: { detail: { frame: number } }) => setPlayhead(e.detail.frame);
      p.addEventListener('frameupdate', onFrame);
      detach = () => p.removeEventListener('frameupdate', onFrame);
    };
    attach();
    return () => { if (raf) cancelAnimationFrame(raf); detach?.(); };
  }, [playerRef]);

  const frameFromClientX = (clientX: number): number => {
    const r = innerRef.current?.getBoundingClientRect();
    if (!r) return 0;
    return Math.max(0, Math.round((clientX - r.left - HEADER_W) / PX_PER_FRAME));
  };
  const trackFromClientY = (clientY: number): TrackId => {
    const r = innerRef.current?.getBoundingClientRect();
    if (!r) return 'V1';
    const idx = Math.floor((clientY - r.top - RULER_H) / rowH);
    return TRACK_ORDER[Math.min(Math.max(idx, 0), TRACK_ORDER.length - 1)];
  };

  const seekTo = (clientX: number) => {
    const f = Math.min(frameFromClientX(clientX), total - 1);
    playerRef.current?.seekTo(f);
    setPlayhead(f);
  };

  const startDrag = (e: React.PointerEvent, id: string, mode: DragMode, baseStart: number, baseDur: number, baseTrack: TrackId) => {
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    commands.selectItem(id);
    setDrag({ id, mode, baseStart, baseDur, baseTrack, startX: e.clientX, deltaF: 0, targetTrack: baseTrack });
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!drag) return;
    const deltaF = Math.round((e.clientX - drag.startX) / PX_PER_FRAME);
    const targetTrack = drag.mode === 'move' ? trackFromClientY(e.clientY) : drag.baseTrack;
    setDrag((d) => (d ? { ...d, deltaF, targetTrack } : d));
  };
  const onPointerUp = () => {
    if (!drag) { return; }
    const { id, mode, baseStart, baseDur, deltaF, targetTrack, baseTrack } = drag;
    if (mode === 'move') {
      // keep video clips on video tracks, audio clips on audio tracks
      const isAudio = state.items.find((it) => it.id === id)?.kind === 'audio';
      const okTrack = TRACK_META[targetTrack].kind === (isAudio ? 'audio' : 'video');
      const track = okTrack ? targetTrack : baseTrack;
      if (deltaF !== 0 || track !== baseTrack) commands.moveItem(id, { startFrame: Math.max(0, baseStart + deltaF), track });
    } else if (mode === 'trim-left') {
      const d = Math.min(deltaF, baseDur - 1);
      if (d !== 0) commands.setItemTiming(id, { startFrame: Math.max(0, baseStart + d), durationInFrames: baseDur - d });
    } else if (mode === 'trim-right') {
      if (deltaF !== 0) commands.setItemTiming(id, { durationInFrames: Math.max(1, baseDur + deltaF) });
    }
    setDrag(null);
  };

  return (
    <section style={{ borderTop: `1px solid ${theme.border}`, background: theme.panel, display: 'flex', flexDirection: 'column', minHeight: 0, overflow: 'hidden' }}>
      {/* toolbar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '6px 10px', borderBottom: `1px solid ${theme.border}` }}>
        <button style={toolBtn} title="播放" onClick={() => playerRef.current?.toggle()}>▶</button>
        <button style={{ ...toolBtn, color: theme.accent }}>⧉</button>
        <button style={toolBtn} title="复制选中" onClick={() => state.selectedId && commands.duplicateItem(state.selectedId)}>⧉</button>
        <button style={toolBtn} title="删除选中" onClick={() => state.selectedId && commands.removeItem(state.selectedId)}>🗑</button>
        <span style={{ flex: 1 }} />
        <span style={{ fontSize: 12, color: theme.text, fontVariantNumeric: 'tabular-nums' }}>{fmt(playhead, state.fps)} / {fmt(total, state.fps)}</span>
        <span style={{ flex: 1 }} />
        <button style={toolBtn}>🔍−</button>
        <button style={toolBtn}>🔍＋</button>
        <button style={toolBtn}>CC</button>
      </div>

      {/* scrollable ruler + tracks (playhead spans both) */}
      <div ref={scrollRef} style={{ overflow: 'auto', flex: 1, minHeight: 0 }} onPointerMove={onPointerMove} onPointerUp={onPointerUp}>
        <div ref={innerRef} style={{ position: 'relative', width: innerW }}>
          {/* ruler (click to seek) */}
          <div
            onPointerDown={(e) => seekTo(e.clientX)}
            style={{ display: 'flex', height: RULER_H, borderBottom: `1px solid ${theme.border}`, fontSize: 10, color: theme.textDim, cursor: 'text' }}
          >
            <div style={{ width: HEADER_W, flexShrink: 0 }} />
            <div style={{ position: 'relative', flex: 1 }}>
              {Array.from({ length: Math.ceil(total / (state.fps * 2)) + 1 }).map((_, i) => (
                <span key={i} style={{ position: 'absolute', left: i * state.fps * 2 * PX_PER_FRAME, top: 5 }}>{fmt(i * state.fps * 2, state.fps)}</span>
              ))}
            </div>
          </div>

          {/* tracks */}
          {TRACK_ORDER.map((trackId) => {
            const meta = TRACK_META[trackId];
            const items = state.items.filter((it) => it.track === trackId);
            const dragIsAudio = drag ? state.items.find((it) => it.id === drag.id)?.kind === 'audio' : false;
            const isDropTarget = drag?.mode === 'move' && drag.targetTrack === trackId && meta.kind === (dragIsAudio ? 'audio' : 'video');
            return (
              <div key={trackId} style={{ display: 'flex', height: rowH, borderBottom: `1px solid ${theme.border}`, background: isDropTarget ? '#1b2b1b' : undefined }}>
                <div style={{ width: HEADER_W, flexShrink: 0, display: 'flex', alignItems: 'center', gap: 5, padding: '0 8px', borderRight: `1px solid ${theme.border}`, background: theme.panel }}>
                  <span style={{ background: meta.color, color: '#fff', fontSize: 10, fontWeight: 700, borderRadius: 4, padding: '1px 5px' }}>{trackId}</span>
                  <span style={{ color: theme.textDim, fontSize: 11 }}>👁</span>
                  <span style={{ color: theme.textDim, fontSize: 11 }}>🔊</span>
                </div>
                <div style={{ flex: 1, position: 'relative', background: theme.bg }}>
                  {items.map((it) => {
                    const dragging = drag?.id === it.id;
                    const start = it.startFrame + (dragging && drag.mode !== 'trim-right' ? drag.deltaF : 0);
                    const durTrim = dragging && drag.mode === 'trim-left' ? -drag.deltaF : dragging && drag.mode === 'trim-right' ? drag.deltaF : 0;
                    const dur = Math.max(1, it.durationInFrames + durTrim);
                    const selected = state.selectedId === it.id;
                    return (
                      <div
                        key={it.id}
                        title={it.name}
                        onPointerDown={(e) => startDrag(e, it.id, 'move', it.startFrame, it.durationInFrames, it.track)}
                        style={{
                          position: 'absolute', left: Math.max(0, start) * PX_PER_FRAME, top: 4, height: rowH - 8, width: dur * PX_PER_FRAME,
                          background: meta.kind === 'video' ? theme.clipVideo : theme.clipAudio,
                          borderRadius: 5, color: '#fff', fontSize: 10.5,
                          display: 'flex', alignItems: 'center', padding: '0 10px', gap: 6, overflow: 'hidden', whiteSpace: 'nowrap',
                          border: selected ? '2px solid #fff' : '2px solid transparent',
                          cursor: 'grab', userSelect: 'none', touchAction: 'none',
                        }}
                      >
                        {/* trim handles */}
                        <div onPointerDown={(e) => startDrag(e, it.id, 'trim-left', it.startFrame, it.durationInFrames, it.track)}
                          style={{ position: 'absolute', left: 0, top: 0, width: 8, height: '100%', cursor: 'ew-resize', background: 'rgba(0,0,0,0.25)' }} />
                        <span style={{ pointerEvents: 'none' }}>✦ {it.name}</span>
                        <div onPointerDown={(e) => startDrag(e, it.id, 'trim-right', it.startFrame, it.durationInFrames, it.track)}
                          style={{ position: 'absolute', right: 0, top: 0, width: 8, height: '100%', cursor: 'ew-resize', background: 'rgba(0,0,0,0.25)' }} />
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}

          {/* playhead */}
          <div style={{ position: 'absolute', top: 0, left: HEADER_W + playhead * PX_PER_FRAME, width: 2, height: RULER_H + TRACK_ORDER.length * rowH, background: theme.accent, pointerEvents: 'none' }}>
            <div style={{ position: 'absolute', top: 0, left: -4, width: 10, height: 10, background: theme.accent, clipPath: 'polygon(0 0, 100% 0, 50% 100%)' }} />
          </div>
        </div>
      </div>
    </section>
  );
}
