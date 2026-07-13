import { useEffect, useRef, useState, type RefObject } from 'react';
import type { PlayerRef } from '@remotion/player';
import { theme } from '../theme';
import { MARKER_HEX, TRACK_ORDER, timelineDuration, type MarkerColor, type TimelineState, type TrackId } from '../editor/types';
import type { EditorCommands } from '../editor/store';
import { usePersistedState } from '../hooks/usePersistedState';

interface TimelineProps {
  state: TimelineState;
  commands: EditorCommands;
  playerRef: RefObject<PlayerRef | null>;
  playhead: number;
  setPlayhead: (frame: number) => void;
}

const TRACK_META: Record<TrackId, { color: string; kind: 'video' | 'audio' }> = {
  V2: { color: theme.trackVideo, kind: 'video' },
  V1: { color: theme.trackVideo, kind: 'video' },
  A1: { color: theme.trackAudioA1, kind: 'audio' },
  A2: { color: theme.trackAudioA2, kind: 'audio' },
};

const HEADER_W = 104;
const MIN_ROW = 30;
const RULER_H = 22;
// source weights tracks by type: video rows are taller than audio rows
// (videoTrackHeight > audioTrackHeight), not an equal split.
const WEIGHT: Record<'video' | 'audio', number> = { video: 1.4, audio: 1 };
const PX_PER_FRAME = 3; // default time scale (1s ≈ 90px @30fps) — compact by default
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
  baseSrcIn: number; startX: number; deltaF: number; targetTrack: TrackId; snapAt: number | null;
}
// how close (px) an edge must come to a snap target before it locks on
const SNAP_PX = 7;

export function Timeline({ state, commands, playerRef, playhead, setPlayhead }: TimelineProps) {
  const total = timelineDuration(state);
  const [zoom, setZoom] = usePersistedState('cc.timelineZoom', 1);
  const px = PX_PER_FRAME * zoom; // pixels per frame at the current time-zoom
  const zoomBy = (f: number) => setZoom((z) => Math.min(6, Math.max(0.5, z * f)));
  const [drag, setDrag] = useState<Drag | null>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [availH, setAvailH] = useState(190);
  const [availW, setAvailW] = useState(0);
  // content is at least as wide as the panel, so track rows/ruler never stop
  // short of the right edge when the project is short or zoomed out.
  const innerW = Math.max(HEADER_W + total * px + 240, availW);
  // vertical track-height zoom (source: trackHeightScale). 1 = weighted fill;
  // >1 makes rows taller than the panel (scrolls); Alt+wheel over the timeline.
  const [trackScale, setTrackScale] = usePersistedState('cc.trackScale', 1);

  // tracks fill the timeline's height, weighted by type (video taller than
  // audio) — resizing the timeline grows every row while keeping the ratio.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const measure = () => {
      setAvailH(el.clientHeight - RULER_H);
      setAvailW(el.clientWidth);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Ctrl/Cmd+wheel = time zoom anchored at the cursor (the frame under the
  // pointer stays put); Alt+wheel = track-height zoom. Native non-passive
  // listener: ctrl+wheel is the browser's page-zoom (and trackpad pinch), so
  // preventDefault must actually work — React's root wheel listener is passive.
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        const oldZoom = zoomRef.current;
        const next = Math.min(6, Math.max(0.5, oldZoom * (e.deltaY < 0 ? 1.12 : 1 / 1.12)));
        if (next === oldZoom) return;
        const viewX = e.clientX - el.getBoundingClientRect().left;
        const frame = (viewX + el.scrollLeft - HEADER_W) / (PX_PER_FRAME * oldZoom);
        setZoom(next);
        requestAnimationFrame(() => {
          el.scrollLeft = Math.max(0, frame * PX_PER_FRAME * next + HEADER_W - viewX);
        });
      } else if (e.altKey) {
        e.preventDefault();
        setTrackScale((z) => Math.min(3, Math.max(0.6, z * (e.deltaY < 0 ? 1.1 : 1 / 1.1))));
      }
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const totalWeight = TRACK_ORDER.reduce((sum, t) => sum + WEIGHT[TRACK_META[t].kind], 0);
  const unit = availH / totalWeight;
  const rowHeightOf = (t: TrackId) => Math.max(MIN_ROW, unit * WEIGHT[TRACK_META[t].kind] * trackScale);
  const tracksHeight = TRACK_ORDER.reduce((sum, t) => sum + rowHeightOf(t), 0);

  const frameFromClientX = (clientX: number): number => {
    const r = innerRef.current?.getBoundingClientRect();
    if (!r) return 0;
    return Math.max(0, Math.round((clientX - r.left - HEADER_W) / px));
  };
  const trackFromClientY = (clientY: number): TrackId => {
    const r = innerRef.current?.getBoundingClientRect();
    if (!r) return 'V1';
    let y = clientY - r.top - RULER_H;
    for (const t of TRACK_ORDER) {
      y -= rowHeightOf(t);
      if (y < 0) return t;
    }
    return TRACK_ORDER[TRACK_ORDER.length - 1];
  };

  const seekTo = (clientX: number) => {
    const f = Math.min(frameFromClientX(clientX), total - 1);
    playerRef.current?.seekTo(f);
    setPlayhead(f);
  };

  const seekFrame = (f: number) => {
    const c = Math.max(0, Math.min(f, total - 1));
    playerRef.current?.seekTo(c);
    setPlayhead(c);
  };

  // blade (B): split the selected clip at the playhead. splitItem no-ops if the
  // playhead is outside the clip, so no guard needed here.
  const bladeSelected = () => { if (state.selectedId) commands.splitItem(state.selectedId, playhead); };
  // markers (source manage_markers): add at the playhead + open its note editor
  const [editMarker, setEditMarker] = useState<string | null>(null);
  const markers = state.markers ?? [];
  const addMarkerAtPlayhead = () => setEditMarker(commands.addMarker(playhead));
  const gotoMarker = (dir: 1 | -1) => {
    const sorted = [...markers].filter((m) => m.scope === 'project').sort((a, b) => a.fromFrame - b.fromFrame);
    const next = dir === 1 ? sorted.find((m) => m.fromFrame > playhead) : [...sorted].reverse().find((m) => m.fromFrame < playhead);
    if (next) seekFrame(next.fromFrame);
  };
  // keyboard shortcuts (ref so the listener attaches once but reads fresh state)
  const kbRef = useRef({ bladeSelected, addMarkerAtPlayhead, gotoMarker });
  kbRef.current = { bladeSelected, addMarkerAtPlayhead, gotoMarker };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') return;
      const k = e.key.toLowerCase();
      if (k === 'b') { e.preventDefault(); kbRef.current.bladeSelected(); }
      else if (k === 'm') { e.preventDefault(); kbRef.current.addMarkerAtPlayhead(); }
      else if (e.key === '[') { e.preventDefault(); kbRef.current.gotoMarker(-1); }
      else if (e.key === ']') { e.preventDefault(); kbRef.current.gotoMarker(1); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const startDrag = (e: React.PointerEvent, id: string, mode: DragMode, baseStart: number, baseDur: number, baseTrack: TrackId, baseSrcIn = 0) => {
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    commands.selectItem(id);
    setDrag({ id, mode, baseStart, baseDur, baseTrack, baseSrcIn, startX: e.clientX, deltaF: 0, targetTrack: baseTrack, snapAt: null });
  };
  // snap a dragged edge to the nearest guide (frame 0, playhead, any other
  // clip's start/end) within SNAP_PX; returns the adjusted delta + snap frame.
  const applySnap = (mode: DragMode, baseStart: number, baseDur: number, rawDelta: number): { deltaF: number; snapAt: number | null } => {
    const thresh = SNAP_PX / px; // pixels → frames
    const targets = [0, playhead];
    for (const it of state.items) {
      if (it.id === drag?.id) continue;
      targets.push(it.startFrame, it.startFrame + it.durationInFrames);
    }
    for (const m of markers) targets.push(m.fromFrame); // markers are snap points too
    const nearest = (edge: number): number | null => {
      let best: number | null = null, bestDist = thresh;
      for (const t of targets) {
        const dist = Math.abs(edge - t);
        if (dist <= bestDist) { bestDist = dist; best = t; }
      }
      return best;
    };
    if (mode === 'trim-left') {
      const snap = nearest(baseStart + rawDelta);
      return snap === null ? { deltaF: rawDelta, snapAt: null } : { deltaF: snap - baseStart, snapAt: snap };
    }
    if (mode === 'trim-right') {
      const snap = nearest(baseStart + baseDur + rawDelta);
      return snap === null ? { deltaF: rawDelta, snapAt: null } : { deltaF: snap - (baseStart + baseDur), snapAt: snap };
    }
    // move: snap whichever of the clip's two edges lands closest to a guide
    const s0 = baseStart + rawDelta, e0 = baseStart + baseDur + rawDelta;
    const snapS = nearest(s0), snapE = nearest(e0);
    const dS = snapS === null ? Infinity : Math.abs(s0 - snapS);
    const dE = snapE === null ? Infinity : Math.abs(e0 - snapE);
    if (dS <= dE && snapS !== null) return { deltaF: snapS - baseStart, snapAt: snapS };
    if (snapE !== null) return { deltaF: snapE - (baseStart + baseDur), snapAt: snapE };
    return { deltaF: rawDelta, snapAt: null };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!drag) return;
    const rawDelta = Math.round((e.clientX - drag.startX) / px);
    const { deltaF, snapAt } = applySnap(drag.mode, drag.baseStart, drag.baseDur, rawDelta);
    const targetTrack = drag.mode === 'move' ? trackFromClientY(e.clientY) : drag.baseTrack;
    setDrag((d) => (d ? { ...d, deltaF, targetTrack, snapAt } : d));
  };
  const onPointerUp = () => {
    if (!drag) { return; }
    const { id, mode, baseStart, baseDur, baseSrcIn, deltaF, targetTrack, baseTrack } = drag;
    if (mode === 'move') {
      // keep video clips on video tracks, audio clips on audio tracks
      const isAudio = state.items.find((it) => it.id === id)?.kind === 'audio';
      const okTrack = TRACK_META[targetTrack].kind === (isAudio ? 'audio' : 'video');
      const track = okTrack ? targetTrack : baseTrack;
      if (deltaF !== 0 || track !== baseTrack) commands.moveItem(id, { startFrame: Math.max(0, baseStart + deltaF), track });
    } else if (mode === 'trim-left') {
      // clamp so the source in-point can't go negative (limits how far left media extends)
      const d = Math.max(Math.min(deltaF, baseDur - 1), -baseSrcIn);
      if (d !== 0) commands.setItemTiming(id, { startFrame: Math.max(0, baseStart + d), durationInFrames: baseDur - d, srcInFrame: baseSrcIn + d });
    } else if (mode === 'trim-right') {
      if (deltaF !== 0) commands.setItemTiming(id, { durationInFrames: Math.max(1, baseDur + deltaF) });
    }
    setDrag(null);
  };

  const editing = markers.find((m) => m.id === editMarker) ?? null;

  return (
    <section style={{ flex: 1, borderTop: `1px solid ${theme.border}`, background: theme.panel, display: 'flex', flexDirection: 'column', minHeight: 0, overflow: 'hidden', position: 'relative' }}>
      {/* marker note editor (source: click a pin → note popup) */}
      {editing && (
        <div style={{ position: 'absolute', top: 40, left: 12, zIndex: 20, width: 260, background: theme.panelAlt, border: `1px solid ${theme.border}`, borderRadius: 10, padding: 12, boxShadow: '0 8px 28px rgba(0,0,0,0.45)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8, fontSize: 12, color: theme.textDim }}>
            <svg width="12" height="14" viewBox="0 0 24 24" fill={MARKER_HEX[editing.color]}><path d="M19 21l-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" /></svg>
            标记 · {fmt(editing.fromFrame, state.fps)}
          </div>
          <textarea autoFocus value={editing.note} onChange={(e) => commands.updateMarker(editing.id, { note: e.target.value })} rows={3} placeholder="批注…"
            style={{ width: '100%', resize: 'vertical', background: theme.bg, color: theme.text, border: `1px solid ${theme.borderLight}`, borderRadius: 6, padding: '6px 8px', fontSize: 12, fontFamily: 'inherit' }} />
          <div style={{ display: 'flex', gap: 6, margin: '9px 0' }}>
            {(Object.keys(MARKER_HEX) as MarkerColor[]).map((c) => (
              <button key={c} onClick={() => commands.updateMarker(editing.id, { color: c })} title={c}
                style={{ width: 16, height: 16, borderRadius: '50%', background: MARKER_HEX[c], border: editing.color === c ? '2px solid #fff' : '2px solid transparent', cursor: 'pointer', padding: 0 }} />
            ))}
          </div>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 9, fontSize: 12, color: theme.textDim }}>
            <span>时长</span>
            <input type="number" min={0} step={0.1} value={+(editing.durationFrames / state.fps).toFixed(2)}
              onChange={(e) => commands.updateMarker(editing.id, { durationFrames: Math.max(0, Math.round(Number(e.target.value) * state.fps)) })}
              style={{ width: 56, background: theme.bg, color: theme.text, border: `1px solid ${theme.borderLight}`, borderRadius: 6, padding: '3px 6px', fontSize: 12 }} />
            <span>秒{editing.durationFrames > 0 ? '（区间）' : '（点）'}</span>
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <button onClick={() => { commands.removeMarker(editing.id); setEditMarker(null); }} style={{ ...toolBtn, color: theme.accent, fontSize: 12 }}>删除</button>
            <span style={{ flex: 1 }} />
            <button onClick={() => setEditMarker(null)} style={{ background: theme.accent, border: 'none', borderRadius: 6, color: '#fff', cursor: 'pointer', fontSize: 12, padding: '4px 12px' }}>完成</button>
          </div>
        </div>
      )}
      {/* toolbar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '6px 10px', borderBottom: `1px solid ${theme.border}` }}>
        <button style={toolBtn} title="播放" onClick={() => playerRef.current?.toggle()}>▶</button>
        <button style={{ ...toolBtn, color: theme.accent }}>⧉</button>
        <button style={toolBtn} title="复制选中" onClick={() => state.selectedId && commands.duplicateItem(state.selectedId)}>⧉</button>
        <button style={toolBtn} title="刀片：在播放头处切分选中片段 (B)" onClick={bladeSelected}>✂</button>
        <button style={{ ...toolBtn, fontWeight: 700 }} title="加文字（在播放头，V2 轨）" onClick={() => commands.addTextClip({ startFrame: playhead })}>T＋</button>
        <button style={toolBtn} title="上一个标记 (【)" onClick={() => gotoMarker(-1)}>◃</button>
        <button style={toolBtn} title="加标记（在播放头，M）" onClick={addMarkerAtPlayhead}>🔖</button>
        <button style={toolBtn} title="下一个标记 (】)" onClick={() => gotoMarker(1)}>▹</button>
        <button style={toolBtn} title="删除选中" onClick={() => state.selectedId && commands.removeItem(state.selectedId)}>🗑</button>
        <span style={{ flex: 1 }} />
        <span style={{ fontSize: 12, color: theme.text, fontVariantNumeric: 'tabular-nums' }}>{fmt(playhead, state.fps)} / {fmt(total, state.fps)}</span>
        <span style={{ flex: 1 }} />
        <button style={toolBtn} title="缩小时间轴" onClick={() => zoomBy(1 / 1.4)}>🔍−</button>
        <button style={toolBtn} title="放大时间轴" onClick={() => zoomBy(1.4)}>🔍＋</button>
        <button style={toolBtn} title="重置缩放" onClick={() => setZoom(1)}>{Math.round(zoom * 100)}%</button>
      </div>

      {/* scrollable ruler + tracks (playhead spans both). Ctrl/⌘+wheel = time
          zoom at cursor, Alt+wheel = track-height zoom (native listener above). */}
      <div ref={scrollRef} style={{ overflow: 'auto', flex: 1, minHeight: 0 }} onPointerMove={onPointerMove} onPointerUp={onPointerUp}
        title="Ctrl/⌘+滚轮 缩放时间轴 · Alt+滚轮 缩放轨道高度">
        <div ref={innerRef} style={{ position: 'relative', width: innerW }}>
          {/* ruler (click to seek) */}
          <div
            onPointerDown={(e) => seekTo(e.clientX)}
            style={{ display: 'flex', height: RULER_H, borderBottom: `1px solid ${theme.border}`, fontSize: 10, color: theme.textDim, cursor: 'text' }}
          >
            <div style={{ width: HEADER_W, flexShrink: 0 }} />
            <div style={{ position: 'relative', flex: 1 }}>
              {/* ticks span the whole visible width, not just the content */}
              {Array.from({ length: Math.ceil((innerW - HEADER_W) / px / (state.fps * 2)) + 1 }).map((_, i) => (
                <span key={i} style={{ position: 'absolute', left: i * state.fps * 2 * px, top: 5 }}>{fmt(i * state.fps * 2, state.fps)}</span>
              ))}
              {/* marker layer (source: bookmark pins over the ruler; range bar to the right) */}
              {markers.filter((m) => m.scope === 'project').map((m) => (
                <div key={m.id} style={{ position: 'absolute', left: m.fromFrame * px, top: 0, zIndex: 4, pointerEvents: 'none' }}>
                  {m.durationFrames > 0 && (
                    <div style={{ position: 'absolute', left: 0, top: 12, height: 4, width: Math.max(4, m.durationFrames * px), background: MARKER_HEX[m.color], borderRadius: 2, opacity: 0.85 }} />
                  )}
                  <button onPointerDown={(e) => e.stopPropagation()} onClick={() => setEditMarker(m.id)} title={m.note || '标记'}
                    style={{ pointerEvents: 'auto', position: 'absolute', left: 0, top: -1, transform: 'translateX(-50%)', background: 'none', border: 'none', cursor: 'pointer', padding: 0, lineHeight: 0 }}>
                    <svg width="13" height="15" viewBox="0 0 24 24" fill={MARKER_HEX[m.color]} stroke="rgba(0,0,0,0.9)" strokeWidth="1.6" style={{ display: 'block' }}>
                      <path d="M19 21l-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
                    </svg>
                  </button>
                </div>
              ))}
            </div>
          </div>

          {/* tracks */}
          {TRACK_ORDER.map((trackId) => {
            const meta = TRACK_META[trackId];
            const items = state.items.filter((it) => it.track === trackId);
            const dragIsAudio = drag ? state.items.find((it) => it.id === drag.id)?.kind === 'audio' : false;
            const isDropTarget = drag?.mode === 'move' && drag.targetTrack === trackId && meta.kind === (dragIsAudio ? 'audio' : 'video');
            const hidden = state.tracks?.[trackId]?.hidden ?? false;
            const muted = state.tracks?.[trackId]?.muted ?? false;
            const flagBtn = (active: boolean): React.CSSProperties => ({ background: 'none', border: 'none', cursor: 'pointer', fontSize: 11, padding: 0, lineHeight: 1, color: theme.textDim, opacity: active ? 0.35 : 1 });
            return (
              <div key={trackId} style={{ display: 'flex', height: rowHeightOf(trackId), borderBottom: `1px solid ${theme.border}`, background: isDropTarget ? '#1b2b1b' : undefined }}>
                <div style={{ width: HEADER_W, flexShrink: 0, display: 'flex', alignItems: 'center', gap: 5, padding: '0 8px', borderRight: `1px solid ${theme.border}`, background: theme.panel }}>
                  <span style={{ background: meta.color, color: '#fff', fontSize: 10, fontWeight: 700, borderRadius: 4, padding: '1px 5px' }}>{trackId}</span>
                  <button style={flagBtn(hidden)} title={hidden ? '显示轨道' : '隐藏轨道'} onClick={() => commands.toggleTrackFlag(trackId, 'hidden')}>{hidden ? '🚫' : '👁'}</button>
                  <button style={flagBtn(muted)} title={muted ? '取消静音' : '静音轨道'} onClick={() => commands.toggleTrackFlag(trackId, 'muted')}>{muted ? '🔇' : '🔊'}</button>
                </div>
                <div style={{ flex: 1, position: 'relative', background: theme.bg, opacity: hidden ? 0.4 : 1 }}>
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
                        onPointerDown={(e) => startDrag(e, it.id, 'move', it.startFrame, it.durationInFrames, it.track, it.srcInFrame ?? 0)}
                        style={{
                          position: 'absolute', left: Math.max(0, start) * px, top: 4, height: rowHeightOf(trackId) - 8, width: dur * px,
                          background: meta.kind === 'video' ? theme.clipVideo : theme.clipAudio,
                          borderRadius: 5, color: '#fff', fontSize: 10.5,
                          display: 'flex', alignItems: 'center', padding: '0 10px', gap: 6, overflow: 'hidden', whiteSpace: 'nowrap',
                          border: selected ? '2px solid #fff' : '2px solid transparent',
                          cursor: 'grab', userSelect: 'none', touchAction: 'none',
                        }}
                      >
                        {/* trim handles */}
                        <div onPointerDown={(e) => startDrag(e, it.id, 'trim-left', it.startFrame, it.durationInFrames, it.track, it.srcInFrame ?? 0)}
                          style={{ position: 'absolute', left: 0, top: 0, width: 8, height: '100%', cursor: 'ew-resize', background: 'rgba(0,0,0,0.25)' }} />
                        <span style={{ pointerEvents: 'none' }}>✦ {it.name}</span>
                        <div onPointerDown={(e) => startDrag(e, it.id, 'trim-right', it.startFrame, it.durationInFrames, it.track, it.srcInFrame ?? 0)}
                          style={{ position: 'absolute', right: 0, top: 0, width: 8, height: '100%', cursor: 'ew-resize', background: 'rgba(0,0,0,0.25)' }} />
                      </div>
                    );
                  })}
                  {/* transition badges at each cut on this track */}
                  {(state.transitions ?? []).filter((t) => t.trackId === trackId).map((t) => {
                    const inItem = state.items.find((it) => it.id === t.incomingItemId);
                    if (!inItem) return null;
                    return (
                      <div key={t.id} title={`转场:${t.type} · ${(t.durationInFrames / state.fps).toFixed(1)}s`}
                        onClick={() => commands.selectItem(t.incomingItemId)}
                        style={{ position: 'absolute', top: '50%', left: inItem.startFrame * px, transform: 'translate(-50%, -50%)', width: 15, height: 15, borderRadius: 3, background: '#3a3f52', border: '1px solid #6b7bb5', color: '#cfe3ff', fontSize: 10, display: 'grid', placeItems: 'center', cursor: 'pointer', zIndex: 3 }}>
                        ⧓
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}

          {/* snap guide — appears while a drag edge is locked onto a target */}
          {drag && drag.snapAt !== null && (
            <div style={{ position: 'absolute', top: 0, left: HEADER_W + drag.snapAt * px, width: 1, height: RULER_H + tracksHeight, background: '#4fd1ff', pointerEvents: 'none', boxShadow: '0 0 4px #4fd1ff' }} />
          )}

          {/* playhead */}
          <div style={{ position: 'absolute', top: 0, left: HEADER_W + playhead * px, width: 2, height: RULER_H + tracksHeight, background: theme.accent, pointerEvents: 'none' }}>
            <div style={{ position: 'absolute', top: 0, left: -4, width: 10, height: 10, background: theme.accent, clipPath: 'polygon(0 0, 100% 0, 50% 100%)' }} />
          </div>
        </div>
      </div>
    </section>
  );
}
