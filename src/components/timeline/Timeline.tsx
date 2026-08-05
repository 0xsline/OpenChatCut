import {
  useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState,
  type PointerEvent as ReactPointerEvent, type RefObject,
} from 'react';
import type { PlayerRef } from '@remotion/player';
import { theme, themeAlpha } from '../../theme';
import {
  captionTrackEntries, captionsOnTrack, defaultTrackId, selectedIdsOf, timelineTrackIds, trackAlias, trackKind,
  type TimelineItem, type TimelineState, type TrackId,
} from '../../editor/types';
import type { EditorCommands } from '../../editor/store';
import { timelineItemAssetId } from '../../editor/mediaAssetUsage';
import { slipPreview as buildSlipPreview, type SlipPreview } from '../../editor/slip';
import { usePersistedState } from '../../hooks/usePersistedState';
import { ClipContextMenu, type FxClip } from './ClipContextMenu';
import { Icon } from '../icons';
import { useRecorder } from '../../audio/recorder';
import { exportClipMov, bakeClipToVideo } from '../../media/clipExport';
import { importMedia } from '../../media/upload';
import { CaptionStyleMenu } from '../../captions/CaptionStyleMenu';
import { CaptionTrackLane, type CaptionCueMove } from '../../captions/CaptionTrackLane';
import { captionsForTrack } from '../../captions/captionTrack';
import {
  captionSelectionKey, captionSelectionsInFrameRange,
  resolveCaptionSelection,
  type CaptionSelectOptions,
  type CaptionSelectionRef,
} from '../../captions/captionSelection';
import {
  moveTimelineSelectionByDelta,
  type TimelineSelectionMovePreview,
} from '../../captions/captionGroupMove';
import {
  createCaptionTimelineClipboard,
  createCaptionTrackFromClipboard,
  type CaptionTimelineClipboard,
} from '../../captions/captionTimelineClipboard';
import {
  appendManualCueToFirstLane, isManualCaptionEntry, newManualCaptions, placeManualCueTiming,
  promoteCaptionEntries, removeManualCue, updateManualCue,
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
import { timelineFitTotalFrames } from './timelineFitRange';
import { trackDeletePlan } from './trackDelete';
import { TrackContextMenu } from './TrackContextMenu';
import { closeCaptionTrackGaps, trackClearPlan } from './trackContextOperations';
import {
  timelineGestureHasDragged,
  timelinePointerShouldSeek,
  timelineSeekFrameAtClientX,
} from './timelineSeek';
import { applyLibraryToClip as applyToClip, applyLibraryToTrack as applyToTrack } from './libraryDropActions';
import { isTimelineDragOverChat } from './timelineChatDrop';
import {
  HEADER_W, MAX_ROW, MIN_ROW, RULER_H, TRACK_ROW, buildTimelineIndexes,
  rulerMajorSeconds, rulerMinorCount, timelineFrameWindow, timelinePinnedItemIds, type EditMode,
} from './timelineUtil';
import type { LibraryDragPayload } from '../../library/drag';
import { emitSelectionRef, itemRef, timerangeRef, useSelectionRefMode } from '../../agent/selection-refs';
import { getLocale, useT } from '../../i18n/locale';
import type { TimelineShortcutApi } from '../../shortcuts/timelineApi';
import {
  CAPTION_SELECTION_OWNER_SELECTOR,
  CAPTION_SELECTION_TIMELINE_CLIP_SELECTOR,
  CAPTION_SELECTION_TIMELINE_HEAD_SELECTOR,
  CAPTION_SELECTION_TIMELINE_REGION_SELECTOR,
  shouldClearCaptionSelectionFromPointer,
} from '../../captions/captionSelectionInteraction';

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
  onReviewItem?: (request: { itemId: string; frame: number; clientX: number; clientY: number }) => void;
  onSlipPreview?: (preview: SlipPreview | null) => void;
  /** Read-only frame under the pointer; never mutates the formal playhead. */
  onHoverPreviewFrameChange?: (frame: number | null) => void;
  selectedCaptions?: CaptionSelectionRef[];
  onSelectCaption?: (selection: CaptionSelectionRef | null, options?: CaptionSelectOptions) => void;
  onMarqueeCaptionSelect?: (
    selections: CaptionSelectionRef[],
    options: { additive: boolean; preserveWithItems: boolean },
  ) => void;
  onDropExternalFiles?: (files: File[], trackId: TrackId, startFrame: number) => void;
}

export function Timeline({
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
  const relinkInputRef = useRef<HTMLInputElement>(null);
  const relinkItemRef = useRef<TimelineItem | null>(null);
  const trackInsertInputRef = useRef<HTMLInputElement>(null);
  const trackInsertTargetRef = useRef<{ trackId: TrackId; frame: number } | null>(null);
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
  const [captionMenu, setCaptionMenu] = useState<{ id: TrackId; left: number; top: number; translate?: boolean } | null>(null);
  const [trackMenu, setTrackMenu] = useState<{ trackId: TrackId; x: number; y: number; frame: number } | null>(null);
  const [trackMenuReturn, setTrackMenuReturn] = useState<{ trackId: TrackId; x: number; y: number; frame: number } | null>(null);
  // Error line return Timeline: The "Turn on captions" button outside the menu will also write it (there is no text script for this track), and it will be displayed in the menu
  const [captionError, setCaptionError] = useState<string | null>(null);
  const moveCaptionCue = (sourceTrackId: TrackId, move: CaptionCueMove) => {
    const source = captionsOnTrack(state, sourceTrackId);
    if (!source) return;
    const targetTrackId = trackKind(state, move.targetTrackId) === 'caption'
      && !state.tracks?.[move.targetTrackId]?.locked ? move.targetTrackId : sourceTrackId;
    const sourceLane = source.sourceEntries?.find((entry) => entry.id === move.laneId);
    const sourceCue = sourceLane?.words?.[move.index];
    if (targetTrackId === sourceTrackId) {
      const others = (sourceLane?.words ?? []).filter((_, index) => index !== move.index);
      const placed = placeManualCueTiming(others, move.startMs, move.endMs - move.startMs);
      if (!placed || (sourceCue?.start === placed.start && sourceCue.end === placed.end)) return;
      const patch = updateManualCue(
        source,
        move.laneId,
        move.index,
        move.text,
        placed.start,
        placed.end,
      );
      if (patch) commands.updateCaptions(patch, sourceTrackId);
      return;
    }
    const target = captionsOnTrack(state, targetTrackId) ?? newManualCaptions();
    const targetWords = promoteCaptionEntries(target, state.items).find(isManualCaptionEntry)?.words ?? [];
    const placed = placeManualCueTiming(targetWords, move.startMs, move.endMs - move.startMs);
    if (!placed) return;
    const targetPatch = appendManualCueToFirstLane(target, state.items, move.text, placed.start, placed.end);
    if (!targetPatch) return;
    commands.batch([
      { type: 'updateCaptions', patch: removeManualCue(source, move.laneId, move.index), track: sourceTrackId },
      { type: 'setCaptions', captions: { ...target, ...targetPatch }, track: targetTrackId },
    ], t('移动字幕'));
  };
  useEffect(() => {
    if (!captionMenu) return;
    const close = (event: PointerEvent) => {
      if (!(event.target instanceof Element)) return;
      const target = event.target;
      if (!target.closest('.cc-caption-style-menu') && !target.closest('[data-caption-menu-trigger]')) {
        setCaptionMenu(null);
        setTrackMenuReturn(null);
      }
    };
    document.addEventListener('pointerdown', close, true);
    return () => document.removeEventListener('pointerdown', close, true);
  }, [captionMenu]);
  // Duck (auto-dodge) role menu is a track-head menu item, not a
  // permanent widget. Sets the per-track role (anchor speech / follower music) + duck depth;
  // the engine (TimelineComposition duckGain) already reacts to it.
  const [duckMenu, setDuckMenu] = useState<{ id: TrackId; left: number; top: number } | null>(null);
  useEffect(() => {
    if (!duckMenu) return;
    const close = (event: PointerEvent) => {
      if (!(event.target instanceof Element)) return;
      const target = event.target;
      if (!target.closest('.cc-duck-menu') && !target.closest('[data-duck-menu-trigger]')) {
        setDuckMenu(null);
        setTrackMenuReturn(null);
      }
    };
    document.addEventListener('pointerdown', close, true);
    return () => document.removeEventListener('pointerdown', close, true);
  }, [duckMenu]);
  const openCaptionTrackMenu = (
    trackId: TrackId,
    rect: DOMRect,
    translate = false,
    returnMenu: typeof trackMenuReturn = null,
    replace = false,
  ) => {
    setCaptionError(null);
    setDuckMenu(null);
    setTrackMenuReturn(returnMenu);
    setCaptionMenu({
      id: trackId,
      left: replace
        ? Math.max(8, Math.min(rect.left, window.innerWidth - 212 - 8))
        : Math.min(rect.right + 5, window.innerWidth - 350),
      top: Math.max(8, Math.min(rect.top, window.innerHeight - 430)),
      translate,
    });
  };
  const openDuckTrackMenu = (
    trackId: TrackId,
    rect: DOMRect,
    returnMenu: typeof trackMenuReturn = null,
    replace = false,
  ) => {
    setCaptionMenu(null);
    setTrackMenuReturn(returnMenu);
    setDuckMenu({
      id: trackId,
      left: replace
        ? Math.max(8, Math.min(rect.left, window.innerWidth - 160 - 8))
        : Math.min(rect.right + 5, window.innerWidth - 226),
      top: Math.max(8, Math.min(rect.top, window.innerHeight - 310)),
    });
  };
  const closeTrackDrillMenu = () => {
    setCaptionMenu(null);
    setDuckMenu(null);
    setTrackMenuReturn(null);
  };
  const backFromTrackDrillMenu = () => {
    setCaptionMenu(null);
    setDuckMenu(null);
    if (trackMenuReturn) setTrackMenu(trackMenuReturn);
    setTrackMenuReturn(null);
  };
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
  // single-clip render (export MG animation / convert to video) status toast
  const [clipJob, setClipJob] = useState<{ msg: string; error?: boolean } | null>(null);
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
  const beginRelink = (item: TimelineItem) => {
    relinkItemRef.current = item;
    requestAnimationFrame(() => relinkInputRef.current?.click());
  };
  const relinkFile = async (files: FileList | null) => {
    const file = files?.[0];
    const item = relinkItemRef.current;
    relinkItemRef.current = null;
    if (relinkInputRef.current) relinkInputRef.current.value = '';
    if (!file || !item) return;
    try {
      const media = await importMedia(file, state.fps);
      const liveState = liveStateRef.current;
      const liveItem = liveState.items.find((candidate) => candidate.id === item.id);
      if (!liveItem) return;
      if (liveState.tracks?.[liveItem.track]?.locked) throw new Error(t('轨道已锁定'));
      const liveAssets = liveState.assets ?? [];
      if (media.kind !== liveItem.kind) throw new Error(t('请重新选择同类型文件'));
      const poolAssetId = timelineItemAssetId(liveItem, liveAssets);
      if (poolAssetId) {
        commands.relinkMediaAsset(poolAssetId, {
          src: media.src,
          name: media.name,
          durationInFrames: media.durationInFrames,
          width: media.width,
          height: media.height,
          kind: media.kind,
          sourceRevision: media.sourceRevision,
          sourceSize: media.sourceSize,
          sourceModifiedAt: media.sourceModifiedAt,
          sourceFilename: media.sourceFilename,
          originalFilePath: media.originalFilePath,
        });
      } else {
        commands.relinkTimelineItem(liveItem.id, {
          src: media.src,
          name: media.name,
          durationInFrames: media.durationInFrames,
          width: media.width,
          height: media.height,
          kind: media.kind,
          sourceRevision: media.sourceRevision,
          sourceSize: media.sourceSize,
          sourceModifiedAt: media.sourceModifiedAt,
          sourceFilename: media.sourceFilename,
          originalFilePath: media.originalFilePath,
        });
      }
      const msg = t('已重新链接文件');
      setClipJob({ msg });
      window.setTimeout(() => setClipJob((current) => current?.msg === msg && !current.error ? null : current), 5_000);
    } catch (error) {
      setClipJob({ msg: error instanceof Error ? error.message : t('重新链接文件失败'), error: true });
    }
  };
  const beginTrackInsert = (trackId: TrackId, frame: number) => {
    const input = trackInsertInputRef.current;
    if (!input || !onDropExternalFiles) return;
    const kind = trackKind(state, trackId);
    input.accept = kind === 'audio' ? 'audio/*'
      : kind === 'caption' ? '.srt,.vtt,.txt,text/plain'
        : 'video/*,image/*,.gif,.svg';
    trackInsertTargetRef.current = { trackId, frame };
    requestAnimationFrame(() => input.click());
  };
  const insertTrackFiles = (files: FileList | null) => {
    const target = trackInsertTargetRef.current;
    trackInsertTargetRef.current = null;
    if (trackInsertInputRef.current) trackInsertInputRef.current.value = '';
    if (!target || !files?.length || !onDropExternalFiles) return;
    onDropExternalFiles(Array.from(files), target.trackId, target.frame);
  };
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

  /** library resource dropped on a clip (fx/lut/zoom/transition) or track (sound/mg) */
  const [libDropTarget, setLibDropTarget] = useState<string | null>(null);

  // If drag and drop is rejected, a reason must be given - previously silent return false, the user only sees "Drag and no response"
  const dropNotice = (msg: string) => {
    setClipJob({ msg });
    window.setTimeout(() => setClipJob((cur) => (cur && cur.msg === msg && !cur.error ? null : cur)), 3000);
  };

  const dropCtx = {
    state,
    commands,
    notice: dropNotice,
    getState: () => liveStateRef.current,
    getAssets: () => liveStateRef.current.assets ?? [],
  };
  const applyLibraryToClip = (payload: LibraryDragPayload, item: TimelineItem): boolean =>
    applyToClip(dropCtx, payload, item);
  const applyLibraryToTrack = (payload: LibraryDragPayload, trackId: TrackId, startFrame: number): boolean =>
    applyToTrack(dropCtx, payload, trackId, startFrame, placeMode === 'insert', placeMode === 'overwrite');

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

  return (
    <section
      className="cc-timeline"
      data-cc-shortcut-surface="timeline"
      tabIndex={-1}
      onPointerDownCapture={(event) => {
        if (!(event.target as HTMLElement).closest('button, input, select, textarea, [contenteditable="true"]')) {
          event.currentTarget.focus({ preventScroll: true });
        }
        const target = event.target as HTMLElement;
        if (!target.closest(CAPTION_SELECTION_OWNER_SELECTOR)
          && shouldClearCaptionSelectionFromPointer({
            insideTimelineClip: !!target.closest(CAPTION_SELECTION_TIMELINE_CLIP_SELECTOR),
            insideTimelineBlank: !!target.closest(CAPTION_SELECTION_TIMELINE_REGION_SELECTOR),
            insideTimelineHead: !!target.closest(CAPTION_SELECTION_TIMELINE_HEAD_SELECTOR),
            additive: event.metaKey || event.ctrlKey,
          })) {
          onSelectCaption(null);
        }
      }}
      style={{ flex: 1, borderLeft: `0.5px solid ${theme.border}`, background: theme.bg, display: 'flex', flexDirection: 'column', minHeight: 0, overflow: 'hidden', position: 'relative' }}
    >
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
      <div ref={scrollRef} style={{ overflow: 'auto', flex: 1, minHeight: 0 }}
        onPointerDownCapture={startSeekGesture}
        onPointerMoveCapture={(event) => { updateSeekGesture(event); updateHoverPreview(event); }}
        onPointerUpCapture={finishSeekGesture}
        onPointerCancelCapture={(event) => {
          if (seekGestureRef.current?.pointerId === event.pointerId) seekGestureRef.current = null;
          clearHoverPreview();
        }}
        onPointerLeave={clearHoverPreview}
        onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerCancel}
        title={t('Ctrl/⌘+滚轮 缩放时间轴 · Alt+滚轮 缩放轨道高度')}>
        <div ref={innerRef} style={{ position: 'relative', width: innerW }}>
          {/* ruler (click to seek, hold to scrub; selection mode: click = timepoint, drag = timerange).
The playhead line/triangle is pointerEvents:none, click it to click the ruler - scrub the same path to take effect.*/}
          <TimelineRuler
            state={state} empty={empty} px={px}
            majorFrames={majorFrames} minorFrames={minorFrames} minorTicksPerMajor={minorTicksPerMajor}
            rulerEndFrame={rulerSpanFrames} visibleWindow={visibleWindow}
            pickMode={pickMode} startPick={startPick} seekTo={seekTo}
            rulerTimecodeRef={rulerTimecodeRef} playheadFrame={playheadRef.current}
            zoneIn={zoneIn} zoneOut={zoneOut} markers={markers} onEditMarker={setEditMarker}
            pinnedMarkerId={editMarker}
          />

          {/* tracks */}
          {trackIds.map((trackId) => {
            const meta = metaOf(trackId);
            const alias = trackAlias(state, trackId);
            const config = state.tracks?.[trackId] ?? {};
            const trackCaptions = meta.kind === 'caption' ? captionsOnTrack(state, trackId) : null;
            const dragIsAudio = drag ? indexes.itemById.get(drag.id)?.kind === 'audio' : false;
            const isDropTarget = drag?.mode === 'move' && drag.targetTrack === trackId && meta.kind === (dragIsAudio ? 'audio' : 'video') && !state.tracks?.[trackId]?.locked;
            const hidden = meta.kind === 'caption' ? !trackCaptions?.enabled : config.hidden ?? false;
            const headConfig = meta.kind === 'caption' ? { ...config, hidden } : config;
            const locked = config.locked ?? false;
            const kindLabel = meta.kind === 'video' ? '视频' : meta.kind === 'audio' ? '音乐' : '字幕';
            // Stable title (类型+序号) plus optional custom name as a second row,
            // so track naming never drifts when AI creates tracks with its own labels.
            const titleName = locale === 'en' ? alias : `${t(kindLabel)}${alias.slice(1)}`;
            const customName = config.name || undefined;
            const deletePlan = trackDeletePlan(state, trackId);
            return (
              <div key={trackId} className="cc-track-row" style={{ height: rowHeightOf(trackId), background: isDropTarget ? `color-mix(in srgb, ${theme.success} 15%, ${theme.bg})` : undefined }}>
                <TrackHead
                  trackId={trackId} kind={meta.kind} trackName={titleName} customName={customName} config={headConfig}
                  deleteBlockedReason={deletePlan.blockedReason}
                  onDelete={() => {
                    if (deletePlan.requiresConfirmation
                      && !window.confirm(t('删除轨道会同时删除其中的片段、字幕和转场，确认继续吗？'))) return;
                    if (deletePlan.actions.length) commands.batch(deletePlan.actions, t('删除轨道'));
                  }}
                  menuElevated={captionMenu?.id === trackId || duckMenu?.id === trackId}
                  width={HEADER_W} commands={commands}
                  onToggleCaptions={() => toggleCaptions(trackId)}
                  // Both menus are attached with trigger buttons, top clamping margin = maximum menu height + margin (captions 420, dodge ≈ 300);
                  // When the caption menu is clipped to the left, space should be reserved for the translation submenu that pops to the right (212+4+128)
                  onToggleCaptionMenu={(rect) => {
                    if (captionMenu?.id === trackId) closeTrackDrillMenu();
                    else openCaptionTrackMenu(trackId, rect);
                  }}
                  onToggleDuckMenu={(rect) => {
                    if (duckMenu?.id === trackId) closeTrackDrillMenu();
                    else openDuckTrackMenu(trackId, rect);
                  }}
                  duckMenuPos={duckMenu?.id === trackId ? duckMenu : null}
                  onCloseDuckMenu={closeTrackDrillMenu}
                  onBackDuckMenu={backFromTrackDrillMenu}
                >
                  {captionMenu?.id === trackId && (
                    <CaptionStyleMenu
                      state={state} commands={commands} trackId={trackId} pos={captionMenu}
                      error={captionError} onError={setCaptionError} onClose={closeTrackDrillMenu}
                      onBack={backFromTrackDrillMenu}
                      initialTranslateOpen={captionMenu.translate}
                    />
                  )}
                </TrackHead>
                {meta.kind === 'caption' ? <CaptionTrackLane state={state} captions={trackCaptions} trackId={trackId}
                  playheadFrame={playheadRef.current} px={px} rowHeight={rowHeightOf(trackId)} locked={locked} hidden={hidden} snapping={snapping}
                  trackFromClientY={trackFromClientY}
                  selectedCaptions={selectedCaptions} selectedItemIds={selectedIdsOf(state)}
                  selectionMovePreview={activeSelectionMovePreview}
                  onSelectCaption={onSelectCaption}
                  onSelectionMovePreview={setCaptionSelectionMovePreview}
                  onMoveTimelineSelection={commitTimelineSelectionMove}
                  onUpdate={(patch) => commands.updateCaptions(patch, trackId)}
                  onMove={(move) => moveCaptionCue(trackId, move)}
                  onDropExternalFiles={onDropExternalFiles}
                  frameFromClientX={frameFromClientX}
                  isOverChatComposer={(clientX, clientY) => {
                    const composer = document.querySelector<HTMLElement>('[data-cc-chat-composer]');
                    return composer ? isTimelineDragOverChat(clientX, clientY, composer.getBoundingClientRect()) : false;
                  }}
                  onAddSelectionToChat={(selection) => {
                    const itemsById = new Map(state.items.map((item) => [item.id, item]));
                    addSelectionToChat({
                      items: selection.itemIds.flatMap((id) => {
                        const item = itemsById.get(id);
                        return item ? [item] : [];
                      }),
                      captions: selection.captionSelections,
                    });
                  }}
                  onTrackContextMenu={(menu) => {
                    setCtxMenu(null);
                    setCaptionMenu(null);
                    setDuckMenu(null);
                    setTrackMenu(menu);
                  }}
                  onCopyCue={() => { copyCaptionSelections(); }}
                  onPasteCue={pasteCaptionClipboard}
                  onDelete={(laneId, index) => trackCaptions && commands.updateCaptions(removeManualCue(trackCaptions, laneId, index), trackId)} /> : <TrackLane
                  trackId={trackId} indexes={indexes} state={state} commands={commands} pointer={pointer}
                  editMode={editMode} pickMode={pickMode} locked={locked} hidden={hidden} muted={config.muted ?? false}
                  px={px} rowHeight={rowHeightOf(trackId)} visibleWindow={visibleWindow}
                  pinnedItemIds={pinnedItemIds}
                  selectionMovePreview={captionSelectionMovePreview}
                  libDropTarget={libDropTarget} setLibDropTarget={setLibDropTarget}
                  applyLibraryToClip={applyLibraryToClip} applyLibraryToTrack={applyLibraryToTrack}
                  rippleOnDrop={placeMode === 'insert'}
                  overwriteOnDrop={placeMode === 'overwrite'}
                  onDropExternalFiles={onDropExternalFiles}
                  frameFromClientX={frameFromClientX} onContextMenu={(menu) => { setTrackMenu(null); setCtxMenu(menu); }}
                  onTrackContextMenu={(menu) => {
                    setCtxMenu(null);
                    setCaptionMenu(null);
                    setDuckMenu(null);
                    setTrackMenu(menu);
                  }} scrollRef={scrollRef}
                />}
              </div>
            );
          })}

          {/* snap guide — appears while a drag edge is locked onto a target */}
          {drag && drag.snapAt !== null && (
            <div className="cc-snap-guide" style={{ position: 'absolute', top: 0, left: HEADER_W + drag.snapAt * px, height: RULER_H + tracksHeight }} />
          )}

          {hoverPreviewFrame !== null && (
            <div
              aria-hidden
              className="cc-timeline-hover-guide"
              style={{ left: HEADER_W + hoverPreviewFrame * px, height: RULER_H + tracksHeight }}
            />
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
              height: RULER_H + tracksHeight,
              pointerEvents: 'none',
              willChange: 'transform',
              zIndex: 30,
            }}
          >
            <div className="cc-playhead-handle" style={{ transform: 'translateX(-6px)', width: 13, height: 11, clipPath: 'polygon(0 0, 100% 0, 50% 100%)' }} />
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

      <input
        ref={relinkInputRef}
        type="file"
        accept="video/*,audio/*,image/*,.gif,.svg"
        hidden
        onChange={(event) => { void relinkFile(event.currentTarget.files); }}
      />
      <input
        ref={trackInsertInputRef}
        type="file"
        multiple
        hidden
        onChange={(event) => insertTrackFiles(event.currentTarget.files)}
      />

      {/* blank-track right-click menu */}
      {trackMenu && (() => {
        const trackId = trackMenu.trackId;
        if (!trackIds.includes(trackId)) return null;
        const kind = trackKind(state, trackId);
        const config = state.tracks?.[trackId] ?? {};
        const captions = kind === 'caption' ? captionsOnTrack(state, trackId) : null;
        const items = state.items.filter((item) => item.track === trackId);
        const captionSelections = captions
          ? captionSelectionsInFrameRange(trackId, captions, state.items, state.fps, 0, Number.MAX_SAFE_INTEGER)
          : [];
        const sortedItems = [...items].sort((a, b) => a.startFrame - b.startFrame);
        const captionTighten = captions ? closeCaptionTrackGaps(captions) : null;
        const canTighten = kind === 'caption'
          ? !!captionTighten?.changed
          : sortedItems.some((item, index) => index > 0
            && item.startFrame > sortedItems[index - 1]!.startFrame + sortedItems[index - 1]!.durationInFrames);
        const clearPlan = trackClearPlan(state, trackId);
        const deletePlan = trackDeletePlan(state, trackId);
        const hidden = kind === 'caption' ? !captions?.enabled : !!config.hidden;
        return (
          <TrackContextMenu
            kind={kind}
            x={trackMenu.x}
            y={trackMenu.y}
            hidden={hidden}
            muted={!!config.muted}
            locked={!!config.locked}
            canTighten={canTighten}
            hasContents={clearPlan.hasContents}
            hasSelectable={kind === 'caption' ? captionSelections.length > 0 : items.length > 0}
            deleteBlockedReason={deletePlan.blockedReason}
            onInsert={() => beginTrackInsert(trackId, trackMenu.frame)}
            onTighten={() => {
              if (kind === 'caption' && captionTighten?.changed) commands.setCaptions(captionTighten.captions, trackId);
              else if (kind !== 'caption') commands.tightenTrack(trackId);
            }}
            onSelectAll={() => {
              if (kind === 'caption') {
                commands.selectItems([]);
                onMarqueeCaptionSelect(captionSelections, { additive: false, preserveWithItems: false });
              } else {
                onMarqueeCaptionSelect([], { additive: false, preserveWithItems: false });
                commands.selectItems(items.map((item) => item.id));
              }
            }}
            onClear={() => {
              if (clearPlan.blockedReason || !clearPlan.hasContents) return;
              if (!window.confirm(t('清空轨道会删除其中的片段、字幕和转场，确认继续吗？'))) return;
              commands.batch(clearPlan.actions, t('清空轨道'));
              onMarqueeCaptionSelect([], { additive: false, preserveWithItems: false });
            }}
            onToggleHidden={() => {
              if (kind === 'caption') toggleCaptions(trackId);
              else commands.toggleTrackFlag(trackId, 'hidden');
            }}
            onToggleMuted={() => commands.toggleTrackFlag(trackId, 'muted')}
            onToggleLocked={() => commands.toggleTrackFlag(trackId, 'locked')}
            onRename={() => {
              const current = state.tracks?.[trackId]?.name ?? '';
              const next = window.prompt(t('轨道名称（留空恢复默认）'), current) ?? null;
              if (next === null) return;
              commands.updateTrack(trackId, { name: next.trim() ? next.trim() : undefined });
            }}
            onOpenDuck={(rect) => openDuckTrackMenu(trackId, rect, trackMenu, true)}
            onOpenCaptionStyle={(rect) => openCaptionTrackMenu(trackId, rect, false, trackMenu, true)}
            onOpenTranslate={(rect) => openCaptionTrackMenu(trackId, rect, true, trackMenu, true)}
            onDelete={() => {
              if (deletePlan.blockedReason) return;
              if (deletePlan.requiresConfirmation
                && !window.confirm(t('删除轨道会同时删除其中的片段、字幕和转场，确认继续吗？'))) return;
              commands.batch(deletePlan.actions, t('删除轨道'));
              onMarqueeCaptionSelect([], { additive: false, preserveWithItems: false });
            }}
            onClose={() => setTrackMenu(null)}
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
            onExportMg={exportMg} onConvertToVideo={convertToVideo}
            onAddComment={(target, frame, clientX, clientY) => {
              playerRef.current?.seekTo(frame);
              onReviewItem?.({ itemId: target.id, frame, clientX, clientY });
            }}
            onAddToChat={(items) => addSelectionToChat({ items, captions: [] })}
            onRelinkFile={beginRelink} />
        );
      })()}

      {/* single-clip render status (export MG / convert to video take a few seconds)*/}
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
