import { useEffect, useRef, useState, type RefObject } from 'react';
import type { PlayerRef } from '@remotion/player';
import { theme, themeAlpha } from '../../theme';
import {
  captionTrackEntries, captionsOnTrack, defaultTrackId, selectedIdsOf, timelineDuration, timelineTrackIds, trackAlias, trackKind,
  type TimelineItem, type TimelineState, type TrackId,
} from '../../editor/types';
import type { EditorCommands } from '../../editor/store';
import { usePersistedState } from '../../hooks/usePersistedState';
import { ClipContextMenu, type FxClip } from './ClipContextMenu';
import { Icon } from '../icons';
import { useRecorder } from '../../audio/recorder';
import { exportClipMov, bakeClipToVideo } from '../../media/clipExport';
import { CaptionStyleMenu } from '../../captions/CaptionStyleMenu';
import { CaptionTrackLane, type CaptionCueMove } from '../../captions/CaptionTrackLane';
import { captionsForTrack } from '../../captions/captionTrack';
import {
  appendManualCueToFirstLane, newManualCaptions, removeManualCue, updateManualCue,
} from '../../captions/manualCaptions';
import { TrackHead } from './TrackHead';
import { TrackLane } from './TrackLane';
import { TimelineToolbar } from './TimelineToolbar';
import { TimelineRuler } from './TimelineRuler';
import { MarkerEditor } from './MarkerEditor';
import { useTimelineShortcuts } from './useTimelineShortcuts';
import { useTimelinePointer } from './useTimelinePointer';
import { usePlayheadPaint } from './usePlayheadPaint';
import { useTimelineZoomController } from './useTimelineZoomController';
import { applyLibraryToClip as applyToClip, applyLibraryToTrack as applyToTrack } from './libraryDropActions';
import {
  HEADER_W, MAX_ROW, MIN_ROW, RULER_H, TRACK_ROW,
  rulerMajorSeconds, rulerMinorCount, type EditMode,
} from './timelineUtil';
import type { LibraryDragPayload } from '../../library/drag';
import { useSelectionRefMode } from '../../agent/selection-refs';
import { useT } from '../../i18n/locale';
import type { TimelineShortcutApi } from '../../shortcuts/timelineApi';

interface TimelineProps {
  state: TimelineState;
  commands: EditorCommands;
  playerRef: RefObject<PlayerRef | null>;
  /** project id for playhead continuity across reloads */
  projectId?: string;
  /** record a mic voiceover → upload the blob → drop it on an audio track */
  onRecordVoiceover?: (blob: Blob) => void;
  /** Filled by Timeline so Editor can bind the global shortcut dispatcher. */
  shortcutApiRef?: RefObject<TimelineShortcutApi | null>;
}

export function Timeline({ state, commands, playerRef, projectId, onRecordVoiceover, shortcutApiRef }: TimelineProps) {
  const t = useT();
  const empty = state.items.length === 0;
  const total = empty ? 0 : timelineDuration(state);
  const trackIds = timelineTrackIds(state);
  const innerRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const timelineId = (state as { id?: string }).id;
  const { zoom, setZoom, zoomBy, fitToView, pixelsPerFrame: px, trackScale } =
    useTimelineZoomController({ scrollRef, totalFrames: total, fps: state.fps, timelineId });
  const metaOf = (id: TrackId) => {
    const kind = trackKind(state, id);
    const color = kind === 'caption' ? theme.trackCaption
      : kind === 'video' ? theme.trackVideo
        : trackAlias(state, id) === 'A1' ? theme.trackAudioA1 : theme.trackAudioA2;
    return { kind, color };
  };
  // 播放头绘制机:rAF 合帧直绘 + Player 看门狗 + 断点续播(usePlayheadPaint)
  const { playheadRef, playheadLineRef, toolbarTimecodeRef, rulerTimecodeRef, paintPlayhead, playing } =
    usePlayheadPaint({ playerRef, projectId, fps: state.fps, total, px });
  // editing mode (Selection V / Blade B / Trim N / Pen P). selection =
  // drag/move; blade = click a clip to cut it there; trim = edge-trim ripples
  // following clips; pen = draw opacity keyframes on the selected clip.
  const [editMode, setEditMode] = usePersistedState<EditMode>('cc.editMode', 'selection');
  // insert = push later clips when dropping library media; overwrite = place without shift
  const [placeMode, setPlaceMode] = usePersistedState<'insert' | 'overwrite'>('cc.placeMode', 'overwrite');
  // magnetic snapping (Snapping toggle, S). On = edges lock to guides.
  const [snapping, setSnapping] = usePersistedState('cc.snapping', true);
  const captionsVisible = captionTrackEntries(state).some((entry) => entry.captions?.enabled);
  const [captionMenu, setCaptionMenu] = useState<{ id: TrackId; left: number; top: number } | null>(null);
  // 错误行归 Timeline:菜单外的「开启字幕」按钮也会写它(该轨无文字稿),菜单内展示
  const [captionError, setCaptionError] = useState<string | null>(null);
  const moveCaptionCue = (sourceTrackId: TrackId, move: CaptionCueMove) => {
    const source = captionsOnTrack(state, sourceTrackId);
    if (!source) return;
    const targetTrackId = trackKind(state, move.targetTrackId) === 'caption'
      && !state.tracks?.[move.targetTrackId]?.locked ? move.targetTrackId : sourceTrackId;
    const sourceCue = source.sourceEntries?.find((entry) => entry.id === move.laneId)?.words?.[move.index];
    if (targetTrackId === sourceTrackId) {
      if (sourceCue?.start === Math.round(move.startMs) && sourceCue.end === Math.round(move.endMs)) return;
      const patch = updateManualCue(source, move.laneId, move.index, move.text, move.startMs, move.endMs);
      if (patch) commands.updateCaptions(patch, sourceTrackId);
      return;
    }
    const target = captionsOnTrack(state, targetTrackId) ?? newManualCaptions();
    const targetPatch = appendManualCueToFirstLane(target, state.items, move.text, move.startMs, move.endMs);
    if (!targetPatch) return;
    commands.batch([
      { type: 'updateCaptions', patch: removeManualCue(source, move.laneId, move.index), track: sourceTrackId },
      { type: 'setCaptions', captions: { ...target, ...targetPatch }, track: targetTrackId },
    ]);
  };
  useEffect(() => {
    if (!captionMenu) return;
    const close = (event: PointerEvent) => {
      const target = event.target as Element;
      if (!target.closest('.cc-caption-style-menu') && !target.closest('[data-caption-menu-trigger]')) setCaptionMenu(null);
    };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [captionMenu]);
  // Duck (自动闪避) role menu is a track-head menu item, not a
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
  // mic voiceover recording (录制旁白). Toggle to start/stop; the blob
  // is uploaded + dropped on an audio track by the parent.
  const recorder = useRecorder(onRecordVoiceover ?? (() => {}));
  const toggleCaptions = (trackId: TrackId) => {
    const current = captionsOnTrack(state, trackId);
    if (current) { commands.updateCaptions({ enabled: !current.enabled }, trackId); return; }
    const captions = captionsForTrack(state, trackId);
    commands.setCaptions(captions ?? newManualCaptions(), trackId);
  };
  // 选择模式 (selection mode): clicks/drags pick REFERENCES for the chat
  // instead of editing — clip click → item ref, ruler click → timepoint, drag
  // over ruler/lanes → timerange. Editing gestures are untouched when off.
  const pickMode = useSelectionRefMode();
  /** Clips whose time range + track lane intersect the client-space marquee rect. */
  const itemsInMarquee = (left: number, top: number, right: number, bottom: number): string[] => {
    const f0 = frameFromClientX(left);
    const f1 = frameFromClientX(right);
    const lo = Math.min(f0, f1);
    const hi = Math.max(f0, f1);
    const r = innerRef.current?.getBoundingClientRect();
    if (!r) return [];
    const hitTracks = new Set<TrackId>();
    let y = r.top + RULER_H;
    for (const t of trackIds) {
      const h = rowHeightOf(t);
      if (bottom >= y && top <= y + h) hitTracks.add(t);
      y += h;
    }
    return state.items
      .filter((it) => {
        if (!hitTracks.has(it.track)) return false;
        if (state.tracks?.[it.track]?.locked) return false;
        const end = it.startFrame + it.durationInFrames;
        return end > lo && it.startFrame < hi;
      })
      .map((it) => it.id);
  };
  // clip right-click menu + effect clipboard (复制效果/粘贴效果)
  const [ctxMenu, setCtxMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const [fxClip, setFxClip] = useState<FxClip | null>(null);
  // single-clip render (导出 MG 动画 / 转为视频) status toast
  const [clipJob, setClipJob] = useState<{ msg: string; error?: boolean } | null>(null);
  const exportMg = async (it: TimelineItem) => {
    setClipJob({ msg: t('导出 MG 动画中（ProRes 4444）…') });
    try { await exportClipMov(state, it); setClipJob(null); }
    catch (e) { setClipJob({ msg: e instanceof Error ? e.message : t('导出失败'), error: true }); }
  };
  const convertToVideo = async (it: TimelineItem) => {
    setClipJob({ msg: t('转为视频中…') });
    try { const src = await bakeClipToVideo(state, it); commands.replaceItemMedia(it.id, src); setClipJob(null); }
    catch (e) { setClipJob({ msg: e instanceof Error ? e.message : t('转换失败'), error: true }); }
  };
  const [availW, setAvailW] = useState(0);
  // content is at least as wide as the panel, so track rows/ruler never stop
  // short of the right edge when the project is short or zoomed out.
  const innerW = Math.max(HEADER_W + total * px + 240, availW);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const measure = () => setAvailW(el.clientWidth);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // equal-height tracks; scale via Alt+wheel. (collapse UI removed — always full row)
  // Duck role is set via agent edit_track / track menu — not permanent track-header widgets.
  const rowHeightOf = (_id: TrackId) => {
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

  // 指针状态机:片段拖动/裁剪、空白框选、钢笔点拖、引用拾取(useTimelinePointer)
  const pointer = useTimelinePointer({
    state, commands, editMode, snapping, pickMode, px,
    playheadRef, scrollRef, frameFromClientX, trackFromClientY, itemsInMarquee,
  });
  const { drag, marquee, pickDrag, startPick, onPointerMove, onPointerUp } = pointer;

  /** library resource dropped on a clip (fx/lut/zoom/transition) or track (sound/mg) */
  const [libDropTarget, setLibDropTarget] = useState<string | null>(null);

  // 拖放被拒必须给原因——此前静默 return false,用户只看到「拖了没反应」
  const dropNotice = (msg: string) => {
    setClipJob({ msg });
    window.setTimeout(() => setClipJob((cur) => (cur && cur.msg === msg && !cur.error ? null : cur)), 3000);
  };

  const dropCtx = { state, commands, notice: dropNotice };
  const applyLibraryToClip = (payload: LibraryDragPayload, item: TimelineItem): boolean =>
    applyToClip(dropCtx, payload, item);
  const applyLibraryToTrack = (payload: LibraryDragPayload, trackId: TrackId, startFrame: number): boolean =>
    applyToTrack(dropCtx, payload, trackId, startFrame, placeMode === 'insert');

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
  // markers (manage_markers): add at the playhead + open its note editor
  const [editMarker, setEditMarker] = useState<string | null>(null);
  const markers = state.markers ?? [];
  // 快捷键 API 装配 + I/O 区间/JKL 穿梭/片段剪贴板(整机在 useTimelineShortcuts)
  const { zoneIn, zoneOut } = useTimelineShortcuts({
    shortcutApiRef, state, commands, playerRef, playheadRef, total,
    seekFrame, paintPlayhead, setEditMode, setSnapping, fitToView, zoomBy,
    bladeSelected, setEditMarker, fxClip, setFxClip,
  });

  const editing = markers.find((m) => m.id === editMarker) ?? null;

  return (
    <section className="cc-timeline" style={{ flex: 1, borderLeft: `0.5px solid ${theme.border}`, background: theme.bg, display: 'flex', flexDirection: 'column', minHeight: 0, overflow: 'hidden', position: 'relative' }}>
      {/* marker note editor (click a pin → note popup) */}
      {editing && <MarkerEditor editing={editing} fps={state.fps} commands={commands} onClose={() => setEditMarker(null)} />}
      <TimelineToolbar
        state={state} commands={commands}
        editMode={editMode}
        placeMode={placeMode} setPlaceMode={setPlaceMode}
        snapping={snapping}
        recorder={recorder} canRecord={!!onRecordVoiceover}
        playing={playing}
        timecodeRef={toolbarTimecodeRef} playheadFrame={playheadRef.current} total={total}
        captionsVisible={captionsVisible}
        zoom={zoom} setZoom={setZoom}
      />

      {/* selection-mode hint strip (subtle banner while picking refs) */}
      {pickMode && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '3px 12px', fontSize: 11, color: theme.accent, borderBottom: `0.5px solid ${theme.border}`, background: theme.panelAlt, flexShrink: 0 }}>
          <Icon name="cursor" size={12} />
          {t('选择模式：点片段引用 · 拖过标尺/空白选时间段 · 单击标尺打时间点 — 引用会加进聊天输入框')}
        </div>
      )}

      {/* scrollable ruler + tracks (playhead spans both). Ctrl/⌘+wheel = time
          zoom at cursor, Alt+wheel = track-height zoom (native listener above). */}
      <div ref={scrollRef} style={{ overflow: 'auto', flex: 1, minHeight: 0 }} onPointerMove={onPointerMove} onPointerUp={onPointerUp}
        title={t('Ctrl/⌘+滚轮 缩放时间轴 · Alt+滚轮 缩放轨道高度')}>
        <div ref={innerRef} style={{ position: 'relative', width: innerW }}>
          {/* ruler (click to seek, hold to scrub; selection mode: click = timepoint, drag = timerange).
              播放头线/三角是 pointerEvents:none,点它即点标尺——scrub 同一路径生效。 */}
          <TimelineRuler
            state={state} empty={empty} px={px}
            majorCount={majorCount} majorFrames={majorFrames} minorFrames={minorFrames} minorTicksPerMajor={minorTicksPerMajor}
            pickMode={pickMode} startPick={startPick} seekTo={seekTo}
            rulerTimecodeRef={rulerTimecodeRef} playheadFrame={playheadRef.current}
            zoneIn={zoneIn} zoneOut={zoneOut} markers={markers} onEditMarker={setEditMarker}
          />

          {/* tracks */}
          {trackIds.map((trackId) => {
            const meta = metaOf(trackId);
            const alias = trackAlias(state, trackId);
            const config = state.tracks?.[trackId] ?? {};
            const trackCaptions = meta.kind === 'caption' ? captionsOnTrack(state, trackId) : null;
            const items = state.items.filter((it) => it.track === trackId);
            const dragIsAudio = drag ? state.items.find((it) => it.id === drag.id)?.kind === 'audio' : false;
            const isDropTarget = drag?.mode === 'move' && drag.targetTrack === trackId && meta.kind === (dragIsAudio ? 'audio' : 'video') && !state.tracks?.[trackId]?.locked;
            const hidden = meta.kind === 'caption' ? !trackCaptions?.enabled : config.hidden ?? false;
            const headConfig = meta.kind === 'caption' ? { ...config, hidden } : config;
            const locked = config.locked ?? false;
            const kindLabel = meta.kind === 'video' ? '视频' : meta.kind === 'audio' ? '音频' : '字幕';
            const trackName = config.name || `${t(kindLabel)} ${alias.slice(1)}`;
            const busy = items.length > 0 || !!trackCaptions
              || (state.transitions ?? []).some((transition) => transition.trackId === trackId);
            return (
              <div key={trackId} className="cc-track-row" style={{ height: rowHeightOf(trackId), background: isDropTarget ? `color-mix(in srgb, ${theme.success} 15%, ${theme.bg})` : undefined }}>
                <TrackHead
                  trackId={trackId} kind={meta.kind} alias={alias} trackName={trackName} config={headConfig}
                  busy={busy} menuElevated={captionMenu?.id === trackId || duckMenu?.id === trackId}
                  width={HEADER_W} commands={commands}
                  onToggleCaptions={() => toggleCaptions(trackId)}
                  // 两个菜单都贴触发按钮弹,top 夹取余量=菜单最大高+边距(字幕 420、闪避≈300);
                  // 字幕菜单左夹取还要给右弹的翻译子菜单留位(212+4+128)
                  onToggleCaptionMenu={(rect) => {
                    setCaptionError(null);
                    setCaptionMenu((open) => open?.id === trackId ? null : { id: trackId, left: Math.min(rect.right + 5, window.innerWidth - 350), top: Math.max(8, Math.min(rect.top, window.innerHeight - 430)) });
                  }}
                  onToggleDuckMenu={(rect) => setDuckMenu((open) => open?.id === trackId ? null : { id: trackId, left: Math.min(rect.right + 5, window.innerWidth - 226), top: Math.max(8, Math.min(rect.top, window.innerHeight - 310)) })}
                  duckMenuPos={duckMenu?.id === trackId ? duckMenu : null}
                  onCloseDuckMenu={() => setDuckMenu(null)}
                >
                  {captionMenu?.id === trackId && (
                    <CaptionStyleMenu
                      state={state} commands={commands} trackId={trackId} pos={captionMenu}
                      error={captionError} onError={setCaptionError} onClose={() => setCaptionMenu(null)}
                    />
                  )}
                </TrackHead>
                {meta.kind === 'caption' ? <CaptionTrackLane state={state} captions={trackCaptions} trackId={trackId}
                  playheadFrame={playheadRef.current} px={px} locked={locked} hidden={hidden} snapping={snapping}
                  trackFromClientY={trackFromClientY} onUpdate={(patch) => commands.updateCaptions(patch, trackId)}
                  onMove={(move) => moveCaptionCue(trackId, move)}
                  onDelete={(laneId, index) => trackCaptions && commands.updateCaptions(removeManualCue(trackCaptions, laneId, index), trackId)} /> : <TrackLane
                  trackId={trackId} items={items} state={state} commands={commands} pointer={pointer}
                  editMode={editMode} pickMode={pickMode} locked={locked} hidden={hidden}
                  px={px} rowHeight={rowHeightOf(trackId)}
                  libDropTarget={libDropTarget} setLibDropTarget={setLibDropTarget}
                  applyLibraryToClip={applyLibraryToClip} applyLibraryToTrack={applyLibraryToTrack}
                  frameFromClientX={frameFromClientX} onContextMenu={setCtxMenu} scrollRef={scrollRef}
                />}
              </div>
            );
          })}

          {/* snap guide — appears while a drag edge is locked onto a target */}
          {drag && drag.snapAt !== null && (
            <div style={{ position: 'absolute', top: 0, left: HEADER_W + drag.snapAt * px, width: 1, height: RULER_H + tracksHeight, background: '#4fd1ff', pointerEvents: 'none', boxShadow: '0 0 4px #4fd1ff' }} />
          )}

          {/* selection-mode timerange marquee (time-marked drag) */}
          {pickDrag && Math.abs(pickDrag.endFrame - pickDrag.startFrame) > 0 && (
            <div style={{
              position: 'absolute', top: 0,
              left: HEADER_W + Math.min(pickDrag.startFrame, pickDrag.endFrame) * px,
              width: Math.abs(pickDrag.endFrame - pickDrag.startFrame) * px,
              height: RULER_H + tracksHeight,
              background: 'rgba(88,166,255,0.14)', borderLeft: '0.5px solid #58a6ff', borderRight: '0.5px solid #58a6ff',
              pointerEvents: 'none', zIndex: 5,
            }} />
          )}

          {/* playhead — GPU layer + rAF-coalesced updates for smoother scrub/play */}
          <div
            ref={playheadLineRef}
            className="cc-playhead"
            style={{
              position: 'absolute', top: 0, left: 0,
              transform: `translate3d(${HEADER_W + playheadRef.current * px}px,0,0)`,
              width: 1, height: RULER_H + tracksHeight,
              background: theme.textStrong, pointerEvents: 'none',
              boxShadow: '0 0 0 0.5px #0006',
              willChange: 'transform',
              zIndex: 13,
            }}
          >
            <div className="cc-playhead-handle" style={{ transform: 'translateX(-6px)', width: 13, height: 11, background: theme.textStrong, clipPath: 'polygon(0 0, 100% 0, 50% 100%)' }} />
          </div>
        </div>
      </div>

      {/* rubber-band selection rect (client/fixed so it tracks the pointer while scrolling) */}
      {marquee && (() => {
        const left = Math.min(marquee.x0, marquee.x1);
        const top = Math.min(marquee.y0, marquee.y1);
        const w = Math.abs(marquee.x1 - marquee.x0);
        const h = Math.abs(marquee.y1 - marquee.y0);
        if (w < 2 && h < 2) return null;
        return (
          <div
            aria-hidden
            style={{
              position: 'fixed',
              left, top, width: w, height: h,
              border: '1px solid rgba(120, 170, 255, 0.95)',
              background: 'rgba(80, 140, 255, 0.16)',
              borderRadius: 2,
              pointerEvents: 'none',
              zIndex: 80,
              boxSizing: 'border-box',
            }}
          />
        );
      })()}

      {/* clip right-click menu */}
      {ctxMenu && (() => {
        const item = state.items.find((it) => it.id === ctxMenu.id);
        if (!item) return null;
        return (
          <ClipContextMenu item={item} x={ctxMenu.x} y={ctxMenu.y} playhead={playheadRef.current} commands={commands}
            timeline={state}
            selectedIds={selectedIdsOf(state)}
            transitions={(state.transitions ?? []).filter((t) => t.incomingItemId === item.id || t.outgoingItemId === item.id)}
            fxClip={fxClip} onCopyFx={setFxClip} onClose={() => setCtxMenu(null)}
            onExportMg={exportMg} onConvertToVideo={convertToVideo} />
        );
      })()}

      {/* single-clip render status (导出 MG / 转为视频 take a few seconds) */}
      {clipJob && (
        <div style={{ position: 'fixed', left: '50%', bottom: 24, transform: 'translateX(-50%)', zIndex: 200,
          background: clipJob.error ? theme.accent : theme.panelAlt, color: clipJob.error ? theme.onAccent : theme.text,
          border: `0.5px solid ${theme.borderLight}`, borderRadius: 4, padding: '9px 16px', fontSize: 12.5,
          boxShadow: `0 8px 28px ${themeAlpha.shadow(0.5)}`, display: 'flex', alignItems: 'center', gap: 10 }}>
          <span>{clipJob.msg}</span>
          {clipJob.error && <button onClick={() => setClipJob(null)} style={{ background: 'none', border: 'none', color: theme.onAccent, cursor: 'pointer', padding: 0, lineHeight: 0, display: 'grid', placeItems: 'center' }}><Icon name="x" size={14} /></button>}
        </div>
      )}
    </section>
  );
}
