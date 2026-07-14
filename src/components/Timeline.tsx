import { useEffect, useRef, useState, type RefObject } from 'react';
import type { PlayerRef } from '@remotion/player';
import { theme } from '../theme';
import { MARKER_HEX, defaultTrackId, timelineDuration, timelineTrackIds, trackAlias, trackKind, type MarkerColor, type TimelineItem, type TimelineState, type TrackId } from '../editor/types';
import type { EditorCommands } from '../editor/store';
import { usePersistedState } from '../hooks/usePersistedState';
import { ClipContextMenu, type FxClip } from './ClipContextMenu';
import { Icon, type IconName } from './icons';
import { useRecorder } from '../audio/recorder';
import { exportClipMov, bakeClipToVideo } from '../media/clipExport';
import { buildTranslation } from '../captions/translate';
import { CAPTION_STYLES } from '../captions/styles';
import type { CaptionsData, CaptionTemplate } from '../captions/types';

interface TimelineProps {
  state: TimelineState;
  commands: EditorCommands;
  playerRef: RefObject<PlayerRef | null>;
  /** record a mic voiceover → upload the blob → drop it on an audio track */
  onRecordVoiceover?: (blob: Blob) => void;
}

const HEADER_W = 178;
const MIN_ROW = 34;
const RULER_H = 29;
// clip fill by ITEM kind — source --tl-item-* oklch (video/image=blue, audio=green,
// motion-graphic=pink, text=amber). Video/image also render a media thumbnail on top.
const CLIP_COLOR: Record<TimelineItem['kind'], string> = {
  video: theme.clipVideo, image: theme.clipVideo, audio: theme.clipAudio,
  'motion-graphic': theme.clipMg, text: theme.clipText,
};
// source weights tracks by type: video rows are taller than audio rows
// (videoTrackHeight > audioTrackHeight), not an equal split.
const WEIGHT: Record<'video' | 'audio', number> = { video: 1.4, audio: 1 };
const PX_PER_FRAME = 3; // default time scale (1s ≈ 90px @30fps) — compact by default
const toolBtn: React.CSSProperties = { background: 'none', border: 'none', color: theme.textDim, cursor: 'pointer', fontSize: 14, padding: '2px 5px' };
const CAPTION_LANGS = ['English', '简体中文', '西班牙语', '法语', '德语', '日语', '韩语', '葡萄牙语'];

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
      style={{ width: 34, height: 34, background: 'none', border: 'none', cursor: disabled ? 'default' : 'pointer', padding: 0, borderRadius: 5, display: 'grid', placeItems: 'center', lineHeight: 0, color: disabled ? theme.textDim : active ? theme.accent : '#c8c8c8', opacity: disabled ? 0.4 : 1 }}
      onMouseEnter={(e) => { if (!disabled && !active) e.currentTarget.style.background = theme.panelAlt; }}
      onMouseLeave={(e) => { e.currentTarget.style.background = 'none'; }}>
      <Icon name={icon} size={18} />
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

function fmtClock(frames: number, fps: number): string {
  const seconds = Math.floor(frames / fps);
  const hh = Math.floor(seconds / 3600);
  const mm = Math.floor((seconds % 3600) / 60);
  const ss = seconds % 60;
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
}

type DragMode = 'move' | 'trim-left' | 'trim-right';
interface Drag {
  id: string; mode: DragMode; baseStart: number; baseDur: number; baseTrack: TrackId;
  baseSrcIn: number; startX: number; deltaF: number; targetTrack: TrackId; snapAt: number | null;
}
// how close (px) an edge must come to a snap target before it locks on
const SNAP_PX = 7;

export function Timeline({ state, commands, playerRef, onRecordVoiceover }: TimelineProps) {
  const total = timelineDuration(state);
  const trackIds = timelineTrackIds(state);
  const metaOf = (id: TrackId) => {
    const kind = trackKind(state, id);
    return { kind, color: kind === 'video' ? theme.trackVideo : trackAlias(state, id) === 'A1' ? theme.trackAudioA1 : theme.trackAudioA2 };
  };
  const [zoom, setZoom] = usePersistedState('cc.timelineZoom', 1);
  const px = PX_PER_FRAME * zoom; // pixels per frame at the current time-zoom
  const playheadRef = useRef(0);
  const playheadLineRef = useRef<HTMLDivElement | null>(null);
  const toolbarTimecodeRef = useRef<HTMLSpanElement | null>(null);
  const rulerTimecodeRef = useRef<HTMLSpanElement | null>(null);
  const paintPlayhead = (frame: number) => {
    const current = Math.max(0, Math.round(frame));
    playheadRef.current = current;
    if (playheadLineRef.current) playheadLineRef.current.style.transform = `translateX(${HEADER_W + current * px}px)`;
    if (toolbarTimecodeRef.current) toolbarTimecodeRef.current.textContent = `${fmt(current, state.fps)} / ${fmt(total, state.fps)}`;
    if (rulerTimecodeRef.current) rulerTimecodeRef.current.textContent = fmtClock(current, state.fps);
  };
  const paintPlayheadRef = useRef(paintPlayhead);
  paintPlayheadRef.current = paintPlayhead;
  useEffect(() => {
    let raf = 0;
    let detach: (() => void) | null = null;
    const attach = () => {
      const player = playerRef.current;
      if (!player) { raf = requestAnimationFrame(attach); return; }
      const onFrame = (event: { detail: { frame: number } }) => paintPlayheadRef.current(event.detail.frame);
      player.addEventListener('frameupdate', onFrame);
      paintPlayheadRef.current(player.getCurrentFrame());
      detach = () => player.removeEventListener('frameupdate', onFrame);
    };
    attach();
    return () => { if (raf) cancelAnimationFrame(raf); detach?.(); };
  }, [playerRef]);
  useEffect(() => { paintPlayheadRef.current(playheadRef.current); }, [px, state.fps, total]);
  const zoomBy = (f: number) => setZoom((z) => Math.min(6, Math.max(0.5, z * f)));
  // editing mode (source: Selection V / Blade B / Trim N). selection = drag/move;
  // blade = click a clip to cut it there; trim = edge-trim ripples following clips.
  const [editMode, setEditMode] = usePersistedState<'selection' | 'blade' | 'trim'>('cc.editMode', 'selection');
  // magnetic snapping (source: Snapping toggle, S). On = edges lock to guides.
  const [snapping, setSnapping] = usePersistedState('cc.snapping', true);
  const captionsVisible = !!state.captions?.enabled;
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [captionMenu, setCaptionMenu] = useState<{ id: TrackId; left: number; top: number; translateOpen?: boolean } | null>(null);
  const [captionBusy, setCaptionBusy] = useState(false);
  const [captionError, setCaptionError] = useState<string | null>(null);
  useEffect(() => {
    if (!captionMenu) return;
    const close = (event: PointerEvent) => {
      const target = event.target as Element;
      if (!target.closest('.cc-caption-style-menu') && !target.closest('[data-caption-menu-trigger]')) setCaptionMenu(null);
    };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [captionMenu]);
  // mic voiceover recording (source: 录制旁白). Toggle to start/stop; the blob
  // is uploaded + dropped on an audio track by the parent.
  const recorder = useRecorder(onRecordVoiceover ?? (() => {}));
  const captionsForTrack = (trackId: TrackId): CaptionsData | null => {
    if (state.captions) return state.captions;
    const source = state.items.find((item) => item.track === trackId && item.transcript?.length);
    return source ? { enabled: true, template: 'plain', pacing: 'phrase', sourceItemId: source.id } : null;
  };
  const applyCaptionStyle = (trackId: TrackId, template: CaptionTemplate) => {
    const captions = captionsForTrack(trackId);
    if (!captions) { setCaptionError('该轨道还没有可用文字稿'); return; }
    if (state.captions) commands.updateCaptions({ enabled: true, template });
    else commands.setCaptions({ ...captions, template });
    setCaptionError(null);
    setCaptionMenu(null);
  };
  const toggleCaptions = (trackId: TrackId) => {
    if (state.captions) { commands.updateCaptions({ enabled: !state.captions.enabled }); return; }
    const captions = captionsForTrack(trackId);
    if (captions) commands.setCaptions(captions);
    else setCaptionError('该轨道还没有可用文字稿');
  };
  const translateCaptions = async (lang: string) => {
    if (captionBusy) return;
    const captions = captionMenu ? captionsForTrack(captionMenu.id) : state.captions;
    if (!captions) { setCaptionError('该轨道还没有可翻译的文字稿，请先完成转写'); return; }
    setCaptionBusy(true);
    setCaptionError(null);
    try {
      const translation = await buildTranslation(captions, state.items, state.fps, lang);
      const patch = { enabled: true, bilingual: true, translationLang: lang, translation };
      if (state.captions) commands.updateCaptions(patch);
      else commands.setCaptions({ ...captions, ...patch });
      setCaptionMenu(null);
    } catch (error) {
      setCaptionError(error instanceof Error ? error.message : '字幕翻译失败');
    } finally { setCaptionBusy(false); }
  };
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
  // single-clip render (导出 MG 动画 / 转为视频) status toast
  const [clipJob, setClipJob] = useState<{ msg: string; error?: boolean } | null>(null);
  const exportMg = async (it: TimelineItem) => {
    setClipJob({ msg: '导出 MG 动画中（ProRes 4444）…' });
    try { await exportClipMov(state, it); setClipJob(null); }
    catch (e) { setClipJob({ msg: e instanceof Error ? e.message : '导出失败', error: true }); }
  };
  const convertToVideo = async (it: TimelineItem) => {
    setClipJob({ msg: '转为视频中…' });
    try { const src = await bakeClipToVideo(state, it); commands.replaceItemMedia(it.id, src); setClipJob(null); }
    catch (e) { setClipJob({ msg: e instanceof Error ? e.message : '转换失败', error: true }); }
  };
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

  const expanded = trackIds.filter((id) => !state.tracks?.[id]?.collapsed);
  const collapsedHeight = (trackIds.length - expanded.length) * MIN_ROW;
  const totalWeight = expanded.reduce((sum, id) => sum + WEIGHT[metaOf(id).kind], 0);
  const unit = Math.max(0, availH - collapsedHeight) / Math.max(1, totalWeight);
  const rowHeightOf = (id: TrackId) => state.tracks?.[id]?.collapsed ? MIN_ROW : Math.max(MIN_ROW, unit * WEIGHT[metaOf(id).kind] * trackScale);
  const tracksHeight = trackIds.reduce((sum, id) => sum + rowHeightOf(id), 0);

  const frameFromClientX = (clientX: number): number => {
    const r = innerRef.current?.getBoundingClientRect();
    if (!r) return 0;
    return Math.max(0, Math.round((clientX - r.left - HEADER_W) / px));
  };
  const trackFromClientY = (clientY: number): TrackId => {
    const r = innerRef.current?.getBoundingClientRect();
    if (!r) return defaultTrackId(state, 'video') ?? defaultTrackId(state, 'audio') ?? '';
    let y = clientY - r.top - RULER_H;
    for (const t of trackIds) {
      y -= rowHeightOf(t);
      if (y < 0) return t;
    }
    return trackIds[trackIds.length - 1] ?? '';
  };

  const seekTo = (clientX: number) => {
    const f = Math.min(frameFromClientX(clientX), total - 1);
    playerRef.current?.seekTo(f);
    paintPlayhead(f);
  };

  const seekFrame = (f: number) => {
    const c = Math.max(0, Math.min(f, total - 1));
    playerRef.current?.seekTo(c);
    paintPlayhead(c);
  };

  // blade (B): split the selected clip at the playhead. splitItem no-ops if the
  // playhead is outside the clip, so no guard needed here.
  const bladeSelected = () => { if (state.selectedId) commands.splitItem(state.selectedId, playheadRef.current); };
  // markers (source manage_markers): add at the playhead + open its note editor
  const [editMarker, setEditMarker] = useState<string | null>(null);
  const markers = state.markers ?? [];
  const addMarkerAtPlayhead = () => setEditMarker(commands.addMarker(playheadRef.current));
  const gotoMarker = (dir: 1 | -1) => {
    const sorted = [...markers].filter((m) => m.scope === 'project').sort((a, b) => a.fromFrame - b.fromFrame);
    const next = dir === 1 ? sorted.find((m) => m.fromFrame > playheadRef.current) : [...sorted].reverse().find((m) => m.fromFrame < playheadRef.current);
    if (next) seekFrame(next.fromFrame);
  };
  // keyboard shortcuts (ref so the listener attaches once but reads fresh state)
  const rippleDeleteSelected = () => { if (state.selectedId) commands.rippleDeleteItem(state.selectedId); };
  const kb = { bladeSelected, addMarkerAtPlayhead, gotoMarker, fitToView, toggleSnap: () => setSnapping((s) => !s), setEditMode, rippleDeleteSelected };
  const kbRef = useRef(kb);
  kbRef.current = kb;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') return;
      if (e.metaKey || e.ctrlKey) return; // leave undo/redo etc. to Editor
      // ripple delete (source ⇧⌫): remove selected clip + close the gap
      if ((e.key === 'Backspace' || e.key === 'Delete') && e.shiftKey) { e.preventDefault(); kbRef.current.rippleDeleteSelected(); return; }
      const k = e.key.toLowerCase();
      if (k === 'v') { e.preventDefault(); kbRef.current.setEditMode('selection'); }
      else if (k === 'b') { e.preventDefault(); kbRef.current.setEditMode('blade'); }
      else if (k === 'n') { e.preventDefault(); kbRef.current.setEditMode('trim'); }
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
    if (state.tracks?.[baseTrack]?.locked) return;
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
    const targets = [0, playheadRef.current];
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
      const okTrack = !!targetTrack && trackKind(state, targetTrack) === (isAudio ? 'audio' : 'video') && !state.tracks?.[targetTrack]?.locked;
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
    <section className="cc-timeline" style={{ flex: 1, borderTop: `1px solid ${theme.border}`, background: '#121212', display: 'flex', flexDirection: 'column', minHeight: 0, overflow: 'hidden', position: 'relative' }}>
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
      <div className="cc-timeline-toolbar">
        <div className="cc-timeline-tool-group">
          <TB icon="plus" title="新建序列" onClick={() => commands.createTimeline()} />
          <ToolSep />
          <TB icon="cursor" title="选择模式 (V)：拖动移动 / 裁剪首尾" active={editMode === 'selection'} onClick={() => setEditMode('selection')} />
          <TB icon="trim" title="修剪模式 (N)：裁剪片段边缘，后续片段自动跟随合缝（波纹）" active={editMode === 'trim'} onClick={() => setEditMode('trim')} />
          <TB icon="blade" title="刀片模式 (B)：点击片段在该处切分" active={editMode === 'blade'} onClick={() => setEditMode('blade')} />
          <TB icon="scissors" title="在播放头切分选中片段 (C)" onClick={bladeSelected} />
          <TB icon="magnet" title={`磁性吸附：${snapping ? '开' : '关'} (S)`} active={snapping} onClick={() => setSnapping((s) => !s)} />
          <ToolSep />
          <span className="cc-mic-group">
            <TB icon="mic" active={recorder.recording}
              title={recorder.recording ? '● 录音中，点击停止' : recorder.error ? `录音失败：${recorder.error}` : '录制旁白（麦克风 → 音频轨）'}
              disabled={!onRecordVoiceover} onClick={recorder.toggle} />
            <Icon name="chevronDown" size={13} />
          </span>
          {recorder.recording && <span title="录音中" style={{ width: 8, height: 8, borderRadius: '50%', background: theme.accent, animation: 'cc-rec-pulse 1.2s ease-out infinite', flexShrink: 0 }} />}
        </div>
        <span style={{ flex: 1 }} />
        <TB icon="play" title="播放 / 暂停 (空格)" onClick={() => playerRef.current?.toggle()} />
        <span ref={toolbarTimecodeRef} className="cc-timeline-timecode">{fmt(playheadRef.current, state.fps)} / {fmt(total, state.fps)}</span>
        <span style={{ flex: 1 }} />
        <TB icon="zoomOut" title="缩小时间轴 (⌘−)" onClick={() => zoomBy(1 / 1.4)} />
        <input type="range" min={0.5} max={6} step={0.01} value={zoom} onChange={(e) => setZoom(Number(e.target.value))}
          title="缩放时间轴" className="cc-timeline-zoom" />
        <TB icon="zoomIn" title="放大时间轴 (⌘＋)" onClick={() => zoomBy(1.4)} />
        <TB icon="fit" title="适应宽度 (⇧Z)" onClick={fitToView} />
        <button className={`cc-caption-toggle${captionsVisible ? ' active' : ''}`} title="字幕显示" disabled={!state.captions} onClick={() => state.captions && commands.updateCaptions({ enabled: !captionsVisible })}><Icon name="captions" size={17} /><span>{captionsVisible ? '开启' : '关闭'}</span><Icon name="chevronDown" size={13} /></button>
        <TB icon="fullscreen" title="全屏时间线" onClick={() => { if (document.fullscreenElement) void document.exitFullscreen(); else void scrollRef.current?.requestFullscreen(); }} />
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
            <div className="cc-ruler-head" style={{ width: HEADER_W }}><span ref={rulerTimecodeRef}>{fmtClock(playheadRef.current, state.fps)}</span></div>
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
          {trackIds.map((trackId) => {
            const meta = metaOf(trackId);
            const alias = trackAlias(state, trackId);
            const config = state.tracks?.[trackId] ?? {};
            const items = state.items.filter((it) => it.track === trackId);
            const dragIsAudio = drag ? state.items.find((it) => it.id === drag.id)?.kind === 'audio' : false;
            const isDropTarget = drag?.mode === 'move' && drag.targetTrack === trackId && meta.kind === (dragIsAudio ? 'audio' : 'video') && !state.tracks?.[trackId]?.locked;
            const hidden = config.hidden ?? false;
            const muted = config.muted ?? false;
            const locked = config.locked ?? false;
            const collapsed = config.collapsed ?? false;
            const trackName = config.name || `${meta.kind === 'video' ? '视频' : '音频'} ${alias.slice(1)}`;
            const busy = items.length > 0 || (state.transitions ?? []).some((transition) => transition.trackId === trackId);
            const flagBtn = (active: boolean): React.CSSProperties => ({ width: 24, height: 24, display: 'grid', placeItems: 'center', background: 'none', border: 'none', cursor: 'pointer', padding: 0, color: '#c2c2c2', opacity: active ? 0.35 : 1 });
            return (
              <div key={trackId} className="cc-track-row" style={{ height: rowHeightOf(trackId), background: isDropTarget ? '#1b2b1b' : undefined }}>
                <div className="cc-track-head" style={{ width: HEADER_W, zIndex: captionMenu?.id === trackId ? 40 : 5 }}>
                  <div className="cc-track-head-controls">
                    <span className="cc-track-badge" title={trackId} style={{ background: meta.kind === 'video' ? '#5592c7' : '#65a878' }}>{alias}</span>
                    <button style={flagBtn(hidden)} title={hidden ? '显示轨道' : '隐藏轨道'} onClick={() => commands.toggleTrackFlag(trackId, 'hidden')}><Icon name={hidden ? 'eyeOff' : 'eye'} size={15} /></button>
                    <button style={flagBtn(muted)} title={muted ? '取消静音' : '静音轨道'} onClick={() => commands.toggleTrackFlag(trackId, 'muted')}><Icon name={muted ? 'volumeOff' : 'volume'} size={15} /></button>
                    <button style={flagBtn(!captionsVisible)} title={captionsVisible ? '关闭字幕' : '开启字幕'} onClick={() => toggleCaptions(trackId)}><Icon name="captions" size={15} /></button>
                    <button data-caption-menu-trigger style={flagBtn(false)} title="字幕样式与翻译" onClick={(e) => {
                      const rect = e.currentTarget.getBoundingClientRect();
                      setCaptionError(null);
                      setCaptionMenu((open) => open?.id === trackId ? null : { id: trackId, left: Math.min(rect.right + 5, window.innerWidth - 310), top: 8 });
                    }}><Icon name="chevronDown" size={13} /></button>
                    <span className="cc-track-head-spacer" />
                    <button className="cc-track-fixed-action" title={collapsed ? '展开轨道' : '折叠轨道'} onClick={() => commands.updateTrack(trackId, { collapsed: !collapsed })}>{collapsed ? '+' : '−'}</button>
                    <button className="cc-track-fixed-action" disabled={busy} title={busy ? '只能删除空轨道' : '删除轨道'} onClick={() => commands.deleteTracks([trackId])}><Icon name="trash" size={14} /></button>
                  </div>
                  {!collapsed && <span className="cc-track-name">{trackName}{config.role ? ` · ${config.role}` : ''}</span>}
                  {captionMenu?.id === trackId && (
                    <div className="cc-caption-style-menu" style={{ position: 'fixed', left: captionMenu.left, top: captionMenu.top }} onPointerDown={(e) => e.stopPropagation()}>
                      <div className="cc-caption-style-title">样式</div>
                      <div className="cc-caption-style-list">
                        {CAPTION_STYLES.map((style) => (
                          <button key={style.id} className={state.captions?.template === style.id ? 'active' : ''} onClick={() => applyCaptionStyle(trackId, style.id)}>
                            <span className="cc-caption-style-swatch" style={{ background: style.highlightBackground ?? '#292929', color: style.highlightBackground ? style.highlightColor : style.color, fontFamily: style.fontFamily, WebkitTextStroke: style.strokeWidth ? `${Math.min(1, style.strokeWidth)}px ${style.strokeColor}` : undefined }}>Aa</span>
                            <span>{style.label}</span>
                          </button>
                        ))}
                      </div>
                      <button className="cc-caption-style-save" disabled title="自定义样式编辑器完成后启用">＋ 保存当前样式...</button>
                      <div className="cc-caption-translate-wrap">
                        <button className="cc-caption-translate" disabled={captionBusy} onClick={() => setCaptionMenu((menu) => menu ? { ...menu, translateOpen: !menu.translateOpen } : menu)}>
                          <span>文A</span><span>{captionBusy ? '翻译中...' : '翻译字幕'}</span><span>›</span>
                        </button>
                        {captionMenu.translateOpen && (
                          <div className="cc-caption-language-menu">
                            {CAPTION_LANGS.map((lang) => <button key={lang} onClick={() => void translateCaptions(lang)}>{lang}</button>)}
                          </div>
                        )}
                      </div>
                      {captionError && <div className="cc-caption-style-error">{captionError}</div>}
                    </div>
                  )}
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
                          background: CLIP_COLOR[it.kind] ?? theme.clipMg,
                          backgroundImage: (it.kind === 'image' || it.kind === 'video') && it.src ? `linear-gradient(90deg, transparent 0%, rgba(0,0,0,.4) 78%), url(${it.src})` : undefined,
                          backgroundSize: 'auto 100%', backgroundRepeat: 'no-repeat',
                          borderRadius: 3, color: '#fff', fontSize: 11,
                          display: 'flex', alignItems: 'flex-end', padding: '0 8px 5px', gap: 6, overflow: 'hidden', whiteSpace: 'nowrap',
                          border: selected ? '2px solid #f2f2f2' : '1px solid rgba(255,255,255,.08)',
                          cursor: locked ? 'not-allowed' : editMode === 'blade' ? 'crosshair' : 'grab', userSelect: 'none', touchAction: 'none',
                        }}
                      >
                        {it.kind === 'audio' && (
                          <svg className="cc-audio-waveform" viewBox="0 0 120 24" preserveAspectRatio="none" aria-hidden>
                            <path d="M0 12 2 9 4 15 6 6 8 17 10 10 12 14 14 4 16 19 18 8 20 16 22 11 24 13 26 7 28 17 30 5 32 20 34 9 36 15 38 12 40 6 42 18 44 10 46 14 48 8 50 17 52 4 54 19 56 11 58 13 60 7 62 16 64 9 66 15 68 5 70 18 72 10 74 14 76 8 78 17 80 6 82 19 84 11 86 13 88 7 90 16 92 9 94 15 96 4 98 18 100 10 102 14 104 8 106 17 108 6 110 19 112 11 114 14 116 8 118 16 120 12" />
                          </svg>
                        )}
                        {/* trim handles (hidden in blade mode) */}
                        {editMode !== 'blade' && <div onPointerDown={(e) => startDrag(e, it.id, 'trim-left', it.startFrame, it.durationInFrames, it.track, it.srcInFrame ?? 0)}
                          style={{ position: 'absolute', left: 0, top: 0, width: 8, height: '100%', cursor: 'ew-resize', background: editMode === 'trim' ? 'rgba(240,86,46,0.5)' : 'rgba(0,0,0,0.25)' }} />}
                        <span style={{ position: 'relative', zIndex: 1, pointerEvents: 'none', overflow: 'hidden', textOverflow: 'ellipsis', fontWeight: 600, textShadow: '0 1px 2px rgba(0,0,0,.55)' }}>{it.name}</span>
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
                        <Icon name="swap" size={10} />
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
          <div ref={playheadLineRef} style={{ position: 'absolute', top: 0, left: 0, transform: `translateX(${HEADER_W + playheadRef.current * px}px)`, width: 1, height: RULER_H + tracksHeight, background: '#ececec', pointerEvents: 'none', boxShadow: '0 0 0 1px #0005' }}>
            <div style={{ position: 'absolute', top: 0, left: -6, width: 13, height: 11, background: '#ececec', clipPath: 'polygon(0 0, 100% 0, 50% 100%)' }} />
          </div>
        </div>
      </div>

      {/* clip right-click menu (source Hyt) */}
      {ctxMenu && (() => {
        const item = state.items.find((it) => it.id === ctxMenu.id);
        if (!item) return null;
        return (
          <ClipContextMenu item={item} x={ctxMenu.x} y={ctxMenu.y} playhead={playheadRef.current} commands={commands}
            fxClip={fxClip} onCopyFx={setFxClip} onClose={() => setCtxMenu(null)}
            onExportMg={exportMg} onConvertToVideo={convertToVideo} />
        );
      })()}

      {feedbackOpen && (
        <div className="cc-feedback-popover" role="dialog" aria-label="问题反馈">
          <strong>问题反馈</strong>
          <span>请在聊天区描述问题，当前工程状态会一并保留。</span>
          <button onClick={() => setFeedbackOpen(false)}>知道了</button>
        </div>
      )}
      <button className="cc-feedback-button" title="问题反馈" aria-label="问题反馈" onClick={() => setFeedbackOpen((open) => !open)}>
        <Icon name="bug" size={20} />
      </button>

      {/* single-clip render status (导出 MG / 转为视频 take a few seconds) */}
      {clipJob && (
        <div style={{ position: 'fixed', left: '50%', bottom: 24, transform: 'translateX(-50%)', zIndex: 200,
          background: clipJob.error ? theme.accent : theme.panelAlt, color: clipJob.error ? '#fff' : theme.text,
          border: `1px solid ${theme.borderLight}`, borderRadius: 8, padding: '9px 16px', fontSize: 12.5,
          boxShadow: '0 8px 28px rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', gap: 10 }}>
          <span>{clipJob.msg}</span>
          {clipJob.error && <button onClick={() => setClipJob(null)} style={{ background: 'none', border: 'none', color: '#fff', cursor: 'pointer', padding: 0, lineHeight: 0, display: 'grid', placeItems: 'center' }}><Icon name="x" size={14} /></button>}
        </div>
      )}
    </section>
  );
}
