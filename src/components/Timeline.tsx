import { useEffect, useRef, useState, type RefObject } from 'react';
import type { PlayerRef } from '@remotion/player';
import { theme } from '../theme';
import { MARKER_HEX, TRACK_ORDER, timelineDuration, type MarkerColor, type TimelineState, type TrackId } from '../editor/types';
import type { EditorCommands } from '../editor/store';
import { usePersistedState } from '../hooks/usePersistedState';
import { ClipContextMenu, type FxClip } from './ClipContextMenu';
import { Icon, type IconName } from './icons';
import { useRecorder } from '../audio/recorder';

interface TimelineProps {
  state: TimelineState;
  commands: EditorCommands;
  playerRef: RefObject<PlayerRef | null>;
  playhead: number;
  setPlayhead: (frame: number) => void;
  /** record a mic voiceover → upload the blob → drop it on an audio track */
  onRecordVoiceover?: (blob: Blob) => void;
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

// vertical divider between toolbar tool groups (source-style grouping)
function ToolSep() {
  return <span style={{ width: 1, height: 16, background: theme.border, margin: '0 4px', flexShrink: 0 }} />;
}

// one icon toolbar button (source: monochrome line glyphs, active = accent)
function TB({ icon, title, onClick, active, disabled }: {
  icon: IconName; title: string; onClick?: () => void; active?: boolean; disabled?: boolean;
}) {
  return (
    <button title={title} onClick={onClick} disabled={disabled}
      style={{ background: 'none', border: 'none', cursor: disabled ? 'default' : 'pointer', padding: '5px 6px', borderRadius: 5, display: 'grid', placeItems: 'center', lineHeight: 0, color: disabled ? theme.textDim : active ? theme.accent : theme.text, opacity: disabled ? 0.4 : 1 }}
      onMouseEnter={(e) => { if (!disabled && !active) e.currentTarget.style.background = theme.panelAlt; }}
      onMouseLeave={(e) => { e.currentTarget.style.background = 'none'; }}>
      <Icon name={icon} />
    </button>
  );
}

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

export function Timeline({ state, commands, playerRef, playhead, setPlayhead, onRecordVoiceover }: TimelineProps) {
  const total = timelineDuration(state);
  const [zoom, setZoom] = usePersistedState('cc.timelineZoom', 1);
  const px = PX_PER_FRAME * zoom; // pixels per frame at the current time-zoom
  const zoomBy = (f: number) => setZoom((z) => Math.min(6, Math.max(0.5, z * f)));
  // editing mode (source: Selection V / Blade B / Trim T). selection = drag/move;
  // blade = click a clip to cut it there; trim = edge-trim ripples following clips.
  const [editMode, setEditMode] = usePersistedState<'selection' | 'blade' | 'trim'>('cc.editMode', 'selection');
  // magnetic snapping (source: Snapping toggle, S). On = edges lock to guides.
  const [snapping, setSnapping] = usePersistedState('cc.snapping', true);
  // mic voiceover recording (source: 录制旁白). Toggle to start/stop; the blob
  // is uploaded + dropped on an audio track by the parent.
  const recorder = useRecorder(onRecordVoiceover ?? (() => {}));
  // fit whole timeline to the viewport width (source: Fit to view, ⇧Z)
  const fitToView = () => {
    const w = scrollRef.current?.clientWidth ?? 0;
    if (w <= HEADER_W || total <= 0) return;
    setZoom(Math.min(6, Math.max(0.5, (w - HEADER_W - 24) / (total * PX_PER_FRAME))));
    if (scrollRef.current) scrollRef.current.scrollLeft = 0;
  };
  const [drag, setDrag] = useState<Drag | null>(null);
  // clip right-click menu + effect clipboard (source: 复制效果/粘贴效果)
  const [ctxMenu, setCtxMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const [fxClip, setFxClip] = useState<FxClip | null>(null);
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
  const kb = { bladeSelected, addMarkerAtPlayhead, gotoMarker, fitToView, toggleSnap: () => setSnapping((s) => !s), setEditMode };
  const kbRef = useRef(kb);
  kbRef.current = kb;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') return;
      if (e.metaKey || e.ctrlKey) return; // leave undo/redo etc. to Editor
      const k = e.key.toLowerCase();
      if (k === 'v') { e.preventDefault(); kbRef.current.setEditMode('selection'); }
      else if (k === 'b') { e.preventDefault(); kbRef.current.setEditMode('blade'); }
      else if (k === 't') { e.preventDefault(); kbRef.current.setEditMode('trim'); }
      else if (k === 'c') { e.preventDefault(); kbRef.current.bladeSelected(); }
      else if (k === 'm') { e.preventDefault(); kbRef.current.addMarkerAtPlayhead(); }
      else if (k === 's') { e.preventDefault(); kbRef.current.toggleSnap(); }
      else if (k === 'z' && e.shiftKey) { e.preventDefault(); kbRef.current.fitToView(); }
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
    if (!snapping) return { deltaF: rawDelta, snapAt: null };
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
      const newDur = Math.max(1, baseDur + deltaF);
      const actual = newDur - baseDur;
      if (actual !== 0) {
        if (editMode === 'trim') {
          // ripple: retime this clip + slide every later same-track clip by the
          // duration change (one atomic step via applyState, so it's a single undo)
          const clipEnd = baseStart + baseDur;
          const items = state.items.map((it) =>
            it.id === id ? { ...it, durationInFrames: newDur }
              : it.track === baseTrack && it.startFrame >= clipEnd ? { ...it, startFrame: it.startFrame + actual }
              : it,
          );
          commands.applyState({ ...state, items });
        } else {
          commands.setItemTiming(id, { durationInFrames: newDur });
        }
      }
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
      {/* toolbar — source layout+icons (entry.js:178857-859): 左编辑·中传输·右视图.
          Modes we don't have (选择/修剪/录音) render disabled like the source greys them. */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 2, padding: '6px 10px', borderBottom: `1px solid ${theme.border}` }}>
        {/* left: edit tools (source order: +/cursor/trim/blade/snap/mic) */}
        <TB icon="plus" title="新建序列" onClick={() => commands.createTimeline()} />
        <TB icon="cursor" title="选择模式 (V)：拖动移动 / 裁剪首尾" active={editMode === 'selection'} onClick={() => setEditMode('selection')} />
        <TB icon="trim" title="修剪模式 (T)：裁剪片段边缘，后续片段自动跟随合缝（波纹）" active={editMode === 'trim'} onClick={() => setEditMode('trim')} />
        <TB icon="blade" title="刀片模式 (B)：点击片段在该处切分" active={editMode === 'blade'} onClick={() => setEditMode('blade')} />
        <TB icon="scissors" title="在播放头切分选中片段 (C)" onClick={bladeSelected} />
        <TB icon="magnet" title={`磁性吸附：${snapping ? '开' : '关'} (S)`} active={snapping} onClick={() => setSnapping((s) => !s)} />
        <TB icon="mic" active={recorder.recording}
          title={recorder.recording ? '● 录音中，点击停止' : recorder.error ? `录音失败：${recorder.error}` : '录制旁白（麦克风 → 音频轨）'}
          disabled={!onRecordVoiceover} onClick={recorder.toggle} />
        {recorder.recording && <span title="录音中" style={{ width: 8, height: 8, borderRadius: '50%', background: theme.accent, boxShadow: `0 0 0 0 ${theme.accent}`, animation: 'cc-rec-pulse 1.2s ease-out infinite', flexShrink: 0 }} />}
        {!recorder.recording && recorder.error && <span title={recorder.error} style={{ fontSize: 10.5, color: theme.accent, maxWidth: 96, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{recorder.error}</span>}
        <ToolSep />
        <TB icon="text" title="加文字（在播放头，V2 轨）" onClick={() => commands.addTextClip({ startFrame: playhead })} />
        <TB icon="copy" title="复制选中" onClick={() => state.selectedId && commands.duplicateItem(state.selectedId)} />
        <TB icon="trash" title="删除选中" onClick={() => state.selectedId && commands.removeItem(state.selectedId)} />
        <ToolSep />
        <TB icon="prev" title="上一个标记 (【)" onClick={() => gotoMarker(-1)} />
        <TB icon="bookmark" title="加标记（在播放头，M）" onClick={addMarkerAtPlayhead} />
        <TB icon="next" title="下一个标记 (】)" onClick={() => gotoMarker(1)} />
        <span style={{ flex: 1 }} />
        {/* center: transport + timecode */}
        <TB icon="play" title="播放 / 暂停 (空格)" onClick={() => playerRef.current?.toggle()} />
        <span style={{ fontSize: 12.5, color: theme.text, fontVariantNumeric: 'tabular-nums', minWidth: 132, textAlign: 'center', letterSpacing: 0.2 }}>{fmt(playhead, state.fps)} / {fmt(total, state.fps)}</span>
        <span style={{ flex: 1 }} />
        {/* right: view tools (zoom out · slider · zoom in · fit · reset) */}
        <TB icon="zoomOut" title="缩小时间轴 (⌘−)" onClick={() => zoomBy(1 / 1.4)} />
        <input type="range" min={0.5} max={6} step={0.01} value={zoom} onChange={(e) => setZoom(Number(e.target.value))}
          title="缩放时间轴" style={{ width: 92, accentColor: theme.accent, cursor: 'pointer' }} />
        <TB icon="zoomIn" title="放大时间轴 (⌘＋)" onClick={() => zoomBy(1.4)} />
        <TB icon="fit" title="适应宽度 (⇧Z)" onClick={fitToView} />
        <button style={{ ...toolBtn, minWidth: 44, fontSize: 12, color: theme.textDim }} title="重置缩放 (100%)" onClick={() => setZoom(1)}>{Math.round(zoom * 100)}%</button>
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
            <div style={{ width: HEADER_W, flexShrink: 0, position: 'sticky', left: 0, zIndex: 6, background: theme.panel, borderRight: `1px solid ${theme.border}` }} />
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
                <div style={{ width: HEADER_W, flexShrink: 0, position: 'sticky', left: 0, zIndex: 5, display: 'flex', alignItems: 'center', gap: 5, padding: '0 8px', borderRight: `1px solid ${theme.border}`, background: theme.panel }}>
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
                        onPointerDown={(e) => {
                          if (editMode === 'blade') { // blade mode: click cuts the clip here
                            e.stopPropagation();
                            const f = Math.round(frameFromClientX(e.clientX));
                            if (f > it.startFrame && f < it.startFrame + it.durationInFrames) commands.splitItem(it.id, f);
                            return;
                          }
                          startDrag(e, it.id, 'move', it.startFrame, it.durationInFrames, it.track, it.srcInFrame ?? 0);
                        }}
                        onContextMenu={(e) => { e.preventDefault(); commands.selectItem(it.id); setCtxMenu({ id: it.id, x: e.clientX, y: e.clientY }); }}
                        style={{
                          position: 'absolute', left: Math.max(0, start) * px, top: 4, height: rowHeightOf(trackId) - 8, width: dur * px,
                          background: meta.kind === 'video' ? theme.clipVideo : theme.clipAudio,
                          borderRadius: 5, color: '#fff', fontSize: 10.5,
                          display: 'flex', alignItems: 'center', padding: '0 10px', gap: 6, overflow: 'hidden', whiteSpace: 'nowrap',
                          border: selected ? '2px solid #fff' : '2px solid transparent',
                          cursor: editMode === 'blade' ? 'crosshair' : 'grab', userSelect: 'none', touchAction: 'none',
                        }}
                      >
                        {/* trim handles (hidden in blade mode) */}
                        {editMode !== 'blade' && <div onPointerDown={(e) => startDrag(e, it.id, 'trim-left', it.startFrame, it.durationInFrames, it.track, it.srcInFrame ?? 0)}
                          style={{ position: 'absolute', left: 0, top: 0, width: 8, height: '100%', cursor: 'ew-resize', background: editMode === 'trim' ? 'rgba(240,86,46,0.5)' : 'rgba(0,0,0,0.25)' }} />}
                        <span style={{ pointerEvents: 'none' }}>✦ {it.name}</span>
                        {editMode !== 'blade' && <div onPointerDown={(e) => startDrag(e, it.id, 'trim-right', it.startFrame, it.durationInFrames, it.track, it.srcInFrame ?? 0)}
                          style={{ position: 'absolute', right: 0, top: 0, width: 8, height: '100%', cursor: 'ew-resize', background: editMode === 'trim' ? 'rgba(240,86,46,0.5)' : 'rgba(0,0,0,0.25)' }} />}
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

      {/* clip right-click menu (source Hyt) */}
      {ctxMenu && (() => {
        const item = state.items.find((it) => it.id === ctxMenu.id);
        if (!item) return null;
        return (
          <ClipContextMenu item={item} x={ctxMenu.x} y={ctxMenu.y} playhead={playhead} commands={commands}
            fxClip={fxClip} onCopyFx={setFxClip} onClose={() => setCtxMenu(null)} />
        );
      })()}
    </section>
  );
}
