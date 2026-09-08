import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { captionPages } from './exportCaptions';
import { captionTrackEntries, type TimelineState, type TrackId } from '../editor/types';
import { collectTimelineSnapPoints, snapDraggedEdges, sortTimelineSnapPoints, type SnapDraggedEdgesOptions, type SnapPoint } from '../editor/snap';
import type { CaptionPage, CaptionsData } from './types';
import type { TranscriptWord } from '../transcript/types';
import { isManualCaptionEntry, resizeManualCue, type ManualCueEdge } from './manualCaptions';
import type { CaptionSelectionRef } from './captionSelection';
import { captionDragMoveMode, clampTimelineSelectionDelta, resolveCaptionDragSelection, type TimelineSelectionMovePreview } from './captionGroupMove';

const SNAP_PX = 8;

export interface ManualCueTarget {
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

interface CueTimingDrag {
  key: string;
  startX: number;
  baseStartMs: number;
  baseEndMs: number;
  deltaFrames: number;
  snapPoints: SnapPoint[];
}

interface CueDrag extends CueTimingDrag {
  target: ManualCueTarget;
}

interface TrimDrag extends CueDrag {
  edge: ManualCueEdge;
}

interface MoveDrag extends CueDrag {
  selection: CaptionSelectionRef;
  targetTrackId: TrackId;
}

interface SelectionMoveDrag extends CueTimingDrag {
  itemIds: string[];
  captionSelections: CaptionSelectionRef[];
}

export function manualCueTargets(captions: CaptionsData | null): Map<string, ManualCueTarget> {
  const targets = new Map<string, ManualCueTarget>();
  captions?.sourceEntries?.forEach((entry) => {
    if (!isManualCaptionEntry(entry)) return;
    const words = entry.words ?? [];
    words.forEach((word, index) => { if (word.id) targets.set(word.id, { laneId: entry.id, index, words }); });
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
  drag: CueTimingDrag,
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

export function useCaptionTrim(options: {
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

export function useCaptionMove(options: {
  state: TimelineState; trackId: TrackId; playheadFrame: number; px: number; snapping: boolean; locked: boolean;
  trackFromClientY: (clientY: number) => TrackId; onMove: (move: CaptionCueMove) => void;
  isOverChatComposer?: (clientX: number, clientY: number) => boolean;
  onDropSelectionToChat?: (selection: { itemIds: string[]; captionSelections: CaptionSelectionRef[] }) => void;
}) {
  const {
    state, trackId, playheadFrame, px, snapping, locked, trackFromClientY, onMove,
    isOverChatComposer, onDropSelectionToChat,
  } = options;
  const [drag, setDrag] = useState<MoveDrag | null>(null);
  const dragRef = useRef<MoveDrag | null>(null);
  const updateDrag = (next: MoveDrag | null) => { dragRef.current = next; setDrag(next); };
  const start = (
    event: ReactPointerEvent,
    key: string,
    target: ManualCueTarget,
    selection: CaptionSelectionRef,
  ) => {
    const cue = target.words[target.index];
    if (!cue || locked || event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    updateDrag({
      key, target, selection, startX: event.clientX, baseStartMs: cue.start, baseEndMs: cue.end,
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
      updateDrag({
        ...current,
        deltaFrames: delta(current, event.clientX),
        targetTrackId: trackFromClientY(event.clientY),
      });
    };
    const finish = (event: PointerEvent) => {
      const current = dragRef.current;
      if (!current) return;
      if (onDropSelectionToChat && isOverChatComposer?.(event.clientX, event.clientY)) {
        updateDrag(null);
        onDropSelectionToChat({ itemIds: [], captionSelections: [current.selection] });
        return;
      }
      const deltaMs = delta(current, event.clientX) * 1000 / state.fps;
      const cue = current.target.words[current.target.index];
      const targetTrackId = trackFromClientY(event.clientY);
      updateDrag(null);
      if (!cue || (!deltaMs && targetTrackId === trackId)) return;
      onMove({
        laneId: current.target.laneId,
        index: current.target.index,
        text: cue.text,
        startMs: Math.max(0, current.baseStartMs + deltaMs),
        endMs: current.baseEndMs + deltaMs,
        targetTrackId,
      });
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
  }, [
    drag?.key, state, trackId, playheadFrame, px, snapping, trackFromClientY, onMove,
    isOverChatComposer, onDropSelectionToChat,
  ]);
  return { drag, start, cancel: () => updateDrag(null) };
}

export function useCaptionSelectionMove(options: {
  state: TimelineState;
  trackId: TrackId;
  playheadFrame: number;
  px: number;
  snapping: boolean;
  locked: boolean;
  selectedCaptions: readonly CaptionSelectionRef[];
  selectedItemIds: readonly string[];
  onPreview: (preview: TimelineSelectionMovePreview | null) => void;
  onCommit: (
    itemIds: readonly string[],
    captionSelections: readonly CaptionSelectionRef[],
    deltaFrames: number,
  ) => void;
  isOverChatComposer?: (clientX: number, clientY: number) => boolean;
  onDropSelectionToChat?: (selection: { itemIds: string[]; captionSelections: CaptionSelectionRef[] }) => void;
}) {
  const {
    state, trackId, playheadFrame, px, snapping, locked, selectedCaptions, selectedItemIds,
    onPreview, onCommit, isOverChatComposer, onDropSelectionToChat,
  } = options;
  const [drag, setDrag] = useState<SelectionMoveDrag | null>(null);
  const dragRef = useRef<SelectionMoveDrag | null>(null);
  const updateDrag = useCallback((next: SelectionMoveDrag | null) => {
    dragRef.current = next;
    setDrag(next);
  }, []);
  const preview = useCallback((next: SelectionMoveDrag) => {
    onPreview({
      itemIds: next.itemIds,
      captionSelections: next.captionSelections,
      deltaFrames: next.deltaFrames,
    });
  }, [onPreview]);
  const delta = useCallback((current: SelectionMoveDrag, clientX: number) => {
    const requested = cueDeltaFrames(
      current, clientX, 'move', state, playheadFrame, px, snapping,
    );
    return clampTimelineSelectionDelta(
      state,
      current.itemIds,
      current.captionSelections,
      requested,
    );
  }, [state, playheadFrame, px, snapping]);
  const start = (
    event: ReactPointerEvent,
    key: string,
    page: CaptionPage,
    selection: CaptionSelectionRef,
  ): boolean => {
    if (locked || event.button !== 0) return false;
    const resolved = resolveCaptionDragSelection(
      selection,
      selectedCaptions,
      selectedItemIds,
    );
    const usesTimelineSelectionMove = captionDragMoveMode(selection, resolved) === 'timeline-selection';
    if (!usesTimelineSelectionMove) return false;
    event.preventDefault();
    event.stopPropagation();
    const next: SelectionMoveDrag = {
      key,
      startX: event.clientX,
      baseStartMs: page.start,
      baseEndMs: page.end,
      deltaFrames: 0,
      snapPoints: captionSnapPoints(state, trackId),
      itemIds: resolved.itemIds,
      captionSelections: resolved.captionSelections,
    };
    updateDrag(next);
    preview(next);
    return true;
  };
  const cancel = useCallback(() => {
    if (!dragRef.current) return;
    updateDrag(null);
    onPreview(null);
  }, [onPreview, updateDrag]);
  useEffect(() => {
    if (!dragRef.current) return;
    const move = (event: PointerEvent) => {
      const current = dragRef.current;
      if (!current) return;
      const next = { ...current, deltaFrames: delta(current, event.clientX) };
      updateDrag(next);
      preview(next);
    };
    const finish = (event: PointerEvent) => {
      const current = dragRef.current;
      if (!current) return;
      if (onDropSelectionToChat && isOverChatComposer?.(event.clientX, event.clientY)) {
        updateDrag(null);
        onPreview(null);
        onDropSelectionToChat({
          itemIds: current.itemIds,
          captionSelections: current.captionSelections,
        });
        return;
      }
      const deltaFrames = delta(current, event.clientX);
      updateDrag(null);
      onPreview(null);
      if (deltaFrames) onCommit(current.itemIds, current.captionSelections, deltaFrames);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', finish, { once: true });
    window.addEventListener('pointercancel', cancel, { once: true });
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', cancel);
    };
  }, [
    drag?.key, delta, updateDrag, preview, cancel, onPreview, onCommit,
    isOverChatComposer, onDropSelectionToChat,
  ]);
  useEffect(() => () => {
    if (dragRef.current) onPreview(null);
  }, [onPreview]);
  return { drag, start, cancel };
}
