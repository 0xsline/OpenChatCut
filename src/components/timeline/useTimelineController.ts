import {
  useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { theme } from '../../theme';
import {
  captionTrackEntries, captionsOnTrack, defaultTrackId, selectedIdsOf,
  timelineTrackIds, trackAlias, trackKind, type TimelineItem, type TrackId,
} from '../../editor/types';
import { slipPreview as buildSlipPreview } from '../../editor/slip';
import { usePersistedState } from '../../hooks/usePersistedState';
import type { FxClip } from './ClipContextMenu';
import { useRecorder } from '../../audio/recorder';
import { captionsForTrack } from '../../captions/captionTrack';
import {
  captionSelectionKey, captionSelectionsInFrameRange, resolveCaptionSelection,
  type CaptionSelectionRef,
} from '../../captions/captionSelection';
import {
  moveTimelineSelectionByDelta, type TimelineSelectionMovePreview,
} from '../../captions/captionGroupMove';
import {
  createCaptionTimelineClipboard, createCaptionTrackFromClipboard,
  type CaptionTimelineClipboard,
} from '../../captions/captionTimelineClipboard';
import { newManualCaptions } from '../../captions/manualCaptions';
import { useTimelineShortcuts } from './useTimelineShortcuts';
import { useTimelinePointer } from './useTimelinePointer';
import { usePlayheadPaint } from './usePlayheadPaint';
import { useTimelineZoomController } from './useTimelineZoomController';
import { timelineFitTotalFrames } from './timelineFitRange';
import {
  timelineGestureHasDragged, timelinePointerShouldSeek, timelineSeekFrameAtClientX,
} from './timelineSeek';
import { isTimelineDragOverChat } from './timelineChatDrop';
import {
  HEADER_W, MAX_ROW, MIN_ROW, RULER_H, TRACK_ROW, buildTimelineIndexes,
  rulerMajorSeconds, rulerMinorCount, timelineFrameWindow, timelinePinnedItemIds,
  type EditMode,
} from './timelineUtil';
import {
  emitSelectionRef, itemRef, timerangeRef, useSelectionRefMode,
} from '../../agent/selection-refs';
import { getLocale, useT } from '../../i18n/locale';
import type { TimelineProps } from './timelineTypes';
import { useTimelineTrackMenus } from './useTimelineTrackMenus';
import { useTimelineMediaActions } from './useTimelineMediaActions';

export function useTimelineController({
  state, commands, playerRef, projectId, onRecordVoiceover, shortcutApiRef,
  onReviewItem, onSlipPreview, onHoverPreviewFrameChange,
  selectedCaptions = [], onSelectCaption = () => {}, onMarqueeCaptionSelect = () => {},
  onDropExternalFiles,
}: TimelineProps) {
  const t = useT();
  const locale = getLocale();
  const total = useMemo(() => timelineFitTotalFrames(state), [state]);
  const empty = total === 0;
  const liveStateRef = useRef(state);
  liveStateRef.current = state;
  const trackIds = timelineTrackIds(state);
  const indexes = useMemo(
    () => buildTimelineIndexes(state),
    [state],
  );
  const innerRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const seekGestureRef = useRef<{
    pointerId: number;
    button: number;
    startX: number;
    startY: number;
    dragged: boolean;
  } | null>(null);
  const [hoverPreviewFrame, setHoverPreviewFrame] = useState<number | null>(null);
  const hoverPreviewFrameRef = useRef<number | null>(null);
  const [captionSelectionMovePreview, setCaptionSelectionMovePreview] = useState<TimelineSelectionMovePreview | null>(null);
  const captionClipboardRef = useRef<CaptionTimelineClipboard | null>(null);
  const timelineId = (state as { id?: string }).id;
  const commitTimelineSelectionMove = useCallback((
    itemIds: readonly string[],
    captionSelections: readonly CaptionSelectionRef[],
    deltaFrames: number,
  ) => {
    setCaptionSelectionMovePreview(null);
    if (!deltaFrames) return;
    const current = liveStateRef.current;
    const next = moveTimelineSelectionByDelta(current, itemIds, captionSelections, deltaFrames);
    if (next !== current) commands.applyState(next);
  }, [commands]);
  const { zoom, setZoom, zoomBy, fitToView, pixelsPerFrame: px, trackScale } =
    useTimelineZoomController({ scrollRef, totalFrames: total, fps: state.fps, projectId, timelineId });
  const metaOf = (id: TrackId) => {
    const kind = trackKind(state, id);
    const color = kind === 'caption' ? theme.trackCaption
      : kind === 'video' ? theme.trackVideo
        : trackAlias(state, id) === 'A1' ? theme.trackAudioA1 : theme.trackAudioA2;
    return { kind, color };
  };
  // Playhead drawing machine: rAF frame direct drawing + Player watchdog + breakpoint resume (usePlayheadPaint)
  const {
    playheadRef, playheadLineRef, toolbarTimecodeRef, rulerTimecodeRef,
    paintPlayhead, setTimecodePreviewFrame, playing,
  } =
    usePlayheadPaint({ playerRef, projectId, timelineId, fps: state.fps, total, px });
  // editing mode (Selection V / Blade B / Trim N / Pen P). selection =
  // drag/move; blade = click a clip to cut it there; trim = edge-trim ripples
  // following clips; pen = draw opacity keyframes on the selected clip.
  const [editMode, setEditMode] = usePersistedState<EditMode>('cc.editMode', 'selection');
  // insert = push later clips when dropping library media; overwrite = place without shift
  const [placeMode, setPlaceMode] = usePersistedState<'insert' | 'overwrite'>('cc.placeMode', 'overwrite');
  // magnetic snapping (Snapping toggle, S). On = edges lock to guides.
  const [snapping, setSnapping] = usePersistedState('cc.snapping', true);
  const textClipCount = state.items.filter((item) => item.kind === 'text' || item.kind === 'motion-graphic').length;
  const captionsVisible = state.captionsHidden === true
    ? false
    : state.captionsHidden === false
      ? true
      : captionTrackEntries(state).some((entry) => entry.captions?.enabled) || textClipCount > 0;
  const {
    captionMenu, setCaptionMenu, trackMenu, setTrackMenu,
    captionError, setCaptionError, duckMenu, setDuckMenu,
    moveCaptionCue, openCaptionTrackMenu, openDuckTrackMenu,
    closeTrackDrillMenu, backFromTrackDrillMenu,
  } = useTimelineTrackMenus({ state, commands, t });
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
  /** Clips and caption cues whose range + track lane intersect the marquee. */
  const selectionInMarquee = (left: number, top: number, right: number, bottom: number) => {
    const f0 = frameFromClientX(left);
    const f1 = frameFromClientX(right);
    const lo = Math.min(f0, f1);
    const hi = Math.max(f0, f1);
    const r = innerRef.current?.getBoundingClientRect();
    if (!r) return { itemIds: [], captionSelections: [] };
    const hitTracks = new Set<TrackId>();
    let y = r.top + RULER_H;
    for (const t of trackIds) {
      const h = rowHeightOf(t);
      if (bottom >= y && top <= y + h) hitTracks.add(t);
      y += h;
    }
    const itemIds = state.items
      .filter((it) => {
        if (!hitTracks.has(it.track)) return false;
        if (state.tracks?.[it.track]?.locked) return false;
        const end = it.startFrame + it.durationInFrames;
        return end > lo && it.startFrame < hi;
      })
      .map((it) => it.id);
    const captionSelections = [...hitTracks].flatMap((trackId) => {
      if (trackKind(state, trackId) !== 'caption' || state.tracks?.[trackId]?.locked) return [];
      const captions = captionsOnTrack(state, trackId);
      return captions
        ? captionSelectionsInFrameRange(trackId, captions, state.items, state.fps, lo, hi)
        : [];
    });
    return { itemIds, captionSelections };
  };
  // clip right-click menu + effect clipboard (copy effect/paste effect)
  const [ctxMenu, setCtxMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const [fxClip, setFxClip] = useState<FxClip | null>(null);
  const addSelectionToChat = (selection: { items: TimelineItem[]; captions: CaptionSelectionRef[] }) => {
    const references = [
      ...selection.items.map((item) => itemRef(item, state)),
      ...selection.captions.flatMap((captionSelection) => {
        const resolved = resolveCaptionSelection(state, captionSelection);
        if (!resolved) return [];
        const cue = resolved.target.cue;
        const startFrame = Math.max(0, Math.round(cue.start * state.fps / 1000));
        const endFrame = Math.max(startFrame + 1, Math.round(cue.end * state.fps / 1000));
        const base = timerangeRef(startFrame, endFrame, state, { trackId: resolved.trackId });
        return [{ ...base, id: `caption:${captionSelectionKey(captionSelection) ?? base.id}`, name: `字幕：${cue.text}` }];
      }),
    ];
    for (const reference of references) emitSelectionRef(reference);
    requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>('[data-cc-chat-composer]')?.focus());
  };
  const [viewport, setViewport] = useState({ scrollLeft: 0, clientWidth: 0 });
  // content is at least as wide as the panel, so track rows/ruler never stop
  // short of the right edge when the project is short or zoomed out.
  const innerW = Math.max(HEADER_W + total * px + 240, viewport.clientWidth);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    let raf = 0;
    const measure = () => {
      raf = 0;
      const next = { scrollLeft: el.scrollLeft, clientWidth: el.clientWidth };
      setViewport((current) => current.scrollLeft === next.scrollLeft
        && current.clientWidth === next.clientWidth ? current : next);
    };
    const schedule = () => { if (!raf) raf = requestAnimationFrame(measure); };
    measure();
    const ro = new ResizeObserver(schedule);
    ro.observe(el);
    el.addEventListener('scroll', schedule, { passive: true });
    return () => {
      if (raf) cancelAnimationFrame(raf);
      ro.disconnect();
      el.removeEventListener('scroll', schedule);
    };
  }, []);
  const visibleWindow = useMemo(
    () => timelineFrameWindow(viewport.scrollLeft, viewport.clientWidth, px),
    [px, viewport.clientWidth, viewport.scrollLeft],
  );

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

  const copyCaptionSelections = (selections = selectedCaptions): boolean => {
    const clipboard = createCaptionTimelineClipboard(selections.flatMap((selection) => {
      const cue = resolveCaptionSelection(state, selection)?.target.cue;
      return cue ? [{ text: cue.text, start: cue.start, end: cue.end }] : [];
    }));
    if (!clipboard) return false;
    captionClipboardRef.current = clipboard;
    return true;
  };
  const pasteCaptionClipboard = (): boolean => {
    const captions = createCaptionTrackFromClipboard(
      captionClipboardRef.current,
      playheadRef.current * 1000 / state.fps,
    );
    if (!captions) return false;
    const trackId = `track_${crypto.randomUUID()}`;
    commands.batch([
      { type: 'track.create', track: { id: trackId, kind: 'caption', name: t('复制字幕') } },
      { type: 'setCaptions', captions, track: trackId },
    ], t('粘贴字幕'));
    return true;
  };

  // Pointer state machine: fragment drag/crop, blank frame selection, pen point drag, reference picking (useTimelinePointer)
  const pointer = useTimelinePointer({
    state, commands, editMode, snapping, pickMode, px,
    playheadRef, scrollRef, frameFromClientX, trackFromClientY, selectionInMarquee,
    selectedCaptions, onMarqueeCaptionSelect,
    isOverChatComposer: (clientX, clientY) => {
      const composer = document.querySelector<HTMLElement>('[data-cc-chat-composer]');
      return composer ? isTimelineDragOverChat(clientX, clientY, composer.getBoundingClientRect()) : false;
    },
    onDropSelectionToChat: (selection) => {
      const itemsById = new Map(state.items.map((item) => [item.id, item]));
      addSelectionToChat({
        items: selection.itemIds.flatMap((id) => {
          const item = itemsById.get(id);
          return item ? [item] : [];
        }),
        captions: selection.captionSelections,
      });
    },
  });
  const { drag, marquee, pickDrag, startPick, onPointerMove, onPointerUp, onPointerCancel } = pointer;
  const activeSelectionMovePreview: TimelineSelectionMovePreview | null = captionSelectionMovePreview ?? (
    drag?.mode === 'move' && pointer.dragSelection.captionSelections.length > 0
      ? {
          itemIds: pointer.dragSelection.itemIds,
          captionSelections: pointer.dragSelection.captionSelections,
          deltaFrames: drag.deltaF,
        }
      : null
  );
  const activeSlipPreview = useMemo(
    () => drag?.mode === 'slip' ? buildSlipPreview(state, drag.id, drag.deltaF) : null,
    [drag, state],
  );
  useEffect(() => {
    onSlipPreview?.(activeSlipPreview);
  }, [activeSlipPreview, onSlipPreview]);
  useEffect(() => () => onSlipPreview?.(null), [onSlipPreview]);

  const {
    relinkInputRef, trackInsertInputRef, clipJob, setClipJob,
    libDropTarget, setLibDropTarget, beginRelink, relinkFile,
    beginTrackInsert, insertTrackFiles, exportMg, convertToVideo,
    applyLibraryToClip, applyLibraryToTrack,
  } = useTimelineMediaActions({
    state, commands, liveStateRef, onDropExternalFiles, placeMode, t,
  });

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

  const frameAtClientX = (clientX: number) => {
    const rect = innerRef.current?.getBoundingClientRect();
    if (!rect) return null;
    return timelineSeekFrameAtClientX(clientX, {
      contentLeft: rect.left,
      headerWidth: HEADER_W,
      pixelsPerFrame: px,
      totalFrames: total,
    });
  };
  const clearHoverPreview = () => {
    if (hoverPreviewFrameRef.current === null) return;
    hoverPreviewFrameRef.current = null;
    setHoverPreviewFrame(null);
    setTimecodePreviewFrame(null);
    onHoverPreviewFrameChange?.(null);
  };
  const clearHoverPreviewRef = useRef(clearHoverPreview);
  clearHoverPreviewRef.current = clearHoverPreview;
  const updateHoverPreview = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (playing || event.buttons !== 0 || drag || marquee || pickDrag) {
      clearHoverPreview();
      return;
    }
    const frame = frameAtClientX(event.clientX);
    if (frame === hoverPreviewFrameRef.current) return;
    hoverPreviewFrameRef.current = frame;
    setHoverPreviewFrame(frame);
    setTimecodePreviewFrame(frame);
    onHoverPreviewFrameChange?.(frame);
  };
  useEffect(() => {
    if (playing || drag || marquee || pickDrag) clearHoverPreviewRef.current();
  }, [playing, drag, marquee, pickDrag]);
  const startSeekGesture = (event: ReactPointerEvent<HTMLDivElement>) => {
    const target = event.target instanceof Element ? event.target : null;
    if (!target?.closest('[data-timeline-track-lane], .cc-caption-track-lane')) return;
    seekGestureRef.current = {
      pointerId: event.pointerId,
      button: event.button,
      startX: event.clientX,
      startY: event.clientY,
      dragged: false,
    };
  };
  const updateSeekGesture = (event: ReactPointerEvent<HTMLDivElement>) => {
    const gesture = seekGestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId || gesture.dragged) return;
    gesture.dragged = timelineGestureHasDragged(
      gesture.startX,
      gesture.startY,
      event.clientX,
      event.clientY,
    );
  };
  const finishSeekGesture = (event: ReactPointerEvent<HTMLDivElement>) => {
    const gesture = seekGestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    seekGestureRef.current = null;
    if (!timelinePointerShouldSeek(gesture.button, pickMode, gesture.dragged)) return;
    const frame = frameAtClientX(event.clientX);
    if (frame !== null) seekFrame(frame);
  };
  useEffect(() => () => onHoverPreviewFrameChange?.(null), [onHoverPreviewFrameChange]);

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
    copySelectedCaptions: copyCaptionSelections, pasteCaptionClipboard,
  });

  const editing = markers.find((m) => m.id === editMarker) ?? null;
  const selectedIds = selectedIdsOf(state);
  const pinnedItemIds = useMemo(() => timelinePinnedItemIds(
    selectedIds,
    [drag?.id, pointer.penDrag?.itemId, ctxMenu?.id, libDropTarget, pickDrag?.item?.id],
    state.transitions ?? [],
  ), [
    ctxMenu?.id, drag?.id, libDropTarget, pickDrag?.item?.id, pointer.penDrag?.itemId,
    selectedIds, state.transitions,
  ]);

  return {
    state, commands, playerRef, onRecordVoiceover, onReviewItem, onDropExternalFiles,
    selectedCaptions, onSelectCaption, onMarqueeCaptionSelect,
    t, locale, total, empty, trackIds, indexes, innerRef, scrollRef,
    relinkInputRef, trackInsertInputRef, seekGestureRef,
    hoverPreviewFrame, captionSelectionMovePreview, setCaptionSelectionMovePreview,
    commitTimelineSelectionMove, zoom, setZoom, px, trackScale, metaOf,
    playheadRef, playheadLineRef, toolbarTimecodeRef, rulerTimecodeRef,
    paintPlayhead, playing, editMode, placeMode, setPlaceMode, snapping,
    captionsVisible, captionMenu, setCaptionMenu, trackMenu, setTrackMenu,
    duckMenu, setDuckMenu, captionError, setCaptionError,
    moveCaptionCue, openCaptionTrackMenu, openDuckTrackMenu,
    closeTrackDrillMenu, backFromTrackDrillMenu, recorder, toggleCaptions,
    pickMode, addSelectionToChat, ctxMenu, setCtxMenu, fxClip, setFxClip, clipJob, setClipJob,
    beginRelink, relinkFile, beginTrackInsert, insertTrackFiles, exportMg, convertToVideo,
    innerW, visibleWindow, rowHeightOf, tracksHeight,
    majorFrames, minorFrames, minorTicksPerMajor, rulerSpanFrames,
    frameFromClientX, trackFromClientY, copyCaptionSelections, pasteCaptionClipboard,
    pointer, drag, marquee, pickDrag, startPick, onPointerMove, onPointerUp, onPointerCancel,
    activeSelectionMovePreview, libDropTarget, setLibDropTarget,
    applyLibraryToClip, applyLibraryToTrack, seekTo,
    clearHoverPreview, updateHoverPreview, startSeekGesture, updateSeekGesture, finishSeekGesture,
    markers, zoneIn, zoneOut, editing, editMarker, setEditMarker, pinnedItemIds,
  };
}
