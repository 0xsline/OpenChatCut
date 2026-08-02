import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { captionPages } from './exportCaptions';
import { captionTrackEntries, timelineTrackIds, trackKind, type TimelineState, type TrackId } from '../editor/types';
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
import { CAPTION_CUE_TRANSLATION_LANGS, captionCueAgentSeed, captionCueText } from './captionCueMenu';
import {
  appendCaptionClipboardToTrack,
  createCaptionTimelineClipboard,
  type CaptionTimelineClipboard,
} from './captionTimelineClipboard';
import { translateLines } from './translate';

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
  laneId: string;
  index: number;
  text: string;
  startMs: number;
  endMs: number;
  targetTrackId: TrackId;
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
}) {
  const { state, trackId, playheadFrame, px, snapping, locked, trackFromClientY, onMove } = options;
  const [drag, setDrag] = useState<MoveDrag | null>(null);
  const dragRef = useRef<MoveDrag | null>(null);
  const updateDrag = (next: MoveDrag | null) => { dragRef.current = next; setDrag(next); };
  const start = (event: ReactPointerEvent, key: string, target: ManualCueTarget) => {
    const cue = target.words[target.index];
    if (!cue || locked || event.button !== 0) return;
    event.preventDefault();
    updateDrag({
      key, target, startX: event.clientX, baseStartMs: cue.start, baseEndMs: cue.end,
      deltaFrames: 0, targetTrackId: trackId, snapPoints: captionSnapPoints(state, trackId),
    });
  };
  useEffect(() => {
    if (!dragRef.current) return;
    const delta = (current: CueDrag, clientX: number) => cueDeltaFrames(
      current, clientX, 'move', state, playheadFrame, px, snapping,
    );
    const move = (event: PointerEvent) => {
      const current = dragRef.current;
      if (!current) return;
      updateDrag({ ...current, deltaFrames: delta(current, event.clientX), targetTrackId: trackFromClientY(event.clientY) });
    };
    const finish = (event: PointerEvent) => {
      const current = dragRef.current;
      if (!current) return;
      const deltaMs = delta(current, event.clientX) * 1000 / state.fps;
      const cue = current.target.words[current.target.index];
      const targetTrackId = trackFromClientY(event.clientY);
      updateDrag(null);
      if (!cue || (!deltaMs && targetTrackId === trackId)) return;
      onMove({ laneId: current.target.laneId, index: current.target.index, text: cue.text,
        startMs: Math.max(0, current.baseStartMs + deltaMs), endMs: current.baseEndMs + deltaMs, targetTrackId });
    };
    const cancel = () => updateDrag(null);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', finish, { once: true });
    window.addEventListener('pointercancel', cancel, { once: true });
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', cancel);
    };
  }, [drag?.key, state, trackId, playheadFrame, px, snapping, trackFromClientY, onMove]);
  return { drag, start, cancel: () => updateDrag(null) };
}

function CaptionCueBlock({ page, index, target, selectionRef, locked, selected, px, fps, moveOffsetY, trim, move, onSelect, onDelete, onMenu }: {
  page: CaptionPage; index: number; target?: ManualCueTarget; selectionRef: CaptionSelectionRef | null;
  locked: boolean; selected: boolean; px: number; fps: number;
  moveOffsetY: number;
  trim: ReturnType<typeof useCaptionTrim>; move: ReturnType<typeof useCaptionMove>;
  onSelect: (selection: CaptionSelectionRef | null, options?: CaptionSelectOptions) => void;
  onDelete: (target: ManualCueTarget) => void;
  onMenu: (event: ReactMouseEvent, target: ManualCueTarget, selection: CaptionSelectionRef) => void;
}) {
  const t = useT();
  const key = target ? `${target.laneId}:${target.index}` : `${page.start}:${index}`;
  const timing = target && trim.drag?.key === key
    ? resizedManualCueTiming(target.words, target.index, trim.drag.edge, trim.drag.deltaFrames * 1000 / fps)
    : null;
  const moveMs = move.drag?.key === key ? move.drag.deltaFrames * 1000 / fps : 0;
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
        transform: move.drag?.key === key && moveOffsetY ? `translate3d(0, ${moveOffsetY}px, 0)` : undefined,
        zIndex: move.drag?.key === key ? 10 : undefined }}
      onPointerDown={(event) => {
        if (!selectionRef || locked) return;
        const additive = event.metaKey || event.ctrlKey;
        onSelect(selectionRef, additive
          ? { additive: true, preserveWithItems: true, toggle: true }
          : undefined);
        event.currentTarget.focus();
        if (target && !additive) move.start(event, key, target);
      }}
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
  selectedCaptions: controlledSelectedCaptions, onSelectCaption, onUpdate, onMove, onDelete,
  onCopyCue, onPasteCue, onSeedChat, onTranslateCue,
}: {
  state: TimelineState; captions: CaptionsData | null; trackId: TrackId; playheadFrame: number; px: number;
  hidden: boolean; locked: boolean; snapping: boolean; rowHeight: number; trackFromClientY: (clientY: number) => TrackId;
  selectedCaptions?: CaptionSelectionRef[];
  onSelectCaption?: (selection: CaptionSelectionRef | null, options?: CaptionSelectOptions) => void;
  onUpdate: (patch: Partial<CaptionsData>) => void; onMove: (move: CaptionCueMove) => void;
  onDelete: (laneId: string, index: number) => void;
  onCopyCue?: (selection: CaptionSelectionRef) => void;
  onPasteCue?: () => boolean;
  onSeedChat?: (text: string) => void;
  onTranslateCue?: (text: string, start: number, end: number) => void;
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
  const targets = manualCueTargets(captions);
  const trim = useCaptionTrim({ state, captions, trackId, playheadFrame, px, snapping, locked, onUpdate });
  const move = useCaptionMove({ state, trackId, playheadFrame, px, snapping, locked, trackFromClientY, onMove });
  const trackIds = timelineTrackIds(state);
  const moveOffsetY = move.drag
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
