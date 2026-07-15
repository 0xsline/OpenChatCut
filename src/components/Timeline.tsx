import { useEffect, useRef, useState, type RefObject } from 'react';
import type { PlayerRef } from '@remotion/player';
import { theme } from '../theme';
import {
  ASPECT_PRESETS, MARKER_HEX, TRANSITION_LABELS, ZOOM_SHAPE_LABELS,
  defaultTrackId, isItemSelected, selectedIdsOf, timelineDuration, timelineTrackIds, trackAlias, trackKind,
  type MarkerColor, type TimelineItem, type TimelineState, type TrackId,
  type TransitionType, type ZoomShape,
} from '../editor/types';
import type { EditorCommands } from '../editor/store';
import { usePersistedState } from '../hooks/usePersistedState';
import { ClipContextMenu, type FxClip } from './ClipContextMenu';
import { Icon, type IconName } from './icons';
import { useRecorder } from '../audio/recorder';
import { exportClipMov, bakeClipToVideo } from '../media/clipExport';
import { buildTranslation } from '../captions/translate';
import { CAPTION_STYLES } from '../captions/styles';
import type { CaptionsData, CaptionTemplate } from '../captions/types';
import { hasLibraryDrag, parseLibraryDrag, type LibraryDragPayload } from '../library/drag';
import { ALL_FX, FX_EFFECTS, LUT_EFFECTS } from '../gl/fx/effects';
import { TEMPLATES } from '../editor/initial';
import type { TimelineShortcutApi, ItemClipboard } from '../shortcuts/timelineApi';

interface TimelineProps {
  state: TimelineState;
  commands: EditorCommands;
  playerRef: RefObject<PlayerRef | null>;
  /** record a mic voiceover → upload the blob → drop it on an audio track */
  onRecordVoiceover?: (blob: Blob) => void;
  /** Filled by Timeline so Editor can bind the global shortcut dispatcher. */
  shortcutApiRef?: RefObject<TimelineShortcutApi | null>;
}

const HEADER_W = 192;
const MIN_ROW = 34;
const RULER_H = 28;
/** equal-height tracks (match source track chrome — no per-row duck UI) */
const TRACK_ROW = 56;
const MAX_ROW = 72;
// clip fill by ITEM kind — source --tl-item-* oklch (video/image=blue, audio=green,
// motion-graphic=pink, text=amber). Video/image also render a media thumbnail on top.
const CLIP_COLOR: Record<TimelineItem['kind'], string> = {
  video: theme.clipVideo, image: theme.clipVideo, gif: theme.clipVideo, svg: theme.clipVideo,
  solid: '#4a5568',
  audio: theme.clipAudio,
  'motion-graphic': theme.clipMg, text: theme.clipText,
};
/** default time scale — 1s ≈ 36px @30fps (shorter clips, less “巨型色块”) */
const PX_PER_FRAME = 1.2;
const MIN_TIME_ZOOM = 0.02; // long timelines (3–8 min) must still fit in one viewport
/** target min px between major ruler labels — denser ticks (source-like cadence) */
const RULER_LABEL_MIN_PX = 52;
const toolBtn: React.CSSProperties = { background: 'none', border: 'none', color: theme.textDim, cursor: 'pointer', fontSize: 14, padding: '2px 5px' };
// 翻译目标语言（第二行）；口播已是中文时不要把「中文」当默认目标
const CAPTION_LANGS = ['English', '日本語', '한국어', 'Español', 'Français', 'Deutsch', 'Português'];

// group spacing between toolbar tool clusters — source uses pure gaps, no visible rule
function ToolSep() {
  return <span style={{ width: 0, margin: '0 6px', flexShrink: 0 }} />;
}

/** corner chips so applied fx / lut / zoom / denoise / transition are visible on the clip */
function ClipEffectBadges({
  item,
  hasInTransition,
}: {
  item: TimelineItem;
  hasInTransition: boolean;
}) {
  const chips: { key: string; label: string; title: string; className: string }[] = [];
  const effects = item.effects ?? [];
  const fxNames = effects
    .filter((e) => e.assetId in FX_EFFECTS)
    .map((e) => FX_EFFECTS[e.assetId]?.name ?? e.assetId);
  const lutNames = effects
    .filter((e) => e.assetId in LUT_EFFECTS)
    .map((e) => LUT_EFFECTS[e.assetId]?.name ?? e.assetId);
  // custom / uncategorized shaders
  const otherFx = effects.filter((e) => !(e.assetId in FX_EFFECTS) && !(e.assetId in LUT_EFFECTS));

  if (fxNames.length || otherFx.length) {
    const n = fxNames.length + otherFx.length;
    chips.push({
      key: 'fx',
      label: n > 1 ? `特效×${n}` : '特效',
      title: [...fxNames, ...otherFx.map((e) => ALL_FX[e.assetId]?.name ?? e.assetId)].join(' · '),
      className: 'fx',
    });
  }
  if (lutNames.length) {
    chips.push({
      key: 'lut',
      label: lutNames.length > 1 ? `LUT×${lutNames.length}` : 'LUT',
      title: lutNames.join(' · '),
      className: 'lut',
    });
  }
  if (item.zoom?.shape || (item.zoom?.reframeCurve?.keyframes.length ?? 0) > 0) {
    const shape = item.zoom?.shape;
    chips.push({
      key: 'zoom',
      label: '缩放',
      title: shape ? (ZOOM_SHAPE_LABELS[shape] ?? shape) : '关键帧缩放',
      className: 'zoom',
    });
  }
  if (item.denoisedSrc) {
    chips.push({ key: 'iso', label: '人声', title: '已应用人声隔离', className: 'iso' });
  }
  if (hasInTransition) {
    chips.push({ key: 'tr', label: '转场', title: '入场转场已挂接', className: 'tr' });
  }
  if (!chips.length) return null;
  return (
    <div className="cc-clip-badges" aria-hidden>
      {chips.map((c) => (
        <span key={c.key} className={`cc-clip-badge ${c.className}`} title={c.title}>{c.label}</span>
      ))}
    </div>
  );
}

// one icon toolbar button (source: monochrome line glyphs, active = accent)
function TB({ icon, title, onClick, active, disabled }: {
  icon: IconName; title: string; onClick?: () => void; active?: boolean; disabled?: boolean;
}) {
  return (
    <button title={title} onClick={onClick} disabled={disabled}
      style={{ width: 24, height: 24, background: 'none', border: 'none', cursor: disabled ? 'default' : 'pointer', padding: 0, borderRadius: 4, display: 'grid', placeItems: 'center', lineHeight: 0, color: disabled ? theme.textDim : active ? theme.accent : '#c8c8c8', opacity: disabled ? 0.4 : 1 }}
      onMouseEnter={(e) => { if (!disabled && !active) e.currentTarget.style.background = theme.panelAlt; }}
      onMouseLeave={(e) => { e.currentTarget.style.background = 'none'; }}>
      <Icon name={icon} size={16} />
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

/** pick major tick step (seconds) so labels stay readable at current zoom */
function rulerMajorSeconds(pxPerFrame: number, fps: number): number {
  // finer steps so zoomed-in timelines get sub-second / few-second marks
  const options = [0.2, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
  for (const s of options) {
    if (s * fps * pxPerFrame >= RULER_LABEL_MIN_PX) return s;
  }
  return 600;
}

/** number of minor ticks between majors (more when majors are far apart) */
function rulerMinorCount(majorSec: number): number {
  if (majorSec <= 0.5) return 1;
  if (majorSec <= 2) return 3;
  if (majorSec <= 10) return 4;
  if (majorSec <= 30) return 5;
  return 9;
}

function fmtRuler(frames: number, fps: number): string {
  const s = frames / fps;
  if (s < 60) {
    const ss = Math.floor(s);
    const cs = Math.floor((s * 100) % 100);
    return `${String(ss).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
  }
  const mm = Math.floor(s / 60);
  const ss = Math.floor(s % 60);
  return `${mm}:${String(ss).padStart(2, '0')}`;
}

type DragMode = 'move' | 'trim-left' | 'trim-right';
interface Drag {
  id: string; mode: DragMode; baseStart: number; baseDur: number; baseTrack: TrackId;
  baseSrcIn: number; startX: number; deltaF: number; targetTrack: TrackId; snapAt: number | null;
}
// how close (px) an edge must come to a snap target before it locks on
const SNAP_PX = 7;

// The source timeline paints dense, filled audio peaks instead of a repeated
// decorative zig-zag. Generate a stable waveform from clip identity so the
// same project keeps the same visual shape without decoding audio in React.
function waveformPath(seed: string, width: number): string {
  let hash = 2166136261;
  for (let i = 0; i < seed.length; i += 1) hash = Math.imul(hash ^ seed.charCodeAt(i), 16777619);
  const count = Math.min(1200, Math.max(24, Math.ceil(width / 2)));
  const bars: string[] = [];
  for (let i = 0; i < count; i += 1) {
    hash ^= hash << 13; hash ^= hash >>> 17; hash ^= hash << 5;
    const envelope = 0.55 + 0.45 * Math.sin((i / (count - 1)) * Math.PI);
    const amplitude = 2.5 + ((hash >>> 0) % 850) / 100 * envelope;
    const x = (i / (count - 1)) * width;
    bars.push(`M${x.toFixed(2)} ${(12 - amplitude).toFixed(2)}V${(12 + amplitude).toFixed(2)}`);
  }
  return bars.join(' ');
}

export function Timeline({ state, commands, playerRef, onRecordVoiceover, shortcutApiRef }: TimelineProps) {
  const empty = state.items.length === 0;
  const total = empty ? 0 : timelineDuration(state);
  const trackIds = timelineTrackIds(state);
  const metaOf = (id: TrackId) => {
    const kind = trackKind(state, id);
    return { kind, color: kind === 'video' ? theme.trackVideo : trackAlias(state, id) === 'A1' ? theme.trackAudioA1 : theme.trackAudioA2 };
  };
  const [zoom, setZoom] = usePersistedState('cc.timelineZoom', 1);
  const px = PX_PER_FRAME * zoom; // pixels per frame at the current time-zoom
  const pxRef = useRef(px);
  pxRef.current = px;
  const playheadRef = useRef(0);
  const playheadLineRef = useRef<HTMLDivElement | null>(null);
  const toolbarTimecodeRef = useRef<HTMLSpanElement | null>(null);
  const rulerTimecodeRef = useRef<HTMLSpanElement | null>(null);
  const [playing, setPlaying] = useState(false);
  // coalesce frameupdate → one paint per animation frame (smoother playhead)
  const pendingFrameRef = useRef<number | null>(null);
  const paintRafRef = useRef(0);
  const lastTcPaintRef = useRef(0);
  const paintPlayhead = (frame: number, forceTc = false) => {
    const current = Math.max(0, frame);
    playheadRef.current = current;
    const x = HEADER_W + current * pxRef.current;
    if (playheadLineRef.current) {
      playheadLineRef.current.style.transform = `translate3d(${x}px,0,0)`;
    }
    // timecode text is expensive; refresh ~12fps while playing
    const now = performance.now();
    if (forceTc || now - lastTcPaintRef.current > 80) {
      lastTcPaintRef.current = now;
      const f = Math.round(current);
      if (toolbarTimecodeRef.current) toolbarTimecodeRef.current.textContent = `${fmt(f, state.fps)} / ${fmt(total, state.fps)}`;
      if (rulerTimecodeRef.current) rulerTimecodeRef.current.textContent = fmtClock(f, state.fps);
    }
  };
  const paintPlayheadRef = useRef(paintPlayhead);
  paintPlayheadRef.current = paintPlayhead;
  useEffect(() => {
    let raf = 0;
    let detach: (() => void) | null = null;
    const attach = () => {
      const player = playerRef.current;
      if (!player) { raf = requestAnimationFrame(attach); return; }
      const flush = () => {
        paintRafRef.current = 0;
        if (pendingFrameRef.current != null) {
          paintPlayheadRef.current(pendingFrameRef.current);
          pendingFrameRef.current = null;
        }
      };
      const onFrame = (event: { detail: { frame: number } }) => {
        pendingFrameRef.current = event.detail.frame;
        if (!paintRafRef.current) paintRafRef.current = requestAnimationFrame(flush);
      };
      const onPlay = () => setPlaying(true);
      const onPause = () => { setPlaying(false); paintPlayheadRef.current(player.getCurrentFrame(), true); };
      const onEnded = () => setPlaying(false);
      player.addEventListener('frameupdate', onFrame);
      player.addEventListener('play', onPlay);
      player.addEventListener('pause', onPause);
      player.addEventListener('ended', onEnded);
      try { setPlaying(!!player.isPlaying?.()); } catch { /* ignore */ }
      paintPlayheadRef.current(player.getCurrentFrame(), true);
      detach = () => {
        player.removeEventListener('frameupdate', onFrame);
        player.removeEventListener('play', onPlay);
        player.removeEventListener('pause', onPause);
        player.removeEventListener('ended', onEnded);
        if (paintRafRef.current) cancelAnimationFrame(paintRafRef.current);
      };
    };
    attach();
    return () => { if (raf) cancelAnimationFrame(raf); detach?.(); };
  }, [playerRef]);
  useEffect(() => { paintPlayheadRef.current(playheadRef.current, true); }, [px, state.fps, total]);
  const zoomBy = (f: number) => setZoom((z) => Math.min(6, Math.max(MIN_TIME_ZOOM, z * f)));
  // editing mode (source: Selection V / Blade B / Trim N). selection = drag/move;
  // blade = click a clip to cut it there; trim = edge-trim ripples following clips.
  const [editMode, setEditMode] = usePersistedState<'selection' | 'blade' | 'trim'>('cc.editMode', 'selection');
  // insert = push later clips when dropping library media; overwrite = place without shift (§4.3)
  const [placeMode, setPlaceMode] = usePersistedState<'insert' | 'overwrite'>('cc.placeMode', 'overwrite');
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
  // Duck (自动闪避) role menu — source edit_track role is a track-head menu item, not a
  // permanent widget. Sets the per-track role (anchor speech / follower music) + duck depth;
  // the engine (TimelineComposition duckGain) already reacts to it.
  const [duckMenu, setDuckMenu] = useState<{ id: TrackId; left: number; top: number } | null>(null);
  useEffect(() => {
    if (!duckMenu) return;
    const close = (event: PointerEvent) => {
      const target = event.target as Element;
      if (!target.closest('.cc-duck-menu') && !target.closest('[data-duck-menu-trigger]')) setDuckMenu(null);
    };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [duckMenu]);
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
    setZoom(Math.min(6, Math.max(MIN_TIME_ZOOM, (w - HEADER_W - 24) / (total * PX_PER_FRAME))));
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
  const [availW, setAvailW] = useState(0);
  // content is at least as wide as the panel, so track rows/ruler never stop
  // short of the right edge when the project is short or zoomed out.
  const innerW = Math.max(HEADER_W + total * px + 240, availW);
  // vertical track-height zoom (Alt+wheel). Equal base row × scale, capped.
  const [trackScale, setTrackScale] = usePersistedState('cc.trackScale', 1);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const measure = () => setAvailW(el.clientWidth);
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
        const next = Math.min(6, Math.max(MIN_TIME_ZOOM, oldZoom * (e.deltaY < 0 ? 1.12 : 1 / 1.12)));
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

  // equal-height tracks; scale via Alt+wheel. Collapsed = thin strip.
  // Duck role is set via agent edit_track / track menu — not permanent track-header widgets (source).
  const rowHeightOf = (id: TrackId) => {
    if (state.tracks?.[id]?.collapsed) return MIN_ROW;
    return Math.max(MIN_ROW, Math.min(MAX_ROW * trackScale, TRACK_ROW * trackScale));
  };
  const tracksHeight = trackIds.reduce((sum, id) => sum + rowHeightOf(id), 0);
  const majorSec = rulerMajorSeconds(px, state.fps);
  const majorFrames = Math.max(1, Math.round(majorSec * state.fps));
  const minorDivs = rulerMinorCount(majorSec) + 1; // subdivisions between majors
  const minorFrames = Math.max(1, Math.round(majorFrames / minorDivs));
  const minorTicksPerMajor = Math.max(1, Math.round(majorFrames / minorFrames) - 1);
  const rulerSpanFrames = Math.max(total, Math.ceil((innerW - HEADER_W) / Math.max(px, 0.001)));
  const majorCount = Math.ceil(rulerSpanFrames / majorFrames) + 1;

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

  /** library resource dropped on a clip (fx/lut/zoom/transition) or track (sound/mg) */
  const [libDropTarget, setLibDropTarget] = useState<string | null>(null);

  const applyLibraryToClip = (payload: LibraryDragPayload, item: TimelineItem): boolean => {
    const visual = item.kind === 'video' || item.kind === 'image' || item.kind === 'motion-graphic';
    if (payload.kind === 'fx' || payload.kind === 'lut') {
      if (item.kind !== 'video' && item.kind !== 'image') return false;
      if (!(payload.id in ALL_FX)) return false;
      const prev = item.effects ?? [];
      const next = [
        ...prev.filter((e) => e.assetId !== payload.id),
        { id: `fx_${payload.id}`, assetId: payload.id, overrides: {} },
      ];
      commands.setItemEffects(item.id, next);
      commands.selectItem(item.id);
      return true;
    }
    if (payload.kind === 'zoom') {
      if (!visual) return false;
      commands.setItemZoom(item.id, { shape: payload.id as ZoomShape, magnification: 1.5 });
      commands.selectItem(item.id);
      return true;
    }
    if (payload.kind === 'transition') {
      if (item.kind === 'audio') return false;
      // incoming = this clip (needs prior adjacent visual on same track)
      commands.addTransition(item.id, payload.id as TransitionType);
      commands.selectItem(item.id);
      return true;
    }
    return false;
  };

  const applyLibraryToTrack = (payload: LibraryDragPayload, trackId: TrackId, startFrame: number): boolean => {
    const ripple = placeMode === 'insert';
    if (payload.kind === 'sound') {
      if (trackKind(state, trackId) !== 'audio') {
        // auto-pick an audio track
        const audioTrack = trackIds.find((t) => trackKind(state, t) === 'audio') ?? defaultTrackId(state, 'audio');
        if (!audioTrack) return false;
        trackId = audioTrack;
      }
      const dur = Math.max(1, Math.round((payload.seconds ?? 1) * state.fps));
      commands.addAudio(
        {
          id: `sfx_${payload.id}`,
          name: payload.name,
          category: 'sfx',
          src: payload.src ?? `/sound-effects/${payload.id}.mp3`,
          durationInFrames: dur,
        },
        { track: trackId, startFrame, ripple },
      );
      return true;
    }
    if (payload.kind === 'template') {
      const tpl = TEMPLATES.find((t) => t.id === payload.id);
      if (!tpl) return false;
      // prefer video track under cursor
      let t = trackId;
      if (trackKind(state, t) !== 'video') {
        t = trackIds.find((id) => trackKind(state, id) === 'video') ?? defaultTrackId(state, 'video') ?? trackId;
      }
      commands.addMotionGraphic(tpl, { track: t, startFrame, ripple });
      return true;
    }
    return false;
  };

  const seekTo = (clientX: number) => {
    const f = Math.max(0, Math.min(frameFromClientX(clientX), total - 1));
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
  const gotoMarker = (dir: 1 | -1) => {
    const sorted = [...markers].filter((m) => m.scope === 'project').sort((a, b) => a.fromFrame - b.fromFrame);
    const next = dir === 1 ? sorted.find((m) => m.fromFrame > playheadRef.current) : [...sorted].reverse().find((m) => m.fromFrame < playheadRef.current);
    if (next) seekFrame(next.fromFrame);
  };
  // ── I/O marks + shuttle + clipboard (source shortcut-dispatcher) ─────────
  const [zoneIn, setZoneIn] = useState<number | null>(null);
  const [zoneOut, setZoneOut] = useState<number | null>(null);
  const itemClipRef = useRef<ItemClipboard>(null);
  const shuttleRateRef = useRef(0); // -4..+4 steps
  const shuttleTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopShuttle = () => {
    shuttleRateRef.current = 0;
    if (shuttleTimerRef.current) {
      clearInterval(shuttleTimerRef.current);
      shuttleTimerRef.current = null;
    }
  };
  const runShuttle = () => {
    if (shuttleTimerRef.current) clearInterval(shuttleTimerRef.current);
    const rate = shuttleRateRef.current;
    if (rate === 0) {
      playerRef.current?.pause();
      return;
    }
    playerRef.current?.pause();
    // step frames proportional to |rate| (~15fps * rate)
    const step = Math.sign(rate) * Math.max(1, Math.abs(rate));
    const ms = Math.max(16, 80 / Math.max(1, Math.abs(rate)));
    shuttleTimerRef.current = setInterval(() => {
      const cur = playheadRef.current;
      const next = Math.max(0, Math.min(total - 1, cur + step * 2));
      playerRef.current?.seekTo(next);
      paintPlayhead(next, true);
      if (next <= 0 || next >= total - 1) stopShuttle();
    }, ms);
  };

  // Expose shortcut API to Editor (single global dispatcher lives there)
  useEffect(() => {
    if (!shortcutApiRef) return;
    const api: TimelineShortcutApi = {
      getPlayhead: () => playheadRef.current,
      seekTo: (frame) => seekFrame(frame),
      playPause: () => {
        stopShuttle();
        playerRef.current?.toggle();
      },
      isPlaying: () => {
        try { return !!playerRef.current?.isPlaying?.(); } catch { return false; }
      },
      setEditMode: (m) => setEditMode(m),
      toggleSnap: () => setSnapping((s) => !s),
      fitToView: () => fitToView(),
      zoomBy: (f) => zoomBy(f),
      splitAtPlayhead: () => bladeSelected(),
      nudgeSelected: (delta) => {
        const ids = selectedIdsOf(state);
        for (const id of ids) {
          const it = state.items.find((x) => x.id === id);
          if (!it || state.tracks?.[it.track]?.locked) continue;
          commands.moveItem(id, { startFrame: Math.max(0, it.startFrame + delta) });
        }
      },
      trimSelectedToPlayhead: (side) => {
        const id = state.selectedId;
        if (!id) return;
        const it = state.items.find((x) => x.id === id);
        if (!it) return;
        const ph = playheadRef.current;
        if (side === 'start') {
          if (ph <= it.startFrame || ph >= it.startFrame + it.durationInFrames) return;
          const delta = ph - it.startFrame;
          const timing: { startFrame: number; durationInFrames: number; srcInFrame?: number } = {
            startFrame: ph,
            durationInFrames: it.durationInFrames - delta,
          };
          // Advance source in-point so the visible media stays aligned (split semantics).
          if (it.kind === 'video' || it.kind === 'audio') {
            timing.srcInFrame = (it.srcInFrame ?? 0) + delta;
          }
          commands.setItemTiming(id, timing);
        } else {
          if (ph <= it.startFrame || ph >= it.startFrame + it.durationInFrames) return;
          commands.setItemTiming(id, { durationInFrames: Math.max(1, ph - it.startFrame) });
        }
      },
      selectAfterPlayhead: () => {
        const ph = playheadRef.current;
        const next = [...state.items]
          .filter((it) => it.startFrame >= ph)
          .sort((a, b) => a.startFrame - b.startFrame)[0]
          ?? [...state.items].filter((it) => it.startFrame + it.durationInFrames > ph).sort((a, b) => a.startFrame - b.startFrame)[0];
        if (next) commands.selectItem(next.id);
      },
      selectUnderPlayhead: () => {
        const ph = playheadRef.current;
        const hit = state.items.find((it) => ph >= it.startFrame && ph < it.startFrame + it.durationInFrames);
        commands.selectItem(hit?.id ?? state.items[0]?.id ?? null);
      },
      gotoEdit: (dir) => {
        const ph = playheadRef.current;
        const cuts = new Set<number>([0, total]);
        for (const it of state.items) {
          cuts.add(it.startFrame);
          cuts.add(it.startFrame + it.durationInFrames);
        }
        const sorted = [...cuts].sort((a, b) => a - b);
        if (dir === 1) {
          const n = sorted.find((f) => f > ph + 0.5);
          if (n != null) seekFrame(n);
        } else {
          const n = [...sorted].reverse().find((f) => f < ph - 0.5);
          if (n != null) seekFrame(n);
        }
      },
      gotoMarker: (dir) => gotoMarker(dir),
      addMarker: (open) => {
        const id = commands.addMarker(playheadRef.current);
        if (open) setEditMarker(id);
      },
      modifyMarkerAtPlayhead: () => {
        const ph = playheadRef.current;
        const m = (state.markers ?? []).find((x) => x.scope === 'project' && Math.abs(x.fromFrame - ph) <= 1);
        if (m) setEditMarker(m.id);
        else {
          const id = commands.addMarker(ph);
          setEditMarker(id);
        }
      },
      deleteMarkerAtPlayhead: () => {
        const ph = playheadRef.current;
        const m = (state.markers ?? []).find((x) => x.scope === 'project' && Math.abs(x.fromFrame - ph) <= 1);
        if (m) commands.removeMarker(m.id);
      },
      setZoneIn: () => setZoneIn(playheadRef.current),
      setZoneOut: () => setZoneOut(playheadRef.current),
      clearZone: () => { setZoneIn(null); setZoneOut(null); },
      zoneFromClip: () => {
        const ph = playheadRef.current;
        const hit = state.items.find((it) => ph >= it.startFrame && ph < it.startFrame + it.durationInFrames)
          ?? state.items.find((it) => it.id === state.selectedId);
        if (hit) {
          setZoneIn(hit.startFrame);
          setZoneOut(hit.startFrame + hit.durationInFrames);
        }
      },
      zoneFromSelection: () => {
        const it = state.items.find((x) => x.id === state.selectedId);
        if (it) {
          setZoneIn(it.startFrame);
          setZoneOut(it.startFrame + it.durationInFrames);
        }
      },
      getZone: () => ({ inFrame: zoneIn, outFrame: zoneOut }),
      shuttle: (dir) => {
        if (dir === 0) {
          stopShuttle();
          playerRef.current?.pause();
          return;
        }
        // stack rate like JKL
        const cur = shuttleRateRef.current;
        let next = cur;
        if (dir === 1) next = cur <= 0 ? 1 : Math.min(4, cur + 1);
        else next = cur >= 0 ? -1 : Math.max(-4, cur - 1);
        shuttleRateRef.current = next;
        runShuttle();
      },
      shuttleJog: (dir) => {
        stopShuttle();
        seekFrame(playheadRef.current + dir);
      },
      moveSelectedTrack: (dir) => {
        const id = state.selectedId;
        if (!id) return;
        const it = state.items.find((x) => x.id === id);
        if (!it) return;
        const ids = timelineTrackIds(state);
        const idx = ids.indexOf(it.track);
        if (idx < 0) return;
        const ni = idx + dir;
        if (ni < 0 || ni >= ids.length) return;
        const dest = ids[ni]!;
        if (trackKind(state, dest) !== trackKind(state, it.track)) return;
        commands.moveItem(id, { track: dest, startFrame: it.startFrame });
      },
      moveSelectedToBoundary: (side) => {
        const id = state.selectedId;
        if (!id) return;
        const it = state.items.find((x) => x.id === id);
        if (!it) return;
        const same = state.items.filter((x) => x.track === it.track && x.id !== id);
        if (side === 'left') {
          const left = same.filter((x) => x.startFrame + x.durationInFrames <= it.startFrame)
            .sort((a, b) => (b.startFrame + b.durationInFrames) - (a.startFrame + a.durationInFrames))[0];
          const target = left ? left.startFrame + left.durationInFrames : 0;
          commands.moveItem(id, { startFrame: target });
        } else {
          const right = same.filter((x) => x.startFrame >= it.startFrame + it.durationInFrames)
            .sort((a, b) => a.startFrame - b.startFrame)[0];
          const target = right ? right.startFrame - it.durationInFrames : it.startFrame;
          commands.moveItem(id, { startFrame: Math.max(0, target) });
        }
      },
      copySelected: () => {
        const ids = selectedIdsOf(state);
        const items = ids.map((id) => state.items.find((x) => x.id === id)).filter(Boolean) as TimelineItem[];
        if (!items.length) return;
        // store primary (last) for single paste; multi-paste pastes all relative to earliest
        const snap = (it: TimelineItem): TimelineItem => ({
          ...it,
          props: it.props ? { ...it.props } : it.props,
          effects: it.effects?.map((e) => ({ ...e, overrides: e.overrides ? { ...e.overrides } : undefined })),
        });
        itemClipRef.current = {
          kind: 'item',
          item: snap(items[items.length - 1]!),
          multi: items.length > 1 ? items.map(snap) : undefined,
        };
      },
      cutSelected: () => {
        const ids = selectedIdsOf(state);
        const items = ids.map((id) => state.items.find((x) => x.id === id)).filter(Boolean) as TimelineItem[];
        if (!items.length) return;
        const snap = (it: TimelineItem): TimelineItem => ({
          ...it,
          props: it.props ? { ...it.props } : it.props,
          effects: it.effects?.map((e) => ({ ...e, overrides: e.overrides ? { ...e.overrides } : undefined })),
        });
        itemClipRef.current = {
          kind: 'item',
          item: snap(items[items.length - 1]!),
          multi: items.length > 1 ? items.map(snap) : undefined,
        };
        // remove all in one history step
        const idSet = new Set(ids);
        commands.applyState({
          ...state,
          items: state.items.filter((it) => !idSet.has(it.id)),
          transitions: (state.transitions ?? []).filter((t) => !idSet.has(t.incomingItemId) && !idSet.has(t.outgoingItemId)),
          selectedId: null,
          selectedIds: [],
        });
      },
      pasteClipboard: () => {
        const clip = itemClipRef.current;
        if (!clip || clip.kind !== 'item') return;
        const batch = clip.multi?.length ? clip.multi : [clip.item];
        const baseStart = Math.min(...batch.map((it) => it.startFrame));
        const ph = Math.max(0, playheadRef.current);
        const newItems: TimelineItem[] = batch.map((src) => {
          const newId = `item_${crypto.randomUUID()}`;
          return {
            ...src,
            id: newId,
            startFrame: ph + (src.startFrame - baseStart),
            props: src.props ? { ...src.props } : src.props,
            effects: src.effects?.map((e) => ({ ...e, overrides: e.overrides ? { ...e.overrides } : undefined })),
          };
        });
        const newIds = newItems.map((it) => it.id);
        commands.applyState({
          ...state,
          items: [...state.items, ...newItems],
          selectedIds: newIds,
          selectedId: newIds[newIds.length - 1] ?? null,
        });
      },
      pasteEffects: () => {
        const it = state.items.find((x) => x.id === state.selectedId);
        if (!it || !fxClip || it.kind === 'audio') return;
        if (fxClip.filters) commands.setItemFilters(it.id, fxClip.filters);
        if (fxClip.transform) commands.setItemTransform(it.id, fxClip.transform);
        commands.setItemZoom(it.id, fxClip.zoom ?? null);
        commands.setItemFade(it.id, {
          fadeInFrames: fxClip.fadeInFrames ?? 0,
          fadeOutFrames: fxClip.fadeOutFrames ?? 0,
        });
      },
      copyEffects: () => {
        const it = state.items.find((x) => x.id === state.selectedId);
        if (!it || it.kind === 'audio') return;
        setFxClip({
          filters: it.filters,
          transform: it.transform,
          zoom: it.zoom,
          fadeInFrames: it.fadeInFrames,
          fadeOutFrames: it.fadeOutFrames,
        });
      },
      duplicateSelected: () => {
        const ids = selectedIdsOf(state);
        if (!ids.length) return;
        if (ids.length === 1) {
          commands.duplicateItem(ids[0]!);
          return;
        }
        // multi-duplicate in one step at track ends is awkward; duplicate each with new ids after last
        let next = { ...state, items: [...state.items] };
        const newIds: string[] = [];
        for (const id of ids) {
          const it = next.items.find((x) => x.id === id);
          if (!it) continue;
          const newId = `item_${crypto.randomUUID()}`;
          const copy: TimelineItem = {
            ...it,
            id: newId,
            props: it.props ? { ...it.props } : it.props,
            startFrame: Math.max(...next.items.filter((x) => x.track === it.track).map((x) => x.startFrame + x.durationInFrames), 0),
          };
          next = { ...next, items: [...next.items, copy] };
          newIds.push(newId);
        }
        commands.applyState({
          ...next,
          selectedIds: newIds,
          selectedId: newIds[newIds.length - 1] ?? null,
        });
      },
      deleteSelected: (ripple) => {
        const ids = selectedIdsOf(state);
        if (!ids.length) return;
        if (ids.length === 1) {
          if (ripple) commands.rippleDeleteItem(ids[0]!);
          else commands.removeItem(ids[0]!);
          return;
        }
        // multi-delete: one undo step (ripple applied per id in track order by start)
        let items = [...state.items];
        let transitions = [...(state.transitions ?? [])];
        const sorted = [...ids]
          .map((id) => items.find((x) => x.id === id))
          .filter(Boolean)
          .sort((a, b) => (b!.startFrame - a!.startFrame)) as TimelineItem[]; // reverse chrono so ripple indices stay valid
        for (const gone of sorted) {
          if (state.tracks?.[gone.track]?.locked) continue;
          const end = gone.startFrame + gone.durationInFrames;
          items = items
            .filter((it) => it.id !== gone.id)
            .map((it) => (ripple && it.track === gone.track && it.startFrame >= end
              ? { ...it, startFrame: Math.max(0, it.startFrame - gone.durationInFrames) }
              : it));
          transitions = transitions.filter((t) => t.incomingItemId !== gone.id && t.outgoingItemId !== gone.id);
        }
        commands.applyState({
          ...state,
          items,
          transitions,
          selectedId: null,
          selectedIds: [],
        });
      },
      fullscreenTimeline: () => {
        if (document.fullscreenElement) void document.exitFullscreen();
        else void scrollRef.current?.requestFullscreen();
      },
      getFxClip: () => fxClip,
      setFxClip: (fx) => setFxClip(fx),
    };
    shortcutApiRef.current = api;
    return () => {
      if (shortcutApiRef.current === api) shortcutApiRef.current = null;
      stopShuttle();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keep API fresh each render
  });

  const startDrag = (e: React.PointerEvent, id: string, mode: DragMode, baseStart: number, baseDur: number, baseTrack: TrackId, baseSrcIn = 0) => {
    if (state.tracks?.[baseTrack]?.locked) return;
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    // Multi-select: ⌘/Ctrl toggle, ⇧ range on same track; plain click replaces.
    if (e.metaKey || e.ctrlKey) {
      commands.selectItem(id, { mode: 'toggle' });
    } else if (e.shiftKey && state.selectedId) {
      const anchor = state.items.find((x) => x.id === state.selectedId);
      const target = state.items.find((x) => x.id === id);
      if (anchor && target && anchor.track === target.track) {
        const lo = Math.min(anchor.startFrame, target.startFrame);
        const hi = Math.max(anchor.startFrame, target.startFrame);
        const range = state.items
          .filter((x) => x.track === anchor.track && x.startFrame >= lo && x.startFrame <= hi)
          .map((x) => x.id);
        commands.selectItems(range);
      } else {
        commands.selectItem(id);
      }
    } else if (!isItemSelected(state, id)) {
      commands.selectItem(id);
    } else {
      // already in multi-selection: keep set, set primary via re-add
      commands.selectItem(id, { mode: 'add' });
    }
    // Only start move drag when not pure multi-toggle without drag intent — still allow drag
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
    <section className="cc-timeline" style={{ flex: 1, borderLeft: `1px solid ${theme.border}`, background: '#101010', display: 'flex', flexDirection: 'column', minHeight: 0, overflow: 'hidden', position: 'relative' }}>
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
          <TB
            icon="insert"
            title="插入落轨：库素材/模板拖入时把后续片段后推（波纹插入）"
            active={placeMode === 'insert'}
            onClick={() => setPlaceMode('insert')}
          />
          <TB
            icon="film"
            title="覆盖落轨：库素材/模板按帧位叠放，不推后续片段（默认）"
            active={placeMode === 'overwrite'}
            onClick={() => setPlaceMode('overwrite')}
          />
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
        <TB
          icon={playing ? 'pause' : 'play'}
          title={playing ? '暂停 (空格)' : '播放 (空格)'}
          active={playing}
          onClick={() => playerRef.current?.toggle()}
        />
        <span ref={toolbarTimecodeRef} className="cc-timeline-timecode">{fmt(playheadRef.current, state.fps)} / {fmt(total, state.fps)}</span>
        <span style={{ flex: 1 }} />
        <TB icon="zoomOut" title="缩小时间轴 (⌘−)" onClick={() => zoomBy(1 / 1.4)} />
        <input type="range" min={MIN_TIME_ZOOM} max={6} step={0.01} value={zoom} onChange={(e) => setZoom(Number(e.target.value))}
          title="缩放时间轴" className="cc-timeline-zoom" />
        <TB icon="zoomIn" title="放大时间轴 (⌘＋)" onClick={() => zoomBy(1.4)} />
        <TB icon="fit" title="适配视图 (⇧Z)" onClick={fitToView} />
        <label className="cc-aspect-select" title="画幅比例">
          <Icon name="aspect" size={16} />
          <select aria-label="画幅比例" value={ASPECT_PRESETS.find((preset) => preset.width === state.width && preset.height === state.height)?.label ?? ''}
            onChange={(event) => {
              if (event.target.value === '__contain__' || event.target.value === '__cover__') {
                commands.setAspect(state.width, state.height, event.target.value === '__cover__' ? 'cover' : 'contain');
                return;
              }
              const preset = ASPECT_PRESETS.find((entry) => entry.label === event.target.value);
              if (preset) commands.setAspect(preset.width, preset.height, state.fit);
            }}>
            <optgroup label="画幅比例">{ASPECT_PRESETS.map((preset) => <option key={preset.label} value={preset.label}>{preset.label}</option>)}</optgroup>
            <optgroup label="内容适配"><option value="__contain__">留边</option><option value="__cover__">裁切</option></optgroup>
          </select>
        </label>
        <button className={`cc-caption-toggle${captionsVisible ? ' active' : ''}`} title="字幕显示" disabled={!state.captions} onClick={() => state.captions && commands.updateCaptions({ enabled: !captionsVisible })}><Icon name="captions" size={17} /><span>{captionsVisible ? '开启' : '关闭'}</span><Icon name="chevronDown" size={13} /></button>
        <TB icon="fullscreen" title="全屏时间线" onClick={() => { if (document.fullscreenElement) void document.exitFullscreen(); else void scrollRef.current?.requestFullscreen(); }} />
      </div>

      {/* scrollable ruler + tracks (playhead spans both). Ctrl/⌘+wheel = time
          zoom at cursor, Alt+wheel = track-height zoom (native listener above). */}
      <div ref={scrollRef} style={{ overflow: 'auto', flex: 1, minHeight: 0 }} onPointerMove={onPointerMove} onPointerUp={onPointerUp}
        title="Ctrl/⌘+滚轮 缩放时间轴 · Alt+滚轮 缩放轨道高度">
        <div ref={innerRef} style={{ position: 'relative', width: innerW }}>
          {/* ruler (click to seek) — adaptive major labels so zoomed-out timelines stay readable */}
          <div
            onPointerDown={(e) => seekTo(e.clientX)}
            style={{ display: 'flex', height: RULER_H, borderBottom: `1px solid ${theme.border}`, fontSize: 10, color: theme.textDim, cursor: 'text', userSelect: 'none' }}
          >
            <div className="cc-ruler-head" style={{ width: HEADER_W }}><span ref={rulerTimecodeRef}>{fmtClock(playheadRef.current, state.fps)}</span></div>
            <div style={{ position: 'relative', flex: 1, overflow: 'hidden' }}>
              {empty
                ? Array.from({ length: 5 }).map((_, i) => (
                    <span key={i} style={{ position: 'absolute', left: `${i * 25}%`, top: 6, transform: i === 4 ? 'translateX(-100%)' : undefined }}>{fmtRuler(i * state.fps * 10, state.fps)}</span>
                  ))
                : Array.from({ length: majorCount }).map((_, i) => {
                    const f = i * majorFrames;
                    const left = f * px;
                    return (
                      <div key={i} style={{ position: 'absolute', left, top: 0, height: '100%', pointerEvents: 'none' }}>
                        <div style={{ position: 'absolute', left: 0, bottom: 0, width: 1, height: 10, background: '#555' }} />
                        <span style={{ position: 'absolute', left: 4, top: 5, whiteSpace: 'nowrap', color: '#9a9a9a', fontVariantNumeric: 'tabular-nums' }}>
                          {fmtRuler(f, state.fps)}
                        </span>
                        {/* minor ticks between majors (density scales with zoom) */}
                        {Array.from({ length: minorTicksPerMajor }).map((__, m) => {
                          const mf = f + (m + 1) * minorFrames;
                          if (mf >= f + majorFrames) return null;
                          const mid = m + 1 === Math.round(minorTicksPerMajor / 2);
                          return (
                            <div
                              key={m}
                              style={{
                                position: 'absolute',
                                left: (m + 1) * minorFrames * px,
                                bottom: 0,
                                width: 1,
                                height: mid ? 7 : 4,
                                background: mid ? '#4a4a4a' : '#333',
                              }}
                            />
                          );
                        })}
                      </div>
                    );
                  })}
              {/* I/O zone (source mark in/out) */}
              {(zoneIn != null || zoneOut != null) && (
                <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 3 }}>
                  {zoneIn != null && zoneOut != null && zoneOut > zoneIn && (
                    <div
                      title="入出点区间"
                      style={{
                        position: 'absolute', left: zoneIn * px, top: 0, bottom: 0,
                        width: (zoneOut - zoneIn) * px,
                        background: 'rgba(88, 166, 255, 0.18)',
                        borderLeft: '2px solid #58a6ff',
                        borderRight: '2px solid #58a6ff',
                      }}
                    />
                  )}
                  {zoneIn != null && (
                    <div title="入点 (I)" style={{
                      position: 'absolute', left: zoneIn * px, top: 2, transform: 'translateX(-50%)',
                      width: 0, height: 0,
                      borderLeft: '5px solid transparent', borderRight: '5px solid transparent',
                      borderTop: '8px solid #58a6ff',
                    }} />
                  )}
                  {zoneOut != null && (
                    <div title="出点 (O)" style={{
                      position: 'absolute', left: zoneOut * px, top: 2, transform: 'translateX(-50%)',
                      width: 0, height: 0,
                      borderLeft: '5px solid transparent', borderRight: '5px solid transparent',
                      borderTop: '8px solid #f0883e',
                    }} />
                  )}
                </div>
              )}
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
                    <button data-duck-menu-trigger style={{ ...flagBtn(false), color: config.role === 'anchor' || config.role === 'follower' ? '#e0a24e' : '#c2c2c2' }} title="自动闪避（混音角色：主轨说话 / 跟随背景乐）" onClick={(e) => {
                      const rect = e.currentTarget.getBoundingClientRect();
                      setDuckMenu((open) => open?.id === trackId ? null : { id: trackId, left: Math.min(rect.right + 5, window.innerWidth - 226), top: 8 });
                    }}><Icon name="sliders" size={14} /></button>
                    <span className="cc-track-head-spacer" />
                    <button className="cc-track-fixed-action" title={collapsed ? '展开轨道' : '折叠轨道'} onClick={() => commands.updateTrack(trackId, { collapsed: !collapsed })}>{collapsed ? '+' : '−'}</button>
                    <button className="cc-track-fixed-action" disabled={busy} title={busy ? '只能删除空轨道' : '删除轨道'} onClick={() => commands.deleteTracks([trackId])}><Icon name="trash" size={14} /></button>
                  </div>
                  {!collapsed && (
                    <span className="cc-track-name" title={
                      config.role === 'anchor' ? `${trackName} · 主轨（闪避）`
                        : config.role === 'follower' ? `${trackName} · 跟随（闪避）`
                          : trackName
                    }>
                      {trackName}
                      {config.role === 'anchor' ? ' · 主轨' : config.role === 'follower' ? ' · 跟随' : ''}
                    </span>
                  )}
                  {captionMenu?.id === trackId && (
                    <div className="cc-caption-style-menu" style={{ position: 'fixed', left: captionMenu.left, top: captionMenu.top }} onPointerDown={(e) => e.stopPropagation()}>
                      <div className="cc-caption-style-title">样式</div>
                      <div className="cc-caption-style-list">
                        {CAPTION_STYLES.map((style) => (
                          <button key={style.id} className={state.captions?.template === style.id ? 'active' : ''} onClick={() => applyCaptionStyle(trackId, style.id)}>
                            <span className="cc-caption-style-swatch" style={{ background: style.highlightBackground ?? '#292929', color: style.highlightBackground ? style.highlightColor : style.color, fontFamily: style.fontFamily, WebkitTextStroke: style.strokeWidth ? `${Math.min(1, style.strokeWidth)}px ${style.strokeColor}` : undefined }}>Aa</span>
                            <span>{style.labelZh}</span>
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
                  {duckMenu?.id === trackId && (
                    <div className="cc-caption-style-menu cc-duck-menu" style={{ position: 'fixed', left: duckMenu.left, top: duckMenu.top, width: 212 }} onPointerDown={(e) => e.stopPropagation()}>
                      <div className="cc-caption-style-title">自动闪避 · 混音角色</div>
                      <div className="cc-caption-style-list">
                        {([
                          { role: null, label: '关闭', hint: '不参与自动闪避' },
                          { role: 'anchor', label: '主轨 · 说话', hint: '说话时触发其它轨闪避' },
                          { role: 'follower', label: '跟随 · 背景音乐', hint: '主轨说话时自动压低' },
                        ] as const).map((opt) => (
                          <button key={opt.label} className={(config.role ?? null) === opt.role ? 'active' : ''}
                            onClick={() => { commands.updateTrack(trackId, { role: opt.role }); if (opt.role !== 'follower') setDuckMenu(null); }}>
                            <span style={{ display: 'flex', flexDirection: 'column', gap: 1, lineHeight: 1.25 }}>
                              <span>{opt.label}</span>
                              <span style={{ fontSize: 11, color: '#9a9a9a' }}>{opt.hint}</span>
                            </span>
                          </button>
                        ))}
                      </div>
                      {config.role === 'follower' && (
                        <div style={{ borderTop: '1px solid #3a3a3a', padding: '7px 10px 9px' }}>
                          <div style={{ fontSize: 11, color: '#9a9a9a', marginBottom: 5 }}>闪避强度（dB）</div>
                          <div style={{ display: 'flex', gap: 4 }}>
                            {[-6, -12, -18, -24].map((db) => {
                              const cur = config.audioRouting?.duckDepthDb ?? -12;
                              return (
                                <button key={db} onClick={() => commands.updateTrack(trackId, { audioRouting: { duckDepthDb: db } })}
                                  style={{ flex: 1, padding: '4px 0', borderRadius: 4, border: '1px solid #454545', cursor: 'pointer',
                                    background: cur === db ? '#3a4a5a' : 'transparent', color: cur === db ? '#fff' : '#c8c8c8', fontSize: 11 }}>
                                  {db}
                                </button>
                              );
                            })}
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
                <div
                  style={{
                    flex: 1, position: 'relative', background: theme.bg, opacity: hidden ? 0.4 : 1,
                    outline: libDropTarget === `track:${trackId}` ? '1px dashed #6a9fd8' : undefined,
                    outlineOffset: -2,
                  }}
                  onDragOver={(e) => {
                    if (!hasLibraryDrag(e) || locked) return;
                    e.preventDefault();
                    e.dataTransfer.dropEffect = 'copy';
                    setLibDropTarget(`track:${trackId}`);
                  }}
                  onDragLeave={() => setLibDropTarget((t) => (t === `track:${trackId}` ? null : t))}
                  onDrop={(e) => {
                    const payload = parseLibraryDrag(e);
                    setLibDropTarget(null);
                    if (!payload || locked) return;
                    e.preventDefault();
                    e.stopPropagation();
                    // Prefer clip under cursor if any (fx/lut/zoom/transition)
                    const f = frameFromClientX(e.clientX);
                    const hit = items.find((it) => f >= it.startFrame && f < it.startFrame + it.durationInFrames);
                    if (hit && (payload.kind === 'fx' || payload.kind === 'lut' || payload.kind === 'zoom' || payload.kind === 'transition')) {
                      applyLibraryToClip(payload, hit);
                      return;
                    }
                    applyLibraryToTrack(payload, trackId, f);
                  }}
                >
                  {items.map((it) => {
                    const dragging = drag?.id === it.id;
                    const start = it.startFrame + (dragging && drag.mode !== 'trim-right' ? drag.deltaF : 0);
                    const durTrim = dragging && drag.mode === 'trim-left' ? -drag.deltaF : dragging && drag.mode === 'trim-right' ? drag.deltaF : 0;
                    const dur = Math.max(1, it.durationInFrames + durTrim);
                    const selected = isItemSelected(state, it.id);
                    const isLibOver = libDropTarget === it.id;
                    const hasInTr = (state.transitions ?? []).some((t) => t.incomingItemId === it.id);
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
                        onDragOver={(e) => {
                          if (!hasLibraryDrag(e) || locked) return;
                          e.preventDefault();
                          e.stopPropagation();
                          e.dataTransfer.dropEffect = 'copy';
                          setLibDropTarget(it.id);
                        }}
                        onDragLeave={(e) => {
                          e.stopPropagation();
                          setLibDropTarget((t) => (t === it.id ? null : t));
                        }}
                        onDrop={(e) => {
                          const payload = parseLibraryDrag(e);
                          setLibDropTarget(null);
                          if (!payload || locked) return;
                          e.preventDefault();
                          e.stopPropagation();
                          if (!applyLibraryToClip(payload, it)) {
                            // sound/template may land on clip → use clip start on same track
                            applyLibraryToTrack(payload, it.track, it.startFrame);
                          }
                        }}
                        style={{
                          position: 'absolute', left: Math.max(0, start) * px, top: 4, height: rowHeightOf(trackId) - 8, width: dur * px,
                          background: CLIP_COLOR[it.kind] ?? theme.clipMg,
                          backgroundImage: (it.kind === 'image' || it.kind === 'video') && it.src ? `linear-gradient(90deg, transparent 0%, rgba(0,0,0,.4) 78%), url(${it.src})` : undefined,
                          backgroundSize: 'auto 100%', backgroundRepeat: 'no-repeat',
                          borderRadius: 3, color: '#fff', fontSize: 11,
                          display: 'flex', alignItems: 'flex-end', padding: '0 8px 5px', gap: 6, overflow: 'hidden', whiteSpace: 'nowrap',
                          border: isLibOver
                            ? '2px solid #6a9fd8'
                            : selected ? '2px solid #f2f2f2' : '1px solid rgba(255,255,255,.08)',
                          boxShadow: isLibOver ? 'inset 0 0 0 1px #6a9fd855, 0 0 0 1px #6a9fd844' : undefined,
                          cursor: locked ? 'not-allowed' : editMode === 'blade' ? 'crosshair' : 'grab', userSelect: 'none', touchAction: 'none',
                        }}
                      >
                        {it.kind === 'audio' && (
                          <svg className="cc-audio-waveform" viewBox={`0 0 ${Math.max(1, dur * px - 6)} 24`} preserveAspectRatio="none" aria-hidden>
                            <path d={waveformPath(`${it.id}:${it.name}`, Math.max(1, dur * px - 6))} />
                          </svg>
                        )}
                        <ClipEffectBadges item={it} hasInTransition={hasInTr} />
                        {/* trim handles (hidden in blade mode) */}
                        {editMode !== 'blade' && <div onPointerDown={(e) => startDrag(e, it.id, 'trim-left', it.startFrame, it.durationInFrames, it.track, it.srcInFrame ?? 0)}
                          style={{ position: 'absolute', left: 0, top: 0, width: 8, height: '100%', cursor: 'ew-resize', background: editMode === 'trim' ? 'rgba(240,86,46,0.5)' : 'rgba(0,0,0,0.25)' }} />}
                        <span className={`cc-clip-label${it.kind === 'audio' ? ' audio' : ''}`}>{it.name}</span>
                        {editMode !== 'blade' && <div onPointerDown={(e) => startDrag(e, it.id, 'trim-right', it.startFrame, it.durationInFrames, it.track, it.srcInFrame ?? 0)}
                          style={{ position: 'absolute', right: 0, top: 0, width: 8, height: '100%', cursor: 'ew-resize', background: editMode === 'trim' ? 'rgba(240,86,46,0.5)' : 'rgba(0,0,0,0.25)' }} />}
                      </div>
                    );
                  })}
                  {/* transition badges at each cut on this track */}
                  {(state.transitions ?? []).filter((t) => t.trackId === trackId).map((t) => {
                    const inItem = state.items.find((it) => it.id === t.incomingItemId);
                    if (!inItem) return null;
                    const label = TRANSITION_LABELS[t.type as TransitionType] ?? t.type;
                    return (
                      <div key={t.id} title={`${label} · ${(t.durationInFrames / state.fps).toFixed(1)}s`}
                        onClick={() => commands.selectItem(t.incomingItemId)}
                        className="cc-transition-marker"
                        style={{ position: 'absolute', top: '50%', left: inItem.startFrame * px, transform: 'translate(-50%, -50%)', zIndex: 3 }}>
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

          {/* playhead — GPU layer + rAF-coalesced updates for smoother scrub/play */}
          <div
            ref={playheadLineRef}
            className="cc-playhead"
            style={{
              position: 'absolute', top: 0, left: 0,
              transform: `translate3d(${HEADER_W + playheadRef.current * px}px,0,0)`,
              width: 1, height: RULER_H + tracksHeight,
              background: '#f2f2f2', pointerEvents: 'none',
              boxShadow: '0 0 0 1px #0006',
              willChange: 'transform',
              zIndex: 6,
            }}
          >
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
