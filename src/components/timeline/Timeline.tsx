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
import { CaptionTrackLane } from '../../captions/CaptionTrackLane';
import { captionsForTrack } from '../../captions/captionTrack';
import { newManualCaptions } from '../../captions/manualCaptions';
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
  // Playhead painting machine: rAF frame direct drawing + Player watchdog + breakpoint resume (usePlayheadPaint)
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
  // The error line is attributed to Timeline: The "Turn on subtitles" button outside the menu will also write it (there is no text script for this track), and it will be displayed in the menu
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
  // Duck (auto-dodge) role menu is a track-head menu item, not a
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
  // mic voiceover recording (recording narration). Toggle to start/stop; the blob
  // is uploaded + dropped on an audio track by the parent.
  const recorder = useRecorder(onRecordVoiceover ?? (() => {}));
  const toggleCaptions = (trackId: TrackId) => {
    const current = captionsOnTrack(state, trackId);
    if (current) { commands.updateCaptions({ enabled: !current.enabled }, trackId); return; }
    const captions = captionsForTrack(state, trackId);
    commands.setCaptions(captions ?? newManualCaptions(), trackId);
  };
  // selection mode: clicks/drags pick REFERENCES for the chat
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
  // clip right-click menu + effect clipboard (copy effect/paste effect)
  const [ctxMenu, setCtxMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const [fxClip, setFxClip] = useState<FxClip | null>(null);
  // single-clip render (export MG animation / convert to video) status toast
  const [clipJob, setClipJob] = useState<{ msg: string; error?: boolean } | null>(null);
  const exportMg = async (it: TimelineItem) => {
    setClipJob({ msg: t('Export MG Animation (ProRes 4444）…') });
    try { await exportClipMov(state, it); setClipJob(null); }
    catch (e) { setClipJob({ msg: e instanceof Error ? e.message : t('Export failed'), error: true }); }
  };
  const convertToVideo = async (it: TimelineItem) => {
    setClipJob({ msg: t('Moving to video…') });
    try { const src = await bakeClipToVideo(state, it); commands.replaceItemMedia(it.id, src); setClipJob(null); }
    catch (e) { setClipJob({ msg: e instanceof Error ? e.message : t('Conversion failed'), error: true }); }
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

  // Pointer state machine: fragment dragging/cropping, blank frame selection, pen point dragging, reference picking (useTimelinePointer)
  const pointer = useTimelinePointer({
    state, commands, editMode, snapping, pickMode, px,
    playheadRef, scrollRef, frameFromClientX, trackFromClientY, itemsInMarquee,
  });
  const { drag, marquee, pickDrag, startPick, onPointerMove, onPointerUp } = pointer;

  /** library resource dropped on a clip (fx/lut/zoom/transition) or track (sound/mg) */
  const [libDropTarget, setLibDropTarget] = useState<string | null>(null);

  // If drag and drop is rejected, a reason must be given - previously it silently returned false, and the user only saw "No response after dragging"
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
  // Shortcut API assembly + I/O interval/JKL shuttle/fragment clipboard (the whole machine is in useTimelineShortcuts)
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
          {t('Selection mode: point fragment reference · Drag over ruler/Blank time period · Click the ruler to mark a time point — the quote will be added to the chat input box')}
        </div>
      )}

      {/* scrollable ruler + tracks (playhead spans both). Ctrl/⌘+wheel = time
          zoom at cursor, Alt+wheel = track-height zoom (native listener above). */}
      <div ref={scrollRef} style={{ overflow: 'auto', flex: 1, minHeight: 0 }} onPointerMove={onPointerMove} onPointerUp={onPointerUp}
        title={t('Ctrl/⌘+Scroll wheel zoom timeline · Alt+Scroll wheel Zoom track height')}>
        <div ref={innerRef} style={{ position: 'relative', width: innerW }}>
          {/* ruler (click to seek, hold to scrub; selection mode: click = timepoint, drag = timerange).
              Play the headlines/The triangle is pointerEvents:none,Click it to click the ruler——scrub The same path takes effect. */}
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
            const kindLabel = meta.kind === 'video' ? 'video' : meta.kind === 'audio' ? 'Audio' : 'subtitles';
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
                  // Both menus are attached with trigger buttons, top clamping margin = maximum menu height + margin (subtitles 420, dodge ≈ 300);
                  // When the subtitle menu is clipped to the left, space should be reserved for the translation submenu that pops to the right (212+4+128)
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
                {meta.kind === 'caption' ? <CaptionTrackLane state={state} captions={trackCaptions} px={px} locked={locked} hidden={hidden}
                  onUpdate={(patch) => commands.updateCaptions(patch, trackId)} /> : <TrackLane
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

      {/* single-clip render status (Export MG / Convert to video take a few seconds) */}
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
