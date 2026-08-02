import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { captionPages } from './exportCaptions';
import { captionTrackEntries, selectedIdsOf, timelineTrackIds, trackKind, type TimelineState, type TrackId } from '../editor/types';
import {
  collectTimelineSnapPoints, snapDraggedEdges, sortTimelineSnapPoints,
  type SnapDraggedEdgesOptions, type SnapPoint,
} from '../editor/snap';
import type { CaptionPage, CaptionsData } from './types';
import type { TranscriptWord } from '../transcript/types';
import { theme, themeAlpha } from '../theme';
import { useT } from '../i18n/locale';
import {
  isManualCaptionEntry,
  resizeManualCue,
  resizedManualCueTiming,
  type ManualCueEdge,
} from './manualCaptions';
import { findCaptionPreviewTarget } from './captionPreviewTarget';
import {
  captionSelectionKey,
  captionSelectionRef,
  resolveCaptionSelection,
  type CaptionSelectOptions,
  type CaptionSelectionRef,
} from './captionSelection';
import { captionContextMenuIntent, updateCaptionSelections } from './captionSelectionInteraction';
import {
  clampTimelineSelectionDelta,
  resolveCaptionDragSelection,
  type TimelineSelectionMovePreview,
} from './captionGroupMove';
import { CAPTION_CUE_TRANSLATION_LANGS, captionCueAgentSeed, captionCueText } from './captionCueMenu';
import {
  appendCaptionClipboardToTrack,
  createCaptionTimelineClipboard,
  type CaptionTimelineClipboard,
} from './captionTimelineClipboard';
import { translateLines } from './translate';
import { droppedFiles, hasExternalFiles } from '../media/externalFileDrop';

const SNAP_PX = 8;

function cueText(words: Array<{ text: string }>): string {
  return words.map((word) => word.text.trim()).filter(Boolean).join(' ');
}

interface ManualCueTarget {
  laneId: string;
  index: number;
  words: readonly TranscriptWord[];
}

export interface CaptionCueMove {
  selection: CaptionSelectionRef;
  text: string;
  startMs: number;
  endMs: number;
  targetTrackId: TrackId;
  itemIds: string[];
  captionSelections: CaptionSelectionRef[];
  deltaFrames: number;
}

interface CueDrag {
  key: string;
  target: ManualCueTarget;
  startX: number;
  baseStartMs: number;
  baseEndMs: number;
  deltaFrames: number;
  snapPoints: SnapPoint[];
}

interface TrimDrag extends CueDrag {
  edge: ManualCueEdge;
}

interface MoveDrag extends CueDrag {
  selection: CaptionSelectionRef;
  text: string;
  itemIds: string[];
  captionSelections: CaptionSelectionRef[];
  targetTrackId: TrackId;
}

function manualCueTargets(captions: CaptionsData | null): Map<TranscriptWord, ManualCueTarget> {
  const targets = new Map<TranscriptWord, ManualCueTarget>();
  captions?.sourceEntries?.forEach((entry) => {
    if (!isManualCaptionEntry(entry)) return;
    const words = entry.words ?? [];
    words.forEach((word, index) => targets.set(word, { laneId: entry.id, index, words }));
  });
  return targets;
}

function captionSnapPoints(state: TimelineState, sourceTrackId: TrackId): SnapPoint[] {
  const points = collectTimelineSnapPoints(state, {});
  for (const entry of captionTrackEntries(state)) {
    if (entry.id === sourceTrackId || !entry.captions) continue;
    for (const page of captionPages(entry.captions, state.items, state.fps)) {
      points.push({ frame: Math.round(page.start * state.fps / 1000), type: 'item-start' });
      points.push({ frame: Math.round(page.end * state.fps / 1000), type: 'item-end' });
    }
  }
  return sortTimelineSnapPoints(points);
}

function cueDeltaFrames(
  drag: CueDrag,
  clientX: number,
  mode: SnapDraggedEdgesOptions['mode'],
  state: TimelineState,
  playheadFrame: number,
  px: number,
  snapping: boolean,
): number {
  const rawDelta = Math.round((clientX - drag.startX) / px);
  const baseStart = Math.round(drag.baseStartMs * state.fps / 1000);
  if (!snapping) return Math.max(-baseStart, rawDelta);
  const baseDuration = Math.max(1, Math.round((drag.baseEndMs - drag.baseStartMs) * state.fps / 1000));
  const snapped = snapDraggedEdges({
    mode, baseStart, baseDuration, rawDelta,
    points: drag.snapPoints,
    thresholdFrames: SNAP_PX / px,
    dynamicPlayheadFrame: playheadFrame,
  });
  return Math.max(-baseStart, snapped.deltaF);
}

function useCaptionTrim(options: {
  state: TimelineState; captions: CaptionsData | null; trackId: TrackId; playheadFrame: number;
  px: number; snapping: boolean; locked: boolean; onUpdate: (patch: Partial<CaptionsData>) => void;
}) {
  const { state, captions, trackId, playheadFrame, px, snapping, locked, onUpdate } = options;
  const [drag, setDrag] = useState<TrimDrag | null>(null);
  const delta = (current: TrimDrag, clientX: number) => cueDeltaFrames(
    current, clientX, current.edge === 'start' ? 'trim-left' : 'trim-right', state, playheadFrame, px, snapping,
  );
  const start = (event: ReactPointerEvent, key: string, target: ManualCueTarget, edge: ManualCueEdge) => {
    const cue = target.words[target.index];
    if (!cue || locked || event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    setDrag({
      key, target, edge, startX: event.clientX, baseStartMs: cue.start, baseEndMs: cue.end,
      deltaFrames: 0, snapPoints: captionSnapPoints(state, trackId),
    });
  };
  const move = (event: ReactPointerEvent, key: string) => {
    if (!drag || drag.key !== key) return;
    const deltaFrames = delta(drag, event.clientX);
    setDrag((current) => current?.key === key ? { ...current, deltaFrames } : current);
  };
  const finish = (event: ReactPointerEvent, key: string) => {
    if (!drag || drag.key !== key || !captions) return;
    const deltaMs = delta(drag, event.clientX) * 1000 / state.fps;
    const patch = deltaMs ? resizeManualCue(captions, drag.target.laneId, drag.target.index, drag.edge, deltaMs) : null;
    setDrag(null);
    if (patch) onUpdate(patch);
  };
  const nudge = (target: ManualCueTarget, edge: ManualCueEdge, frames: number) => {
    if (!captions || locked) return;
    const patch = resizeManualCue(captions, target.laneId, target.index, edge, frames * 1000 / state.fps);
    if (patch) onUpdate(patch);
  };
  return { drag, start, move, finish, cancel: () => setDrag(null), nudge };
}

function useCaptionMove(options: {
  state: TimelineState; trackId: TrackId; playheadFrame: number; px: number; snapping: boolean; locked: boolean;
  trackFromClientY: (clientY: number) => TrackId; onMove: (move: CaptionCueMove) => void;
  onSelectionMovePreview: (preview: TimelineSelectionMovePreview | null) => void;
}) {
  const {
    state, trackId, playheadFrame, px, snapping, locked, trackFromClientY, onMove,
    onSelectionMovePreview,
  } = options;
  const [drag, setDrag] = useState<MoveDrag | null>(null);
  const dragRef = useRef<MoveDrag | null>(null);
  const updateDrag = (next: MoveDrag | null) => { dragRef.current = next; setDrag(next); };
  const delta = (current: MoveDrag, clientX: number) => clampTimelineSelectionDelta(
    state,
    current.itemIds,
    current.captionSelections,
    cueDeltaFrames(current, clientX, 'move', state, playheadFrame, px, snapping),
  );
  const start = (
    event: ReactPointerEvent,
    key: string,
    selection: CaptionSelectionRef,
    text: string,
    startMs: number,
    endMs: number,
    captionSelections: CaptionSelectionRef[],
    itemIds: string[],
  ) => {
    if (locked || event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    const next: MoveDrag = {
      key, target: { laneId: selection.kind === 'manual' ? selection.laneId : '', index: selection.cueIndex, words: [] },
      selection, text, startX: event.clientX, baseStartMs: startMs, baseEndMs: endMs,
      deltaFrames: 0, targetTrackId: trackId, snapPoints: captionSnapPoints(state, trackId),
      captionSelections, itemIds,
    };
    updateDrag(next);
    onSelectionMovePreview({ itemIds, captionSelections, deltaFrames: 0 });
  };
  const move = (event: ReactPointerEvent, key: string) => {
    const current = dragRef.current;
    if (!current || current.key !== key) return;
    const next = {
      ...current,
      deltaFrames: delta(current, event.clientX),
      targetTrackId: trackFromClientY(event.clientY),
    };
    updateDrag(next);
    onSelectionMovePreview({
      itemIds: next.itemIds,
      captionSelections: next.captionSelections,
      deltaFrames: next.deltaFrames,
    });
  };
  const finish = (event: ReactPointerEvent, key: string) => {
    const current = dragRef.current;
    if (!current || current.key !== key) return;
    const deltaFrames = delta(current, event.clientX);
    const deltaMs = deltaFrames * 1000 / state.fps;
    const targetTrackId = trackFromClientY(event.clientY);
    updateDrag(null);
    onSelectionMovePreview(null);
    if (!deltaMs && targetTrackId === trackId) return;
    onMove({
      selection: current.selection,
      text: current.text,
      startMs: Math.max(0, current.baseStartMs + deltaMs),
      endMs: current.baseEndMs + deltaMs,
      targetTrackId,
      itemIds: current.itemIds,
      captionSelections: current.captionSelections,
      deltaFrames,
    });
  };
  const cancel = () => {
    updateDrag(null);
    onSelectionMovePreview(null);
  };
  return { drag, start, move, finish, cancel };
}

function CaptionCueBlock({
  page, index, target, selectionRef, locked, selected, selectedCaptions, selectedItemIds,
  externalDeltaFrames, px, fps, moveOffsetY, trim, move, onSelect, onDelete, onMenu,
}: {
  page: CaptionPage; index: number; target?: ManualCueTarget; selectionRef: CaptionSelectionRef | null;
  locked: boolean; selected: boolean; px: number; fps: number;
  selectedCaptions: CaptionSelectionRef[]; selectedItemIds: string[]; externalDeltaFrames: number;
  moveOffsetY: number;
  trim: ReturnType<typeof useCaptionTrim>; move: ReturnType<typeof useCaptionMove>;
  onSelect: (selection: CaptionSelectionRef | null, options?: CaptionSelectOptions) => void;
  onDelete: (target: ManualCueTarget) => void;
  onMenu: (event: ReactMouseEvent, target: ManualCueTarget, selection: CaptionSelectionRef) => void;
}) {
  const t = useT();
  const key = target ? `${target.laneId}:${target.index}` : `${page.start}:${index}`;
  const groupDragging = !!move.drag && !!selectionRef
    && move.drag.captionSelections.some(
      (selection) => captionSelectionKey(selection) === captionSelectionKey(selectionRef),
    );
  const timing = target && trim.drag?.key === key
    ? resizedManualCueTiming(target.words, target.index, trim.drag.edge, trim.drag.deltaFrames * 1000 / fps)
    : null;
  const moveMs = (selected || groupDragging) ? externalDeltaFrames * 1000 / fps : 0;
  const startMs = timing?.start ?? page.start + moveMs;
  const endMs = timing?.end ?? page.end + moveMs;
  const startFrame = Math.max(0, Math.round(startMs * fps / 1000));
  const durationFrames = Math.max(2, Math.round((endMs - startMs) * fps / 1000));
  const text = cueText(page.words);
  const handle = (edge: ManualCueEdge) => target && !locked ? <div
    className={`cc-caption-track-trim ${edge === 'start' ? 'left' : 'right'}`}
    role="separator" aria-orientation="vertical" tabIndex={0}
    aria-label={t(edge === 'start' ? '拖动调整字幕开始时间' : '拖动调整字幕结束时间')}
    aria-valuenow={Math.round(edge === 'start' ? startMs : endMs)}
    title={t(edge === 'start' ? '拖动调整字幕开始时间' : '拖动调整字幕结束时间')}
    onPointerDown={(event) => trim.start(event, key, target, edge)}
    onPointerMove={(event) => trim.move(event, key)}
    onPointerUp={(event) => trim.finish(event, key)}
    onPointerCancel={trim.cancel}
    onKeyDown={(event) => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      event.preventDefault();
      trim.nudge(target, edge, event.key === 'ArrowLeft' ? -1 : 1);
    }}
  /> : null;
  return (
    <div className={`cc-caption-track-cue${selected ? ' selected' : ''}`} data-caption-selection-owner="timeline-cue"
      title={text} tabIndex={selectionRef && !locked ? 0 : undefined}
      style={{ left: startFrame * px, width: Math.max(18, durationFrames * px),
        transform: groupDragging && moveOffsetY ? `translate3d(0, ${moveOffsetY}px, 0)` : undefined,
        zIndex: groupDragging ? 10 : undefined }}
      onPointerDown={(event) => {
        if (!selectionRef || locked) return;
        const additive = event.metaKey || event.ctrlKey;
        if (additive) {
          onSelect(selectionRef, { additive: true, preserveWithItems: true, toggle: true });
          event.currentTarget.focus();
          return;
        }
        const dragSelection = resolveCaptionDragSelection(
          selectionRef,
          selected ? selectedCaptions : [selectionRef],
          selected ? selectedItemIds : [],
        );
        if (!selected) onSelect(selectionRef);
        event.currentTarget.focus();
        move.start(
          event, key, selectionRef, text, page.start, page.end,
          dragSelection.captionSelections, dragSelection.itemIds,
        );
      }}
      onPointerMove={(event) => move.move(event, key)}
      onPointerUp={(event) => move.finish(event, key)}
      onPointerCancel={move.cancel}
      onContextMenu={(event) => {
        if (!target || locked || !selectionRef) return;
        event.preventDefault();
        event.stopPropagation();
        if (captionContextMenuIntent(event.ctrlKey) === 'ignore-after-toggle') return;
        if (!selected) onSelect(selectionRef);
        onMenu(event, target, selectionRef);
      }}
      onKeyDown={(event) => {
        if (!target || (event.key !== 'Delete' && event.key !== 'Backspace')) return;
        event.preventDefault();
        onDelete(target);
      }}>
      {handle('start')}<span>{text}</span>{handle('end')}
    </div>
  );
}

export function CaptionTrackLane({
  state, captions, trackId, playheadFrame, px, rowHeight, hidden, locked, snapping, trackFromClientY,
  selectedCaptions: controlledSelectedCaptions, externalDeltaFrames = 0, onSelectCaption,
  onUpdate, onMove, onSelectionMovePreview, onDelete,
  onCopyCue, onPasteCue, onSeedChat, onTranslateCue,
  onDropExternalFiles, frameFromClientX,
}: {
  state: TimelineState; captions: CaptionsData | null; trackId: TrackId; playheadFrame: number; px: number;
  hidden: boolean; locked: boolean; snapping: boolean; rowHeight: number; trackFromClientY: (clientY: number) => TrackId;
  selectedCaptions?: CaptionSelectionRef[];
  externalDeltaFrames?: number;
  onSelectCaption?: (selection: CaptionSelectionRef | null, options?: CaptionSelectOptions) => void;
  onUpdate: (patch: Partial<CaptionsData>) => void; onMove: (move: CaptionCueMove) => void;
  onSelectionMovePreview?: (preview: TimelineSelectionMovePreview | null) => void;
  onDelete: (laneId: string, index: number) => void;
  onCopyCue?: (selection: CaptionSelectionRef) => void;
  onPasteCue?: () => boolean;
  onSeedChat?: (text: string) => void;
  onTranslateCue?: (text: string, start: number, end: number) => void;
  onDropExternalFiles?: (files: File[], trackId: TrackId, startFrame: number) => void;
  frameFromClientX?: (clientX: number) => number;
}) {
  const t = useT();
  const [localSelections, setLocalSelections] = useState<CaptionSelectionRef[]>([]);
  const selectedCaptions = controlledSelectedCaptions ?? localSelections;
  const selectCaption = (selection: CaptionSelectionRef | null, options?: CaptionSelectOptions) => {
    if (onSelectCaption) {
      onSelectCaption(selection, options);
      return;
    }
    if (!selection) {
      setLocalSelections([]);
      return;
    }
    if (!options?.additive) {
      setLocalSelections([selection]);
      return;
    }
    setLocalSelections((current) => updateCaptionSelections(current, selection, options.toggle ? 'toggle' : 'add'));
  };
  const [timelineClipboard, setTimelineClipboard] = useState<CaptionTimelineClipboard | null>(null);
  const [menu, setMenu] = useState<{
    x: number;
    y: number;
    target: ManualCueTarget;
    selection: CaptionSelectionRef;
  } | null>(null);
  const [translationOpen, setTranslationOpen] = useState(false);
  const [menuBusy, setMenuBusy] = useState(false);
  const [menuError, setMenuError] = useState<string | null>(null);
  const closeMenu = () => {
    setMenu(null);
    setTranslationOpen(false);
    setMenuBusy(false);
    setMenuError(null);
  };
  useEffect(() => {
    if (!menu) return;
    window.addEventListener('pointerdown', closeMenu);
    return () => window.removeEventListener('pointerdown', closeMenu);
  }, [menu]);
  const pages = captions ? captionPages(captions, state.items, state.fps) : [];
  const selectedItemIds = selectedIdsOf(state);
  const targets = manualCueTargets(captions);
  const trim = useCaptionTrim({ state, captions, trackId, playheadFrame, px, snapping, locked, onUpdate });
  const move = useCaptionMove({
    state, trackId, playheadFrame, px, snapping, locked, trackFromClientY, onMove,
    onSelectionMovePreview: onSelectionMovePreview ?? (() => {}),
  });
  const trackIds = timelineTrackIds(state);
  const moveOffsetY = move.drag
    && move.drag.captionSelections.length === 1
    && move.drag.itemIds.length === 0
    && trackKind(state, move.drag.targetTrackId) === 'caption'
    && !state.tracks?.[move.drag.targetTrackId]?.locked
    ? (trackIds.indexOf(move.drag.targetTrackId) - trackIds.indexOf(trackId)) * rowHeight
    : 0;
  const remove = (target: ManualCueTarget) => {
    selectCaption(null);
    closeMenu();
    onDelete(target.laneId, target.index);
  };
  const copyCue = async (selection: CaptionSelectionRef) => {
    const selectionIsActive = selectedCaptions.some(
      (candidate) => captionSelectionKey(candidate) === captionSelectionKey(selection),
    );
    const selections = selectionIsActive ? selectedCaptions : [selection];
    const cues = selections.flatMap((candidate) => {
      const resolved = resolveCaptionSelection(state, candidate)?.target.cue;
      return resolved ? [{ text: resolved.text, start: resolved.start, end: resolved.end }] : [];
    });
    const clipboard = createCaptionTimelineClipboard(cues);
    if (!clipboard) return;
    setTimelineClipboard(clipboard);
    onCopyCue?.(selection);
    try {
      await navigator.clipboard.writeText(clipboard.cues.map((cue) => cue.text).join('\n'));
    } catch {
      // The structured in-app clipboard remains available when OS permission is denied.
    }
    closeMenu();
  };
  const pasteCue = () => {
    if (onPasteCue?.()) {
      closeMenu();
      return;
    }
    if (!captions || !timelineClipboard) {
      setMenuError(t('剪贴板里没有可粘贴的文字'));
      return;
    }
    const patch = appendCaptionClipboardToTrack(
      captions,
      state.items,
      timelineClipboard,
      Math.round(playheadFrame * 1000 / state.fps),
    );
    if (!patch) {
      setMenuError(t('剪贴板里没有可粘贴的文字'));
      return;
    }
    onUpdate(patch);
    closeMenu();
  };
  const translateCue = async (target: ManualCueTarget, language: string) => {
    if (!onTranslateCue || menuBusy) return;
    const cue = target.words[target.index];
    if (!cue) return;
    setMenuBusy(true);
    setMenuError(null);
    try {
      const [translated] = await translateLines([captionCueText(target)], language);
      const text = translated?.trim();
      if (!text) throw new Error(t('字幕翻译没有返回文字'));
      onTranslateCue(text, cue.start, cue.end);
      closeMenu();
    } catch (cause) {
      setMenuBusy(false);
      setMenuError(cause instanceof Error ? cause.message : t('字幕翻译失败'));
    }
  };
  return (
    <div className="cc-caption-track-lane" data-caption-selection-region="timeline" style={{
      background: locked ? `color-mix(in srgb, ${theme.bg} 70%, ${themeAlpha.shadow(1)})` : theme.bg,
      opacity: hidden ? 0.4 : locked ? 0.75 : 1,
      overflow: move.drag ? 'visible' : undefined,
      zIndex: move.drag ? 20 : undefined,
    }}
      onDragOver={(event) => {
        if (!hasExternalFiles(event.dataTransfer) || locked) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'copy';
      }}
      onDrop={(event) => {
        const files = droppedFiles(event.dataTransfer);
        if (!files.length || locked || !onDropExternalFiles || !frameFromClientX) return;
        event.preventDefault();
        event.stopPropagation();
        onDropExternalFiles(files, trackId, frameFromClientX(event.clientX));
      }}>
      {!pages.length && <span className="cc-caption-track-empty">{t('字幕轨道为空')}</span>}
      {pages.map((page, index) => {
        const target = page.words.length === 1 ? targets.get(page.words[0]!) : undefined;
        const key = target ? `${target.laneId}:${target.index}` : `${page.start}:${index}`;
        const previewTarget = !target && captions
          ? findCaptionPreviewTarget(captions, state.items, state.fps, (page.start + page.end) / 2)
          : null;
        const selectionRef = target
          ? { trackId, kind: 'manual' as const, laneId: target.laneId, cueIndex: target.index }
          : previewTarget ? captionSelectionRef(trackId, previewTarget) : null;
        const selected = selectedCaptions.some(
          (selection) => captionSelectionKey(selection) === captionSelectionKey(selectionRef),
        );
        return <CaptionCueBlock key={key} page={page} index={index} target={target} selectionRef={selectionRef}
          locked={locked} selected={selected} px={px} fps={state.fps} moveOffsetY={moveOffsetY}
          selectedCaptions={selectedCaptions} selectedItemIds={selectedItemIds}
          externalDeltaFrames={externalDeltaFrames}
          trim={trim} move={move} onSelect={selectCaption} onDelete={remove}
          onMenu={(event, cue, selection) => {
            setTranslationOpen(false);
            setMenuError(null);
            setMenu({
              x: Math.max(8, Math.min(event.clientX, window.innerWidth - 180)),
              y: Math.max(8, Math.min(event.clientY, window.innerHeight - 300)),
              target: cue,
              selection,
            });
          }} />;
      })}
      {menu && <div className="cc-caption-cue-menu" data-caption-selection-owner="cue-menu" role="menu"
        style={{ left: menu.x, top: menu.y }} onPointerDown={(event) => event.stopPropagation()}>
        {translationOpen ? <>
          <button type="button" role="menuitem" onClick={() => setTranslationOpen(false)}>{t('翻译')}</button>
          {CAPTION_CUE_TRANSLATION_LANGS.map((language) => <button key={language.label} type="button" role="menuitem"
            disabled={menuBusy} onClick={() => void translateCue(menu.target, language.label)}>
            {language.flag} {language.label}
          </button>)}
        </> : <>
          <button type="button" role="menuitem" onClick={() => void copyCue(menu.selection)}>{t('复制')}</button>
          <button type="button" role="menuitem" onClick={pasteCue}>{t('粘贴')}</button>
          {onTranslateCue && <button type="button" role="menuitem" aria-haspopup="menu"
            onClick={() => setTranslationOpen(true)}>{t('翻译')} ›</button>}
          {onSeedChat && <button type="button" role="menuitem" onClick={() => {
            onSeedChat(captionCueAgentSeed(captionCueText(menu.target)));
            closeMenu();
          }}>{t('添加到 AI 对话框')}</button>}
          <button type="button" role="menuitem" onClick={() => remove(menu.target)}>{t('删除')}</button>
        </>}
        {menuBusy && <div role="status">{t('翻译中...')}</div>}
        {menuError && <div role="alert">{menuError}</div>}
      </div>}
    </div>
  );
}
